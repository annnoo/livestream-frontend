export const DRIFT_SNAP_EXCESS_S = 4;
export const DRIFT_SNAP_COOLDOWN_MS = 30000;

export function driftSnapPosition(
    latencyS: number | null,
    targetS: number | null,
    syncPositionS: number | null,
    bufferedEndS: number,
    sinceLastSnapMs: number,
): number | null {
    if (latencyS === null || targetS === null || syncPositionS === null) return null;
    if (!Number.isFinite(latencyS) || !Number.isFinite(targetS) || !Number.isFinite(syncPositionS)) return null;
    if (targetS <= 0 || syncPositionS <= 0) return null;
    if (sinceLastSnapMs < DRIFT_SNAP_COOLDOWN_MS) return null;
    if (latencyS - targetS <= DRIFT_SNAP_EXCESS_S) return null;
    if (syncPositionS > bufferedEndS) return null;
    return syncPositionS;
}
