import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Profile, ProfileFetch } from "../src/profile-card.ts";

class StubElement {
    tagName: string;
    className = "";
    textContent = "";
    src = "";
    alt = "";
    loading = "";
    style: Record<string, string> = {};

    constructor(tagName: string) {
        this.tagName = tagName;
    }

    addEventListener(): void {}
}

const stubDocument = {
    createElement(tagName: string): StubElement {
        return new StubElement(tagName);
    },
};

interface StubResponse {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json: () => Promise<unknown>;
}

function response(status: number, body: unknown = null, retryAfter: string | null = null): StubResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? retryAfter : null },
        json: async () => body,
    };
}

const globals = globalThis as unknown as Record<string, unknown>;
let previousDocument: unknown;
let previousFetch: unknown;
let queue: (StubResponse | Error)[] = [];
let fetchCount = 0;

beforeEach(() => {
    previousDocument = globals["document"];
    previousFetch = globals["fetch"];
    globals["document"] = stubDocument;
    queue = [];
    fetchCount = 0;
    globals["fetch"] = async () => {
        fetchCount++;
        const next = queue.shift();
        if (!next) throw new Error("no response queued");
        if (next instanceof Error) throw next;
        return next;
    };
});

afterEach(() => {
    globals["document"] = previousDocument;
    globals["fetch"] = previousFetch;
});

const {
    buildChannelAvatar,
    fetchProfile,
    loadProfileWithRetry,
    profileRetryDelay,
    PROFILE_RETRY_LIMIT,
    retryAfterMs,
} = await import("../src/profile-card.ts");

const profileBody = { username: "miruku", hasAvatar: true, avatarVersion: 2 };

function failed(status: number, retryAfter: string | null = null): ProfileFetch {
    return { profile: null, status, retryAfter };
}

function sampleProfile(): Profile {
    return {
        username: "miruku",
        bio: "",
        links: [],
        followers: 0,
        hasAvatar: false,
        hasBanner: false,
        avatarVersion: 0,
        bannerVersion: 0,
        panels: [],
        badges: [],
        streamer: true,
        createdAt: null,
        followingSince: null,
    };
}

const noJitter = () => 0;

describe("buildChannelAvatar", () => {
    test("renders the letter fallback from the username when the profile is missing", () => {
        const el = buildChannelAvatar(null, "Miruku") as unknown as StubElement;
        expect(el.className).toBe("profile-card-avatar-fallback");
        expect(el.textContent).toBe("M");
    });

    test("renders nothing without a profile or a username", () => {
        expect(buildChannelAvatar(null, "")).toBeNull();
    });

    test("renders the eager avatar image when the profile has one", () => {
        const el = buildChannelAvatar({ ...sampleProfile(), hasAvatar: true }, "miruku") as unknown as StubElement;
        expect(el.tagName).toBe("img");
        expect(el.loading).toBe("eager");
    });
});

describe("retryAfterMs", () => {
    test("reads delta seconds", () => {
        expect(retryAfterMs("12")).toBe(12000);
    });

    test("reads an http date relative to now", () => {
        const now = Date.UTC(2026, 8, 28, 12, 0, 0);
        expect(retryAfterMs("Mon, 28 Sep 2026 12:00:30 GMT", now)).toBe(30000);
    });

    test("ignores missing or garbage values", () => {
        expect(retryAfterMs(null)).toBeNull();
        expect(retryAfterMs("soon")).toBeNull();
    });
});

