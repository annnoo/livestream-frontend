import { expect, test } from "bun:test";
import {
    mediaErrorStep,
    MEDIA_RECOVERY_COOLDOWN_MS,
    nudgeSeekTarget,
    RECOVERY_LIVE_SEEK_MIN_AHEAD_S,
    RECOVERY_LIVE_SEEK_MIN_BEHIND_S,
    recoveryLiveSeek,
    stallLadder,
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

const recovered = { currentTime: 100, syncPosition: 112, ranges: [{ start: 95, end: 114 }], behindLive: false, paused: false };

test("after a media recovery the player seeks to the buffered live sync position", () => {
    expect(recoveryLiveSeek(recovered)).toEqual({ kind: "seek", to: 112 });
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 101 }, { start: 110, end: 114 }] })).toEqual({ kind: "seek", to: 112 });
});

test("the recovery seek keeps at least 2 s of buffer past the live sync position", () => {
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 112 + RECOVERY_LIVE_SEEK_MIN_AHEAD_S }] })).toEqual({ kind: "seek", to: 112 });
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 112 + RECOVERY_LIVE_SEEK_MIN_AHEAD_S - 0.01 }] })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 112.5 }] })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 101 }, { start: 110, end: 113 }] })).toEqual({ kind: "wait" });
});

test("the recovery seek waits until the live sync position is buffered", () => {
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 108 }] })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 112.2 }] })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, ranges: [] })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, syncPosition: null })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, syncPosition: Number.NaN })).toEqual({ kind: "wait" });
});

test("the recovery seek leaves a player already near live alone", () => {
    expect(recoveryLiveSeek({ ...recovered, syncPosition: 100 + RECOVERY_LIVE_SEEK_MIN_BEHIND_S - 0.1 })).toEqual({ kind: "wait" });
    expect(recoveryLiveSeek({ ...recovered, syncPosition: 99 })).toEqual({ kind: "wait" });
});

test("the recovery seek never yanks a viewer who is behind live or paused", () => {
    expect(recoveryLiveSeek({ ...recovered, behindLive: true })).toEqual({ kind: "done" });
    expect(recoveryLiveSeek({ ...recovered, paused: true })).toEqual({ kind: "done" });
});
