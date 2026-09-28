import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Profile } from "../src/profile-card.ts";

type Listener = () => void;

class StubElement {
    tagName: string;
    className = "";
    textContent = "";
    src = "";
    alt = "";
    loading = "";
    style: Record<string, string> = {};
    parent: StubElement | null = null;
    children: StubElement[] = [];
    listeners = new Map<string, { fn: Listener; once: boolean }[]>();

    constructor(tagName: string) {
        this.tagName = tagName;
    }

    appendChild(child: StubElement): StubElement {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    replaceWith(next: StubElement): void {
        const parent = this.parent;
        if (!parent) return;
        const index = parent.children.indexOf(this);
        parent.children[index] = next;
        next.parent = parent;
        this.parent = null;
    }

    addEventListener(type: string, fn: Listener, options?: { once?: boolean }): void {
        const list = this.listeners.get(type) ?? [];
        list.push({ fn, once: options?.once === true });
        this.listeners.set(type, list);
    }

    dispatch(type: string): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, list.filter(entry => !entry.once));
        for (const entry of list) entry.fn();
    }
}

const stubDocument = {
    createElement(tagName: string): StubElement {
        return new StubElement(tagName);
    },
};

const globals = globalThis as unknown as Record<string, unknown>;
let previousDocument: unknown;

beforeEach(() => {
    previousDocument = globals["document"];
    globals["document"] = stubDocument;
});

afterEach(() => {
    globals["document"] = previousDocument;
});

const { buildAvatar, buildAvatarFallback } = await import("../src/profile-card.ts");
const { hashColor } = await import("../src/chat/text.ts");

function profile(overrides: Partial<Profile> = {}): Profile {
    return {
        username: "miruku",
        bio: "",
        links: [],
        followers: 0,
        hasAvatar: true,
        hasBanner: false,
        avatarVersion: 3,
        bannerVersion: 0,
        panels: [],
        badges: [],
        streamer: true,
        createdAt: null,
        followingSince: null,
        ...overrides,
    };
}

function mounted(el: HTMLElement): StubElement {
    const wrap = new StubElement("div");
    wrap.appendChild(el as unknown as StubElement);
    return wrap;
}

describe("buildAvatar", () => {
    test("renders the versioned avatar image when the profile has one", () => {
        const img = buildAvatar(profile()) as unknown as StubElement;
        expect(img.tagName).toBe("img");
        expect(img.className).toBe("profile-card-avatar");
        expect(img.src).toBe("/api/live/profile/miruku/avatar?v=3&s=128");
        expect(img.loading).toBe("lazy");
    });

    test("loads eagerly when asked", () => {
        const img = buildAvatar(profile(), true) as unknown as StubElement;
        expect(img.loading).toBe("eager");
    });

    test("swaps a failed avatar image for the letter fallback", () => {
        const img = buildAvatar(profile());
        const wrap = mounted(img);
        (img as unknown as StubElement).dispatch("error");
        expect(wrap.children.length).toBe(1);
        const fallback = wrap.children[0]!;
        expect(fallback.tagName).toBe("div");
        expect(fallback.className).toBe("profile-card-avatar-fallback");
        expect(fallback.textContent).toBe("M");
        expect(fallback.style["backgroundColor"]).toBe(hashColor("miruku"));
    });

    test("swaps only once even if the error fires again", () => {
        const img = buildAvatar(profile());
        const wrap = mounted(img);
        const stub = img as unknown as StubElement;
        stub.dispatch("error");
        const fallback = wrap.children[0];
        stub.dispatch("error");
        expect(wrap.children.length).toBe(1);
        expect(wrap.children[0]).toBe(fallback);
    });

    test("builds the letter fallback directly without an avatar", () => {
        const el = buildAvatar(profile({ hasAvatar: false, username: "bob" })) as unknown as StubElement;
        expect(el.className).toBe("profile-card-avatar-fallback");
        expect(el.textContent).toBe("B");
    });
});

describe("buildAvatarFallback", () => {
    test("uses the uppercased first letter and the hashed colour", () => {
        const el = buildAvatarFallback("zed") as unknown as StubElement;
        expect(el.textContent).toBe("Z");
        expect(el.style["backgroundColor"]).toBe(hashColor("zed"));
    });
});
