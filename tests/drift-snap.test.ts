import { expect, test } from "bun:test";
import { DRIFT_SNAP_COOLDOWN_MS, DRIFT_SNAP_EXCESS_S, driftSnapPosition } from "../src/live/player/drift-snap.ts";

const idle = DRIFT_SNAP_COOLDOWN_MS;

test("small drift is left to the playback rate catch-up", () => {
    expect(driftSnapPosition(1.5 + DRIFT_SNAP_EXCESS_S, 1.5, 100, 101, idle)).toBeNull();
});

test("large drift with the live position already buffered snaps to it", () => {
    expect(driftSnapPosition(12, 1.5, 100, 101, idle)).toBe(100);
});

test("never snaps past what is buffered", () => {
    expect(driftSnapPosition(12, 1.5, 100, 99, idle)).toBeNull();
});

test("cooldown blocks a repeated snap", () => {
    expect(driftSnapPosition(12, 1.5, 100, 101, idle - 1)).toBeNull();
});

test("unknown latency or position never snaps", () => {
    expect(driftSnapPosition(null, 1.5, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(12, null, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(12, 1.5, null, 101, idle)).toBeNull();
    expect(driftSnapPosition(Number.NaN, 1.5, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(12, 0, 100, 101, idle)).toBeNull();
});
