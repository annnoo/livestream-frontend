import { expect, test } from "bun:test";
import {
    mediaErrorStep,
    MEDIA_RECOVERY_COOLDOWN_MS,
    nextStallCheckMs,
    nudgeSeekTarget,
    RECOVERY_LIVE_SEEK_MIN_BEHIND_S,
    RECOVERY_LIVE_SEEK_WINDOW_MS,
    recoveryLiveSeek,
    stallCheck,
    stallEpisodeOnPlaying,
    stallEpisodeOnWaiting,
    stallLadder,
    stallStepDue,
    stallTeardownMs,
    type StallEpisode,
    type StallStep,
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

const ladder8 = stallLadder(8000, true);

test("a check drops the episode on a pause or on fresh progress with no step taken", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stallCheck(ladder8, episode, 4000, 0, true)).toEqual({ kind: "drop" });
    expect(stallCheck(ladder8, episode, 4000, 3000, false)).toEqual({ kind: "drop" });
    expect(stallCheck(ladder8, episode, 4000, 0, false)).toEqual({ kind: "step", step: "reload", taken: 1 });
    expect(stallCheck(ladder8, episode, 3000, 0, false)).toEqual({ kind: "wait" });
});

test("a re-stall under 2 s after resuming still takes the next step at its check", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(episode, 4000)).toBe("reload");
    stallEpisodeOnPlaying(episode, 4500);
    expect(stallEpisodeOnWaiting(episode, 6400, 6400)).toBe(episode);
    expect(stallCheck(ladder8, episode, 8000, 6400, false)).toEqual({ kind: "step", step: "recover-media", taken: 2 });
});

test("the nudge's own progress does not count as recovered at the next check", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(episode, 4000)).toBe("reload");
    expect(stallCheck(ladder8, episode, 8000, 4050, false)).toEqual({ kind: "step", step: "recover-media", taken: 2 });
});

test("a check during a brief resume holds the episode and the next stall takes the next step", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(episode, 4000)).toBe("reload");
    stallEpisodeOnPlaying(episode, 7500);
    expect(stallCheck(ladder8, episode, 8000, 7900, false)).toEqual({ kind: "hold" });
    expect(stallEpisodeOnWaiting(episode, 8500, 8500)).toBe(episode);
    expect(nextStallCheckMs(ladder8, 8500 - episode.startedAt, episode.taken)).toBe(0);
    expect(stallCheck(ladder8, episode, 8500, 8500, false)).toEqual({ kind: "step", step: "recover-media", taken: 2 });
});

test("a stutter loop climbs the whole ladder to the teardown", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(episode, 4000)).toBe("reload");
    stallEpisodeOnPlaying(episode, 4500);
    stallEpisodeOnWaiting(episode, 6400, 6400);
    const media = stallCheck(ladder8, episode, 8000, 6400, false);
    expect(media).toEqual({ kind: "step", step: "recover-media", taken: 2 });
    episode.taken = 2;
    stallEpisodeOnPlaying(episode, 8500);
    expect(stallEpisodeOnWaiting(episode, 10000, 10000)).toBe(episode);
    expect(stallCheck(ladder8, episode, 12000, 10000, false)).toEqual({ kind: "step", step: "teardown", taken: 3 });
});

test("playback that ran 2 s past playing drops the episode at the check", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(episode, 4000)).toBe("reload");
    stallEpisodeOnPlaying(episode, 4500);
    expect(stallCheck(ladder8, episode, 8000, 7900, false)).toEqual({ kind: "drop" });
});

test("progress after a step without a playing event drops the episode at the check", () => {
    const episode = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(episode, 4000)).toBe("reload");
    expect(stallCheck(ladder8, episode, 8000, 7900, false)).toEqual({ kind: "drop" });
});

function stepAt(episode: StallEpisode, now: number): StallStep | null {
    const due = stallStepDue(stallLadder(8000, true), now - episode.startedAt, episode.taken);
    if (!due) return null;
    episode.taken = due.taken;
    return due.step;
}

test("a stall after a recovery that played on runs the steps from the first rung", () => {
    const first = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(first, 4000)).toBe("reload");
    stallEpisodeOnPlaying(first, 4500);
    const second = stallEpisodeOnWaiting(first, 9000, 8900);
    expect(second).not.toBe(first);
    expect(second.taken).toBe(0);
    expect(stepAt(second, 12000)).toBeNull();
    expect(stepAt(second, 13000)).toBe("reload");
    expect(stepAt(second, 17000)).toBe("recover-media");
});

test("a stall after media recovery also starts over once playback resumed", () => {
    const first = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(first, 9000)).toBe("recover-media");
    stallEpisodeOnPlaying(first, 9500);
    const second = stallEpisodeOnWaiting(first, 20000, 19900);
    expect(second.taken).toBe(0);
    expect(stepAt(second, 24000)).toBe("reload");
});

test("the nudge's own progress and a brief playing keep the ladder climbing", () => {
    const first = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(first, 4000)).toBe("reload");
    expect(stallEpisodeOnWaiting(first, 4100, 4000)).toBe(first);
    stallEpisodeOnPlaying(first, 4050);
    expect(stallEpisodeOnWaiting(first, 5000, 4900)).toBe(first);
    expect(stepAt(first, 8000)).toBe("recover-media");
});

test("progress without a playing event after a step keeps the episode", () => {
    const first = stallEpisodeOnWaiting(null, 0, 0);
    expect(stepAt(first, 4000)).toBe("reload");
    expect(stallEpisodeOnWaiting(first, 30000, 29000)).toBe(first);
});

test("a stall that cleared before any step starts a new episode on fresh progress", () => {
    const first = stallEpisodeOnWaiting(null, 0, 0);
    expect(stallEpisodeOnWaiting(first, 1000, 0)).toBe(first);
    const second = stallEpisodeOnWaiting(first, 3000, 2500);
    expect(second).not.toBe(first);
    expect(second.startedAt).toBe(3000);
});

const recovered = { currentTime: 100, syncPosition: 112, ranges: [{ start: 95, end: 114 }], behindLive: false, paused: false, sinceRecoveryMs: 1000 };

test("after a media recovery the player seeks to the buffered live sync position", () => {
    expect(recoveryLiveSeek(recovered)).toEqual({ kind: "seek", to: 112 });
    expect(recoveryLiveSeek({ ...recovered, ranges: [{ start: 95, end: 101 }, { start: 110, end: 113 }] })).toEqual({ kind: "seek", to: 112 });
});

test("the recovery seek ignores the drift snap cooldown and fires within its own window", () => {
    expect(recoveryLiveSeek({ ...recovered, sinceRecoveryMs: RECOVERY_LIVE_SEEK_WINDOW_MS })).toEqual({ kind: "seek", to: 112 });
    expect(recoveryLiveSeek({ ...recovered, sinceRecoveryMs: RECOVERY_LIVE_SEEK_WINDOW_MS + 1 })).toEqual({ kind: "done" });
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
