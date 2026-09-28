import type { EmbedPlaybackState } from "./context.ts";
import { lowLatencyStallGraceMs } from "../live/player/far-tier.ts";
import { recoveryDeadlineMs } from "../live/player/recovery-deadline.ts";

export interface EmbedStallTimings {
    waitingMs: number;
    staleMs: number;
}

export function embedStallTimings(lowLatency: boolean, edgeServed: boolean, waitingMs: number, staleMs: number): EmbedStallTimings {
    const graceMs = lowLatency ? lowLatencyStallGraceMs(edgeServed, waitingMs) : waitingMs;
    return { waitingMs: graceMs, staleMs: recoveryDeadlineMs(staleMs, graceMs) };
}

export type EmbedHealthRestartReason = "stuck-connecting" | "stale-progress";

export interface EmbedHealthInput {
    state: EmbedPlaybackState;
    now: number;
    lastStateChangeAt: number;
    lastProgressAt: number;
    paused: boolean;
    staleMs: number;
    stuckMs: number;
}

export function decideEmbedHealth(input: EmbedHealthInput): EmbedHealthRestartReason | null {
    if (input.state === "connecting") {
        return input.now - input.lastStateChangeAt > input.stuckMs ? "stuck-connecting" : null;
    }
    if (input.state !== "playing") return null;
    if (!input.paused && input.now - input.lastProgressAt > input.staleMs) return "stale-progress";
    return null;
}
