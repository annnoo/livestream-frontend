import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SMALL_AVATAR_SIZE, smallAvatarUrl } from "../src/avatar-url.ts";
import { railAvatarUrl, syncRailAvatar } from "../src/channel-rail.ts";

class StubImg {
    tagName = "img";
    className = "";
    alt = "";
    loading = "";
    src = "";
    dataset: Record<string, string> = {};
    onerror: (() => void) | null = null;
    parent: StubSpan | null = null;

    remove(): void {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }
}

class StubSpan {
    dataset: Record<string, string> = {};
    children: StubImg[] = [];

    querySelector(selector: string): StubImg | null {
        return selector === "img" ? this.children[0] ?? null : null;
    }

    appendChild(child: StubImg): StubImg {
        child.parent = this;
        this.children.push(child);
        return child;
    }
}

const globals = globalThis as unknown as Record<string, unknown>;
let previousDocument: unknown;
let created = 0;

beforeEach(() => {
    previousDocument = globals["document"];
    created = 0;
    globals["document"] = {
        createElement(): StubImg {
            created++;
            return new StubImg();
        },
    };
});

afterEach(() => {
    globals["document"] = previousDocument;
});

function sync(span: StubSpan, url: string | null, known: boolean): void {
    syncRailAvatar(span as unknown as HTMLElement, url, known);
}

describe("smallAvatarUrl", () => {
    test("asks for the small size on the versioned url", () => {
        expect(SMALL_AVATAR_SIZE).toBe(128);
        expect(smallAvatarUrl("miruku", 1727000000000)).toBe("/api/live/profile/miruku/avatar?v=1727000000000&s=128");
    });

    test("drops the version when it is unknown or zero", () => {
        expect(smallAvatarUrl("miruku")).toBe("/api/live/profile/miruku/avatar?s=128");
        expect(smallAvatarUrl("miruku", 0)).toBe("/api/live/profile/miruku/avatar?s=128");
        expect(smallAvatarUrl("miruku", null)).toBe("/api/live/profile/miruku/avatar?s=128");
        expect(smallAvatarUrl("miruku", Number.NaN)).toBe("/api/live/profile/miruku/avatar?s=128");
    });

    test("encodes the username", () => {
        expect(smallAvatarUrl("a b", 5)).toBe("/api/live/profile/a%20b/avatar?v=5&s=128");
    });
});

describe("railAvatarUrl", () => {
    test("uses the explore version for a live channel", () => {
        expect(railAvatarUrl({ username: "Miruku", hasAvatar: true, avatarVersion: 9 }))
            .toBe("/api/live/profile/miruku/avatar?v=9&s=128");
    });

    test("skips the request when the channel has no avatar", () => {
        expect(railAvatarUrl({ username: "bob", hasAvatar: false, avatarVersion: 0 })).toBeNull();
    });

    test("falls back to the unversioned small url without explore avatar fields", () => {
        expect(railAvatarUrl({ username: "bob" })).toBe("/api/live/profile/bob/avatar?s=128");
    });
});

describe("syncRailAvatar", () => {
    test("adds one lazy image and keeps it while the url is unchanged", () => {
        const span = new StubSpan();
        sync(span, "/a?v=1&s=128", true);
        sync(span, "/a?v=1&s=128", true);
        expect(span.children.length).toBe(1);
        expect(created).toBe(1);
        const img = span.children[0]!;
        expect(img.src).toBe("/a?v=1&s=128");
        expect(img.loading).toBe("lazy");
        expect(img.className).toBe("live-channel-avatar-img");
    });

    test("swaps the source when the version changes", () => {
        const span = new StubSpan();
        sync(span, "/a?v=1&s=128", true);
        sync(span, "/a?v=2&s=128", true);
        expect(span.children.length).toBe(1);
        expect(span.children[0]!.src).toBe("/a?v=2&s=128");
    });

    test("keeps the versioned image when a later update carries no avatar fields", () => {
        const span = new StubSpan();
        sync(span, "/a?v=1&s=128", true);
        sync(span, "/a?s=128", false);
        expect(span.children[0]!.src).toBe("/a?v=1&s=128");
    });

    test("removes the image once the channel has no avatar", () => {
        const span = new StubSpan();
        sync(span, "/a?v=1&s=128", true);
        sync(span, null, true);
        expect(span.children.length).toBe(0);
    });

    test("does not retry a url that already failed", () => {
        const span = new StubSpan();
        sync(span, "/a?v=1&s=128", true);
        span.children[0]!.onerror?.();
        expect(span.children.length).toBe(0);
        sync(span, "/a?v=1&s=128", true);
        expect(span.children.length).toBe(0);
        sync(span, "/a?v=2&s=128", true);
        expect(span.children.length).toBe(1);
    });
});
