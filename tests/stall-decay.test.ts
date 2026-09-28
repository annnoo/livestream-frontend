import { expect, test } from "bun:test";
import { STALL_DECAY_QUIET_MS, STALL_DECAY_STEP_S, decayedTargetLatency } from "../src/live/player/stall-decay.ts";

const quiet = STALL_DECAY_QUIET_MS;

test("a stall-raised target steps back down after a quiet stretch", () => {
    expect(decayedTargetLatency(3.5, 1.5, quiet)).toBe(3.5 - STALL_DECAY_STEP_S);
});

test("never decays below the playlist hold-back", () => {
    expect(decayedTargetLatency(2, 1.5, quiet)).toBe(1.5);
});

test("a recent stall keeps the raised target", () => {
    expect(decayedTargetLatency(3.5, 1.5, quiet - 1)).toBeNull();
});

test("a target already at the hold-back is left alone", () => {
    expect(decayedTargetLatency(1.5, 1.5, quiet)).toBeNull();
    expect(decayedTargetLatency(1.52, 1.5, quiet)).toBeNull();
});

test("unknown values never decay", () => {
    expect(decayedTargetLatency(null, 1.5, quiet)).toBeNull();
    expect(decayedTargetLatency(3.5, 0, quiet)).toBeNull();
    expect(decayedTargetLatency(3.5, Number.NaN, quiet)).toBeNull();
});