describe("profileRetryDelay", () => {
    test("never retries a loaded profile", () => {
        expect(profileRetryDelay(0, { profile: sampleProfile(), status: 200, retryAfter: null }, noJitter)).toBeNull();
    });

    test("does not retry a missing channel or a bad request", () => {
        expect(profileRetryDelay(0, failed(404), noJitter)).toBeNull();
        expect(profileRetryDelay(0, failed(400), noJitter)).toBeNull();
        expect(profileRetryDelay(0, failed(200), noJitter)).toBeNull();
    });

    test("retries network errors, timeouts, rate limits and server errors", () => {
        expect(profileRetryDelay(0, failed(0), noJitter)).toBe(2000);
        expect(profileRetryDelay(0, failed(408), noJitter)).toBe(2000);
        expect(profileRetryDelay(0, failed(429), noJitter)).toBe(2000);
        expect(profileRetryDelay(0, failed(502), noJitter)).toBe(2000);
    });

    test("backs off exponentially", () => {
        expect(profileRetryDelay(1, failed(500), noJitter)).toBe(4000);
        expect(profileRetryDelay(2, failed(500), noJitter)).toBe(8000);
        expect(profileRetryDelay(3, failed(500), noJitter)).toBe(16000);
    });

    test("stops after the retry limit", () => {
        expect(profileRetryDelay(PROFILE_RETRY_LIMIT, failed(500), noJitter)).toBeNull();
    });

    test("waits at least as long as Retry-After on a rate limit", () => {
        expect(profileRetryDelay(0, failed(429, "20"), noJitter)).toBe(20000);
    });

    test("keeps the backoff when Retry-After is shorter", () => {
        expect(profileRetryDelay(2, failed(429, "1"), noJitter)).toBe(8000);
    });

    test("caps a very long Retry-After", () => {
        expect(profileRetryDelay(0, failed(429, "3600"), noJitter)).toBe(60000);
    });

    test("adds up to a quarter of jitter", () => {
        expect(profileRetryDelay(0, failed(500), () => 1)).toBe(2500);
    });
});

describe("fetchProfile", () => {
    test("reports the status and Retry-After of a failed request", async () => {
        queue.push(response(429, null, "7"));
        const result = await fetchProfile("miruku");
        expect(result).toEqual({ profile: null, status: 429, retryAfter: "7" });
    });

    test("reports status 0 for a network error", async () => {
        queue.push(new Error("offline"));
        expect(await fetchProfile("miruku")).toEqual({ profile: null, status: 0, retryAfter: null });
    });

    test("parses a loaded profile", async () => {
        queue.push(response(200, profileBody));
        const result = await fetchProfile("miruku");
        expect(result.status).toBe(200);
        expect(result.profile?.username).toBe("miruku");
    });

    test("treats a null body as no profile", async () => {
        queue.push(response(200, null));
        expect((await fetchProfile("miruku")).profile).toBeNull();
    });
});

describe("loadProfileWithRetry", () => {
    test("applies the fallback first and remounts once the retry succeeds", async () => {
        queue.push(response(429, null, "1"), response(200, profileBody));
        const applied: (string | null)[] = [];
        const waits: number[] = [];
        await loadProfileWithRetry("miruku", () => true, p => applied.push(p?.username ?? null), async ms => {
            waits.push(ms);
        });
        expect(applied).toEqual([null, "miruku"]);
        expect(waits.length).toBe(1);
        expect(waits[0]).toBeGreaterThanOrEqual(2000);
        expect(fetchCount).toBe(2);
    });

    test("applies a first-try profile once and never retries", async () => {
        queue.push(response(200, profileBody));
        const applied: (string | null)[] = [];
        await loadProfileWithRetry("miruku", () => true, p => applied.push(p?.username ?? null), async () => {});
        expect(applied).toEqual(["miruku"]);
        expect(fetchCount).toBe(1);
    });

    test("does not retry a missing channel", async () => {
        queue.push(response(404));
        const applied: (string | null)[] = [];
        await loadProfileWithRetry("miruku", () => true, p => applied.push(p?.username ?? null), async () => {});
        expect(applied).toEqual([null]);
        expect(fetchCount).toBe(1);
    });

    test("gives up after the retry limit without remounting", async () => {
        for (let i = 0; i <= PROFILE_RETRY_LIMIT; i++) queue.push(response(503));
        const applied: (string | null)[] = [];
        await loadProfileWithRetry("miruku", () => true, p => applied.push(p?.username ?? null), async () => {});
        expect(applied).toEqual([null]);
        expect(fetchCount).toBe(PROFILE_RETRY_LIMIT + 1);
    });

    test("stops when the page moves on during the wait", async () => {
        queue.push(response(500), response(200, profileBody));
        let current = true;
        const applied: (string | null)[] = [];
        await loadProfileWithRetry("miruku", () => current, p => applied.push(p?.username ?? null), async () => {
            current = false;
        });
        expect(applied).toEqual([null]);
        expect(fetchCount).toBe(1);
    });

    test("drops a response that arrives after the page moved on", async () => {
        queue.push(response(200, profileBody));
        const applied: (string | null)[] = [];
        await loadProfileWithRetry("miruku", () => false, p => applied.push(p?.username ?? null), async () => {});
        expect(applied).toEqual([]);
    });
});
