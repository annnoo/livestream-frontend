export const STALL_DECAY_QUIET_MS = 120000;
export const STALL_DECAY_STEP_S = 1;

export function decayedTargetLatency(currentTargetS: number | null, baseTargetS: number, quietMs: number): number | null {
    if (currentTargetS === null || !Number.isFinite(currentTargetS)) return null;
    if (!Number.isFinite(baseTargetS) || baseTargetS <= 0) return null;
    if (quietMs < STALL_DECAY_QUIET_MS) return null;
    if (currentTargetS - baseTargetS < 0.05) return null;
    return Math.max(baseTargetS, currentTargetS - STALL_DECAY_STEP_S);
}
