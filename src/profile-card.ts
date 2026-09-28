import { smallAvatarUrl } from "./avatar-url.ts";
import { hashColor } from "./chat/text.ts";
import { PLATFORM_LABELS, PLATFORM_PATHS } from "./platform-icons.ts";
import { normalizePanels, type ProfilePanel } from "./live/about/panels.ts";

export type { ProfilePanel } from "./live/about/panels.ts";

export interface ProfileLink {
    label: string;
    url: string;
    platform: string;
    icon: string;
    iconLabel: string;
}

export interface Profile {
    username: string;
    bio: string;
    links: ProfileLink[];
    followers: number;
    hasAvatar: boolean;
    hasBanner: boolean;
    avatarVersion: number;
    bannerVersion: number;
    panels: ProfilePanel[];
    badges: string[];
    streamer: boolean;
    createdAt: number | null;
    followingSince: number | null;
}

function isHttpsUrl(url: string): boolean {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}

function parseLinks(raw: unknown): ProfileLink[] {
    if (!Array.isArray(raw)) return [];
    const out: ProfileLink[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const label = typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label : "";
        const url = typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url : "";
        const platform = typeof (item as { platform?: unknown }).platform === "string" ? (item as { platform: string }).platform : "";
        const icon = typeof (item as { icon?: unknown }).icon === "string" ? (item as { icon: string }).icon : "";
        const iconLabel = typeof (item as { iconLabel?: unknown }).iconLabel === "string" ? (item as { iconLabel: string }).iconLabel : "";
        if (!label || !url) continue;
        out.push({ label, url, platform, icon, iconLabel });
    }
    return out;
}

export interface ProfileFetch {
    profile: Profile | null;
    status: number;
    retryAfter: string | null;
}

export const PROFILE_RETRY_LIMIT = 4;
const PROFILE_RETRY_BASE_MS = 2000;
const PROFILE_RETRY_MAX_MS = 60000;

export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return null;
    return Math.max(0, at - now);
}

export function profileRetryDelay(
    attempt: number,
    result: ProfileFetch,
    random: () => number = Math.random,
    now: number = Date.now(),
): number | null {
    if (result.profile || attempt >= PROFILE_RETRY_LIMIT) return null;
    const status = result.status;
    if (status !== 0 && status !== 408 && status !== 429 && status < 500) return null;
    const backoff = PROFILE_RETRY_BASE_MS * 2 ** attempt;
    const hinted = status === 429 || status === 503 ? retryAfterMs(result.retryAfter, now) : null;
    const base = Math.min(PROFILE_RETRY_MAX_MS, Math.max(backoff, hinted ?? 0));
    return Math.round(base * (1 + random() * 0.25));
}

export async function fetchProfile(username: string, channel?: string): Promise<ProfileFetch> {
    if (!username) return { profile: null, status: 404, retryAfter: null };
    let status = 0;
    try {
        const query = channel ? `?channel=${encodeURIComponent(channel)}` : "";
        const res = await fetch(`/api/live/profile/${encodeURIComponent(username)}${query}`);
        status = res.status;
        if (!res.ok) return { profile: null, status, retryAfter: res.headers?.get("Retry-After") ?? null };
        const data = await res.json() as Record<string, unknown> | null;
        return { profile: parseProfile(data), status, retryAfter: null };
    } catch {
        return { profile: null, status, retryAfter: null };
    }
}

export async function loadProfile(username: string, channel?: string): Promise<Profile | null> {
    return (await fetchProfile(username, channel)).profile;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function loadProfileWithRetry(
    username: string,
    stillWanted: () => boolean,
    apply: (profile: Profile | null) => void,
    wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        const result = await fetchProfile(username);
        if (!stillWanted()) return;
        if (result.profile || attempt === 0) apply(result.profile);
        const delay = profileRetryDelay(attempt, result);
        if (delay === null) return;
        await wait(delay);
        if (!stillWanted()) return;
    }
}

