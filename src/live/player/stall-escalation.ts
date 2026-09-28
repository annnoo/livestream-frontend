export type StallStep = "reload" | "recover-media" | "teardown";

export interface StallRung {
    step: StallStep;
    atMs: number;
}

export const STALL_RELOAD_FRACTION = 0.5;
export const STALL_TEARDOWN_FACTOR = 1.5;
export const MEDIA_RECOVERY_COOLDOWN_MS = 10000;
export const NUDGE_MIN_AHEAD_S = 0.5;
export const RECOVERY_LIVE_SEEK_WINDOW_MS = 30000;
export const RECOVERY_LIVE_SEEK_MIN_BEHIND_S = 2;
export const RECOVERY_LIVE_SEEK_MIN_AHEAD_S = 2;

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

export interface RecoveryLiveSeekInput {
    currentTime: number;
    syncPosition: number | null;
    ranges: Array<{ start: number; end: number }>;
    behindLive: boolean;
    paused: boolean;
}

export type RecoveryLiveSeek = { kind: "seek"; to: number } | { kind: "wait" } | { kind: "done" };

export function recoveryLiveSeek(input: RecoveryLiveSeekInput): RecoveryLiveSeek {
    if (input.behindLive || input.paused) return { kind: "done" };
    const sync = input.syncPosition;
    if (sync === null || !Number.isFinite(sync)) return { kind: "wait" };
    if (sync - input.currentTime < RECOVERY_LIVE_SEEK_MIN_BEHIND_S) return { kind: "wait" };
    for (const range of input.ranges) {
        if (sync >= range.start && range.end - sync >= RECOVERY_LIVE_SEEK_MIN_AHEAD_S) return { kind: "seek", to: sync };
    }
    return { kind: "wait" };
}
