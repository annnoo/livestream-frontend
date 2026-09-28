import { expect, test } from "bun:test";
import {
    mediaErrorStep,
    MEDIA_RECOVERY_COOLDOWN_MS,
    nextStallCheckMs,
    nudgeSeekTarget,
    stallLadder,
    stallRecovered,
    stallStepDue,
    stallTeardownMs,
} from "../src/live/player/stall-escalation.ts";

test("hls.js stalls escalate reload, media recovery, then teardown", () => {
    expect(stallLadder(8000, true)).toEqual([
        { step: "reload", atMs: 4000 },
        { step: "recover-media", atMs: 8000 },
        { step: "teardown", atMs: 12000 },
    ]);
});

test("native playback keeps the single teardown at the grace", () => {
    expect(stallLadder(8000, false)).toEqual([{ step: "teardown", atMs: 8000 }]);
    expect(stallTeardownMs(8000, false)).toBe(8000);
});

test("far tier grace stretches every rung", () => {
    expect(stallLadder(20000, true).map((r) => r.atMs)).toEqual([10000, 20000, 30000]);
    expect(stallTeardownMs(20000, true)).toBe(30000);
});

test("nothing is due before the first rung", () => {
    const ladder = stallLadder(8000, true);
    expect(stallStepDue(ladder, 0, 0)).toBeNull();
    expect(stallStepDue(ladder, 3999, 0)).toBeNull();
});

test("rungs fire in order as the stall lengthens", () => {
    const ladder = stallLadder(8000, true);
    expect(stallStepDue(ladder, 4000, 0)).toEqual({ step: "reload", taken: 1 });
    expect(stallStepDue(ladder, 7000, 1)).toBeNull();
    expect(stallStepDue(ladder, 8000, 1)).toEqual({ step: "recover-media", taken: 2 });
    expect(stallStepDue(ladder, 11000, 2)).toBeNull();
    expect(stallStepDue(ladder, 12000, 2)).toEqual({ step: "teardown", taken: 3 });
    expect(stallStepDue(ladder, 60000, 3)).toBeNull();
});

test("a late check jumps to the furthest rung reached", () => {
    const ladder = stallLadder(8000, true);
    expect(stallStepDue(ladder, 9000, 0)).toEqual({ step: "recover-media", taken: 2 });
    expect(stallStepDue(ladder, 30000, 0)).toEqual({ step: "teardown", taken: 3 });
});

test("next check waits for the next untaken rung", () => {
    const ladder = stallLadder(8000, true);
    expect(nextStallCheckMs(ladder, 0, 0)).toBe(4000);
    expect(nextStallCheckMs(ladder, 4000, 1)).toBe(4000);
    expect(nextStallCheckMs(ladder, 9000, 2)).toBe(3000);
    expect(nextStallCheckMs(ladder, 20000, 2)).toBe(0);
    expect(nextStallCheckMs(ladder, 12000, 3)).toBeNull();
});

test("media errors recover in place once per cooldown", () => {
    expect(mediaErrorStep(true, Number.POSITIVE_INFINITY)).toBe("recover-media");
    expect(mediaErrorStep(true, MEDIA_RECOVERY_COOLDOWN_MS)).toBe("recover-media");
    expect(mediaErrorStep(true, MEDIA_RECOVERY_COOLDOWN_MS - 1)).toBe("teardown");
    expect(mediaErrorStep(false, Number.POSITIVE_INFINITY)).toBe("teardown");
});

test("nudge seeks to the live sync point when it is buffered ahead", () => {
    expect(nudgeSeekTarget(10, 14, [{ start: 9, end: 16 }], false)).toBe(14);
    expect(nudgeSeekTarget(10, 14, [{ start: 9, end: 10.2 }, { start: 13, end: 15 }], false)).toBe(14);
});

test("nudge does not seek without buffered media at the sync point", () => {
    expect(nudgeSeekTarget(10, 14, [{ start: 9, end: 12 }], false)).toBeNull();
    expect(nudgeSeekTarget(10, 14, [{ start: 9, end: 14.2 }], false)).toBeNull();
    expect(nudgeSeekTarget(10, 14, [], false)).toBeNull();
});

test("nudge never seeks backwards, without a sync point, or while behind live", () => {
    expect(nudgeSeekTarget(15, 14, [{ start: 9, end: 20 }], false)).toBeNull();
    expect(nudgeSeekTarget(10, null, [{ start: 9, end: 20 }], false)).toBeNull();
    expect(nudgeSeekTarget(10, Number.NaN, [{ start: 9, end: 20 }], false)).toBeNull();
    expect(nudgeSeekTarget(10, 14, [{ start: 9, end: 20 }], true)).toBeNull();
});

test("a stall counts as recovered only with fresh progress or a pause", () => {
    expect(stallRecovered(250, false)).toBe(true);
    expect(stallRecovered(1999, false)).toBe(true);
    expect(stallRecovered(2000, false)).toBe(false);
    expect(stallRecovered(4000, false)).toBe(false);
    expect(stallRecovered(60000, true)).toBe(true);
});