function parseProfile(data: Record<string, unknown> | null): Profile | null {
    if (!data || typeof data.username !== "string" || !data.username) return null;
    return {
        username: data.username,
        bio: typeof data.bio === "string" ? data.bio : "",
        links: parseLinks(data.links),
        followers: typeof data.followers === "number" ? data.followers : 0,
        hasAvatar: data.hasAvatar === true,
        hasBanner: data.hasBanner === true,
        avatarVersion: typeof data.avatarVersion === "number" ? data.avatarVersion : 0,
        bannerVersion: typeof data.bannerVersion === "number" ? data.bannerVersion : 0,
        panels: normalizePanels(data.panels),
        badges: Array.isArray(data.badges) ? data.badges.filter((b): b is string => typeof b === "string") : [],
        streamer: data.streamer === true,
        createdAt: typeof data.createdAt === "number" ? data.createdAt : null,
        followingSince: typeof data.followingSince === "number" && Number.isFinite(data.followingSince)
            ? data.followingSince : null,
    };
}

function avatarUrl(profile: Profile): string {
    return smallAvatarUrl(profile.username, profile.avatarVersion);
}

export function offlineArtUrl(profile: Profile): string | null {
    if (!profile.hasBanner) return null;
    return `/api/live/profile/${encodeURIComponent(profile.username)}/banner?v=${profile.bannerVersion}`;
}

export function buildAvatarFallback(username: string): HTMLElement {
    const fallback = document.createElement("div");
    fallback.className = "profile-card-avatar-fallback";
    fallback.style.backgroundColor = hashColor(username);
    fallback.textContent = username.slice(0, 1).toUpperCase();
    return fallback;
}

export function buildAvatar(profile: Profile, eager = false): HTMLElement {
    if (profile.hasAvatar) {
        const img = document.createElement("img");
        img.className = "profile-card-avatar";
        img.alt = profile.username;
        img.loading = eager ? "eager" : "lazy";
        img.addEventListener("error", () => img.replaceWith(buildAvatarFallback(profile.username)), { once: true });
        img.src = avatarUrl(profile);
        return img;
    }
    return buildAvatarFallback(profile.username);
}

export function buildChannelAvatar(profile: Profile | null, username: string): HTMLElement | null {
    if (profile) return buildAvatar(profile, true);
    return username ? buildAvatarFallback(username) : null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function buildLinkGlyph(d: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "profile-card-link-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
}

function linkMonogramLetter(url: string): string {
    let host = "";
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return "?";
    }
    if (host.startsWith("www.")) host = host.slice(4);
    return (host.replace(/[^a-z0-9]/g, "").charAt(0) || "?").toUpperCase();
}

function buildLinkMonogram(url: string): HTMLElement {
    const mark = document.createElement("span");
    mark.className = "profile-card-link-monogram";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = linkMonogramLetter(url);
    return mark;
}

export function followerLabel(count: number): string {
    return `${count.toLocaleString()} follower${count === 1 ? "" : "s"}`;
}

export function buildProfileLinks(links: ProfileLink[]): HTMLElement | null {
    const safeLinks = links.filter(link => isHttpsUrl(link.url));
    if (!safeLinks.length) return null;
    const wrap = document.createElement("div");
    wrap.className = "profile-card-links";
    for (const link of safeLinks) {
        const a = document.createElement("a");
        a.className = "profile-card-link";
        a.href = link.url;
        const platformPath = PLATFORM_PATHS[link.platform];
        if (platformPath) {
            a.appendChild(buildLinkGlyph(platformPath));
            a.title = PLATFORM_LABELS[link.platform] ?? link.platform;
        } else if (link.icon) {
            a.appendChild(buildLinkGlyph(link.icon));
            if (link.iconLabel) a.title = link.iconLabel;
        } else {
            a.appendChild(buildLinkMonogram(link.url));
        }
        const text = document.createElement("span");
        text.textContent = link.label;
        a.appendChild(text);
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow ugc";
        a.referrerPolicy = "no-referrer";
        wrap.appendChild(a);
    }
    return wrap;
}
