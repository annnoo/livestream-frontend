import type Hls from "hls.js";
import type { HlsConfig } from "hls.js";
import { primedMasterLoader, type PrimedMaster } from "../live/player/master-probe.ts";
import { abrEstimateFor } from "../live/player/far-tier.ts";
import { driftSnapPosition } from "../live/player/drift-snap.ts";
import { decayedTargetLatency } from "../live/player/stall-decay.ts";
import { tokenCarriesLowLatency } from "./viewer-claim.ts";

export const LL_STARTUP_RUNWAY_S = 1;
export const LL_TRIM_TICK_MS = 500;

export function lowLatencyRequested(entitled: boolean, edgeServed: boolean, native: boolean): boolean {
    return entitled && !(edgeServed && native);
}

export function lowLatencyForToken(token: string | null, edgeServed: boolean, native: boolean): boolean {
    return lowLatencyRequested(tokenCarriesLowLatency(token), edgeServed, native);
}

function variantUriOffersLowLatency(uri: string): boolean {
    const q = uri.indexOf("?");
    if (q < 0) return false;
    const hash = uri.indexOf("#", q);
    const query = hash < 0 ? uri.slice(q + 1) : uri.slice(q + 1, hash);
    return new URLSearchParams(query).getAll("ll").includes("1");
}

export function masterOffersLowLatency(body: string): boolean {
    const lines = body.split(/\r?\n/).map((line) => line.trim());
    let variants = 0;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
        let j = i + 1;
        while (j < lines.length && (lines[j] === "" || lines[j].startsWith("#"))) j++;
        if (j >= lines.length || !variantUriOffersLowLatency(lines[j])) return false;
        variants += 1;
        i = j;
    }
    return variants > 0;
}

export function lowLatencyChosen(requested: boolean, edgeServed: boolean, masterBody: string): boolean {
    return requested && (!edgeServed || masterOffersLowLatency(masterBody));
}

export function masterMode(lowLatency: boolean): "ll=1" | "prefetch=1" {
    return lowLatency ? "ll=1" : "prefetch=1";
}

export function lowLatencyHlsConfig(
    loader: Parameters<typeof primedMasterLoader>[0],
    primed: PrimedMaster | null,
    backBufferLength: number,
    withCredentials: (url: string) => boolean,
): Partial<HlsConfig> {
    return {
        lowLatencyMode: true,
        ...(primed ? { pLoader: primedMasterLoader(loader, primed) } : {}),
        abrEwmaDefaultEstimate: abrEstimateFor("mid"),
        backBufferLength,
        maxLiveSyncPlaybackRate: 1.05,
        enableWorker: true,
        xhrSetup: (xhr, url) => {
            xhr.withCredentials = withCredentials(url);
        },
    };
}

export interface BufferedRanges {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
}

export function bufferedRangeEndAt(buffered: BufferedRanges, position: number): number {
    for (let i = 0; i < buffered.length; i++) {
        if (position >= buffered.start(i) && position <= buffered.end(i)) return buffered.end(i);
    }
    return 0;
}

export interface LowLatencyTrim {
    lastDriftSnapAt: number;
    lastTargetChangeAt: number;
}

export function newLowLatencyTrim(now: number): LowLatencyTrim {
    return { lastDriftSnapAt: 0, lastTargetChangeAt: now };
}

export type TrimmableHls = Pick<Hls, "latency" | "liveSyncPosition" | "latestLevelDetails" | "targetLatency">;

export interface TrimmableMedia {
    buffered: BufferedRanges;
    currentTime: number;
}

export function trimLowLatency(hls: TrimmableHls, media: TrimmableMedia, trim: LowLatencyTrim, now: number): boolean {
    const syncPos = hls.liveSyncPosition;
    const snapTo = driftSnapPosition(hls.latency, hls.targetLatency, hls.latestLevelDetails?.targetduration ?? Number.NaN, syncPos, syncPos === null ? 0 : bufferedRangeEndAt(media.buffered, syncPos), now - trim.lastDriftSnapAt);
    if (snapTo !== null) {
        trim.lastDriftSnapAt = now;
        console.log("live: drifted", hls.latency.toFixed(1), "s behind, target", hls.targetLatency?.toFixed(1), "s, snapping to live");
        media.currentTime = snapTo;
    }
    const details = hls.latestLevelDetails;
    const base = details ? details.partHoldBack || details.holdBack : Number.NaN;
    const decayed = decayedTargetLatency(hls.targetLatency, base, now - trim.lastTargetChangeAt);
    if (decayed !== null) {
        trim.lastTargetChangeAt = now;
        console.log("live: no stall for a while, lowering target latency to", decayed.toFixed(1), "s");
        hls.targetLatency = decayed;
    }
    return snapTo !== null;
}
