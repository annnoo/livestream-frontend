import { expect, test } from "bun:test";
import { DRIFT_SNAP_COOLDOWN_MS, DRIFT_SNAP_EXCESS_S, driftSnapPosition } from "../src/live/player/drift-snap.ts";

const idle = DRIFT_SNAP_COOLDOWN_MS;

test("drift inside the playback rate catch-up reach is left alone", () => {
    expect(driftSnapPosition(1.5 + 3.4, 1.5, 2, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(1.5 + DRIFT_SNAP_EXCESS_S - 0.1, 1.5, 5, 100, 101, idle)).toBeNull();
});

test("drift beyond the rate catch-up reach snaps even under the excess cap", () => {
    expect(driftSnapPosition(1.5 + 3.5, 1.5, 2, 100, 101, idle)).toBe(100);
});

test("long target durations are capped by the excess limit", () => {
    expect(driftSnapPosition(1.5 + DRIFT_SNAP_EXCESS_S, 1.5, 5, 100, 101, idle)).toBe(100);
});

test("never snaps past what is buffered", () => {
    expect(driftSnapPosition(12, 1.5, 2, 100, 99, idle)).toBeNull();
});

test("cooldown blocks a repeated snap", () => {
    expect(driftSnapPosition(12, 1.5, 2, 100, 101, idle - 1)).toBeNull();
});

test("unknown latency or position never snaps", () => {
    expect(driftSnapPosition(null, 1.5, 2, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(12, null, 2, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(12, 1.5, 2, null, 101, idle)).toBeNull();
    expect(driftSnapPosition(Number.NaN, 1.5, 2, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(12, 0, 2, 100, 101, idle)).toBeNull();
});

test("an unknown target duration falls back to the excess limit", () => {
    expect(driftSnapPosition(1.5 + 3.5, 1.5, Number.NaN, 100, 101, idle)).toBeNull();
    expect(driftSnapPosition(1.5 + DRIFT_SNAP_EXCESS_S, 1.5, Number.NaN, 100, 101, idle)).toBe(100);
});
