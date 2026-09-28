import { describe, expect, test } from "bun:test";
import { decideEmbedHealth, embedStallTimings, type EmbedHealthInput } from "../src/embed/health-decision.ts";
import { HEALTH_STALE_MS, WAITING_STALL_MS } from "../src/embed/constants.ts";
import { FAR_STALL_GRACE_MS } from "../src/live/player/far-tier.ts";

const base: EmbedHealthInput = {
    state: "playing",
    now: 30000,
    lastStateChangeAt: 25000,
    lastProgressAt: 25000,
    paused: false,
    staleMs: 15000,
    stuckMs: 20000,
};

describe("embed health decision", () => {
    test("restarts a connection that never becomes playable", () => {
        expect(decideEmbedHealth({
            ...base,
            state: "connecting",
            now: 21001,
            lastStateChangeAt: 1000,
        })).toBe("stuck-connecting");
    });

    test("restarts active playback when its clock stops", () => {
        expect(decideEmbedHealth({
            ...base,
            now: 41001,
            lastProgressAt: 25000,
        })).toBe("stale-progress");
    });

    test("does not treat intentional paused playback as stale progress", () => {
        expect(decideEmbedHealth({
            ...base,
            now: 41001,
            lastProgressAt: 25000,
            paused: true,
        })).toBeNull();
    });

    test("leaves healthy playback alone", () => {
        expect(decideEmbedHealth(base)).toBeNull();
    });

    test("ignores retry and offline states", () => {
        expect(decideEmbedHealth({ ...base, state: "retrying", now: 100000 })).toBeNull();
        expect(decideEmbedHealth({ ...base, state: "offline", now: 100000 })).toBeNull();
    });
});

describe("embed stall timings", () => {
    test("an edge low latency embed gets the far grace for its waiting restart and its stale watchdog", () => {
        expect(embedStallTimings(true, true, WAITING_STALL_MS, HEALTH_STALE_MS)).toEqual({ waitingMs: FAR_STALL_GRACE_MS, staleMs: FAR_STALL_GRACE_MS });
        expect(FAR_STALL_GRACE_MS).toBe(20000);
    });

    test("origin embeds and plain edge embeds keep the 8 s waiting restart and the 15 s watchdog", () => {
        const unchanged = { waitingMs: 8000, staleMs: 15000 };
        expect(embedStallTimings(true, false, WAITING_STALL_MS, HEALTH_STALE_MS)).toEqual(unchanged);
        expect(embedStallTimings(false, true, WAITING_STALL_MS, HEALTH_STALE_MS)).toEqual(unchanged);
        expect(embedStallTimings(false, false, WAITING_STALL_MS, HEALTH_STALE_MS)).toEqual(unchanged);
    });

    test("the watchdog of an edge low latency embed does not fire inside the far grace", () => {
        const timings = embedStallTimings(true, true, WAITING_STALL_MS, HEALTH_STALE_MS);
        const stalled = { ...base, staleMs: timings.staleMs, lastProgressAt: 10000 };
        expect(decideEmbedHealth({ ...stalled, now: 10000 + 19000 })).toBeNull();
        expect(decideEmbedHealth({ ...stalled, now: 10000 + 20001 })).toBe("stale-progress");
    });
});
