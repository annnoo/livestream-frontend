import { masterOffersLowLatency } from "../../player-shared/low-latency.ts";

export const EDGE_LL_REPROBE_FIRST_MS = 15000;
export const EDGE_LL_REPROBE_EVERY_MS = 60000;

export function edgeLowLatencyReprobeMs(attempt: number): number {
    return attempt <= 0 ? EDGE_LL_REPROBE_FIRST_MS : EDGE_LL_REPROBE_EVERY_MS;
}

export function watchesEdgeLowLatencyOffer(requested: boolean, edgeServed: boolean, chosen: boolean): boolean {
    return requested && edgeServed && !chosen;
}

export interface ReprobeView {
    paused: boolean;
    behindLive: boolean;
    visible: boolean;
}

export function edgeReprobeDue(view: ReprobeView): boolean {
    return view.visible && !view.paused && !view.behindLive;
}

export function edgeLowLatencyUpgrade(masterBody: string, view: ReprobeView): boolean {
    return edgeReprobeDue(view) && masterOffersLowLatency(masterBody);
}

export type PartsTransition = "withdrawn" | "restored" | null;

export function partsTransition(hadParts: boolean | null, hasParts: boolean): PartsTransition {
    if (hadParts === null || hadParts === hasParts) return null;
    return hasParts ? "restored" : "withdrawn";
}
