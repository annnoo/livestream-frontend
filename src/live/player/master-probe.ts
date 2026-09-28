import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats, PlaylistLoaderContext } from "hls.js";

export interface ProbeOutcome {
    locked: boolean;
    missing: boolean;
    originLL: boolean;
    playable: boolean;
}

export function probeOutcome(status: number, body: string): ProbeOutcome {
    let locked = false;
    if (status === 403) {
        try {
            if ((JSON.parse(body) as { error?: unknown }).error === "quality-locked") locked = true;
        } catch {}
    }
    const playable = status >= 200 && status < 300;
    return {
        locked,
        missing: status === 404 || status === 410,
        originLL: playable && (body.includes("ll=1") || body.includes("prefetch=1")),
        playable,
    };
}

export const FAILED_PROBE: ProbeOutcome = { locked: false, missing: false, originLL: false, playable: false };

export type StartPath = "quality-locked" | "offline" | "native" | "low-latency" | "standard";

export function startPathFor(probe: ProbeOutcome, native: boolean, lowLatency: boolean): StartPath {
    if (probe.locked) return "quality-locked";
    if (probe.missing) return "offline";
    if (native) return "native";
    if (lowLatency) return "low-latency";
    return "standard";
}

export function needsRttFetch(path: StartPath, edgeServed: boolean, probeRttMs: number | null): boolean {
    return path === "standard" && !edgeServed && probeRttMs === null;
}

export interface RequestTiming {
    requestStart: number;
    responseStart: number;
}

export function rttFromTiming(timing: RequestTiming | null | undefined): number | null {
    if (!timing) return null;
    const { requestStart, responseStart } = timing;
    if (!Number.isFinite(requestStart) || !Number.isFinite(responseStart)) return null;
    if (requestStart <= 0 || responseStart < requestStart) return null;
    return responseStart - requestStart;
}

export interface TimedEntry extends RequestTiming {
    startTime: number;
}

export function timingSince<T extends TimedEntry>(entries: readonly T[], since: number): T | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].startTime >= since) return entries[i];
    }
    return null;
}

export function resourceTimingOf(url: string, since: number): RequestTiming | null {
    try {
        return timingSince(performance.getEntriesByName(new URL(url, location.href).href, "resource") as PerformanceResourceTiming[], since);
    } catch {
        return null;
    }
}

export interface PrimedMaster {
    url: string;
    text: string;
}

type LoaderConstructor = new (config: HlsConfig) => Loader<LoaderContext>;
type PlaylistLoaderConstructor = new (config: HlsConfig) => Loader<PlaylistLoaderContext>;

function servedStats(bytes: number, now: number): LoaderStats {
    return {
        aborted: false,
        loaded: bytes,
        retry: 0,
        total: bytes,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: now, first: now, end: now },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
    };
}

export function primedMasterLoader(Base: LoaderConstructor, primed: PrimedMaster): PlaylistLoaderConstructor {
    let pending: PrimedMaster | null = primed;
    return class PrimedMasterLoader implements Loader<PlaylistLoaderContext> {
        context: PlaylistLoaderContext | null = null;
        private delegate: Loader<LoaderContext>;
        private served: LoaderStats | null = null;
        private stopped = false;
        constructor(config: HlsConfig) {
            this.delegate = new Base(config);
        }
        get stats(): LoaderStats { return this.served ?? this.delegate.stats; }
        getCacheAge(): number | null { return this.served ? null : this.delegate.getCacheAge?.() ?? null; }
        getResponseHeader(name: string): string | null { return this.served ? null : this.delegate.getResponseHeader?.(name) ?? null; }
        abort(): void {
            this.stopped = true;
            this.delegate.abort();
        }
        destroy(): void {
            this.stopped = true;
            this.delegate.destroy();
        }
        load(context: PlaylistLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<PlaylistLoaderContext>): void {
            this.context = context;
            this.stopped = false;
            const hit = pending && (context.type as string) === "manifest" ? pending : null;
            if (!hit) {
                this.served = null;
                this.delegate.load(context, config, callbacks as unknown as LoaderCallbacks<LoaderContext>);
                return;
            }
            pending = null;
            const stats = servedStats(hit.text.length, performance.now());
            this.served = stats;
            queueMicrotask(() => {
                if (!this.stopped) callbacks.onSuccess({ url: hit.url, data: hit.text, code: 200 }, stats, context, null);
            });
        }
    };
}
