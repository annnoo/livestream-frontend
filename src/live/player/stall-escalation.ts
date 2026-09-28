export type StallStep = "reload" | "recover-media" | "teardown";

export interface StallRung {
    step: StallStep;
    atMs: number;
}

export const STALL_RELOAD_FRACTION = 0.5;
export const STALL_TEARDOWN_FACTOR = 1.5;
export const MEDIA_RECOVERY_COOLDOWN_MS = 10000;
export const NUDGE_MIN_AHEAD_S = 0.5;
export const STALL_RECOVERED_WINDOW_MS = 2000;

export function stallRecovered(sinceProgressMs: number, paused: boolean): boolean {
    return paused || sinceProgressMs < STALL_RECOVERED_WINDOW_MS;
}

export function stallLadder(graceMs: number, hlsJs: boolean): StallRung[] {
    if (!hlsJs) return [{ step: "teardown", atMs: graceMs }];
    return [
        { step: "reload", atMs: Math.round(graceMs * STALL_RELOAD_FRACTION) },
        { step: "recover-media", atMs: graceMs },
        { step: "teardown", atMs: stallTeardownMs(graceMs, true) },
    ];
}

export function stallTeardownMs(graceMs: number, hlsJs: boolean): number {
    return hlsJs ? Math.round(graceMs * STALL_TEARDOWN_FACTOR) : graceMs;
}

export function stallStepDue(ladder: StallRung[], stalledMs: number, taken: number): { step: StallStep; taken: number } | null {
    let due = -1;
    for (let i = Math.max(0, taken); i < ladder.length; i++) {
        if (stalledMs >= ladder[i].atMs) due = i;
    }
    if (due < 0) return null;
    return { step: ladder[due].step, taken: due + 1 };
}

export function nextStallCheckMs(ladder: StallRung[], stalledMs: number, taken: number): number | null {
    if (taken >= ladder.length) return null;
    return Math.max(0, ladder[Math.max(0, taken)].atMs - stalledMs);
}

export function mediaErrorStep(hlsJs: boolean, sinceLastRecoveryMs: number): "recover-media" | "teardown" {
    return hlsJs && sinceLastRecoveryMs >= MEDIA_RECOVERY_COOLDOWN_MS ? "recover-media" : "teardown";
}

export function nudgeSeekTarget(
    currentTime: number,
    syncPosition: number | null,
    ranges: Array<{ start: number; end: number }>,
    behindLive: boolean,
): number | null {
    if (behindLive || syncPosition === null || !Number.isFinite(syncPosition)) return null;
    if (syncPosition <= currentTime) return null;
    for (const range of ranges) {
        if (syncPosition >= range.start && range.end - syncPosition >= NUDGE_MIN_AHEAD_S) return syncPosition;
    }
    return null;
}
