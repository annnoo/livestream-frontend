import type { HlsConfig } from "hls.js";
import { abrEstimateFor, stallGraceMsFor, startupRunwayFor } from "./far-tier.ts";
import { clampToAdvertisedWindow, farWindowFor, latencyTierFor, latencyWindowFor, type LatencyTier, type LatencyWindow } from "./latency-window.ts";

export const DEFAULT_LIVE_WINDOW: LatencyWindow = { sync: 5, max: 12 };
export const TIGHT_LIVE_WINDOW: LatencyWindow = { sync: 2.5, max: 8 };
export const FAR_LIVE_WINDOW: LatencyWindow = { sync: 10, max: 24 };

export interface PlainPlayerSetup {
    tier: LatencyTier;
    graceMs: number;
    startupRunwayS: number;
    window: LatencyWindow;
    abrEstimateBps: number;
}

export function plainPlayerSetup(edgeServed: boolean, rttMs: number | null, originLL: boolean, phone: boolean, baseGraceMs: number, baseRunwayS: number): PlainPlayerSetup {
    const tier: LatencyTier = edgeServed ? "far" : latencyTierFor(rttMs, originLL, phone);
    return {
        tier,
        graceMs: stallGraceMsFor(tier, baseGraceMs),
        startupRunwayS: startupRunwayFor(tier, baseRunwayS),
        window: edgeServed
            ? DEFAULT_LIVE_WINDOW
            : tier === "near"
                ? TIGHT_LIVE_WINDOW
                : tier === "far" ? FAR_LIVE_WINDOW : DEFAULT_LIVE_WINDOW,
        abrEstimateBps: abrEstimateFor(tier),
    };
}

export function plainHlsTuning(setup: PlainPlayerSetup, backBufferLength: number): Partial<HlsConfig> {
    return {
        lowLatencyMode: false,
        abrEwmaDefaultEstimate: setup.abrEstimateBps,
        backBufferLength,
        liveSyncDuration: setup.window.sync,
        liveMaxLatencyDuration: setup.window.max,
        maxLiveSyncPlaybackRate: 1.05,
        enableWorker: true,
    };
}

export interface PlainLevelDetails {
    targetduration: number;
    totalduration: number;
    url: string;
}

export function plainLevelWindow(edgeServed: boolean, tier: LatencyTier, details: PlainLevelDetails, mediaBase: string): LatencyWindow {
    const base = edgeServed
        ? DEFAULT_LIVE_WINDOW
        : tier === "far"
            ? farWindowFor(details.targetduration) ?? FAR_LIVE_WINDOW
            : tier === "near" && details.url.startsWith(mediaBase) ? TIGHT_LIVE_WINDOW : DEFAULT_LIVE_WINDOW;
    const widened = latencyWindowFor(details.targetduration);
    return clampToAdvertisedWindow(widened && widened.sync > base.sync ? widened : base, details.totalduration, details.targetduration);
}
