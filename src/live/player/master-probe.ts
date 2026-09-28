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

export const RESOURCE_TIMING_WAIT_MS = 250;

export interface ResourceTimingEnv {
    buffered(): readonly TimedEntry[];
    observe(onEntries: (entries: readonly TimedEntry[]) => void): (() => void) | null;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface ResourceTimingWatch {
    settle(waitMs: number): Promise<RequestTiming | null>;
    stop(): void;
}

export function browserResourceTimingEnv(url: string): ResourceTimingEnv {
    let href = url;
    try {
        href = new URL(url, location.href).href;
    } catch {}
    return {
        buffered: () => {
            try {
                return performance.getEntriesByName(href, "resource") as PerformanceResourceTiming[];
            } catch {
                return [];
            }
        },
        observe: (onEntries) => {
            try {
                const observer = new PerformanceObserver((list) => onEntries(list.getEntriesByName(href, "resource") as PerformanceResourceTiming[]));
                observer.observe({ type: "resource" });
                return () => observer.disconnect();
            } catch {
                return null;
            }
        },
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
    };
}

export function watchResourceTiming(since: number, env: ResourceTimingEnv): ResourceTimingWatch {
    let observed: TimedEntry | null = null;
    let wake: (() => void) | null = null;
    let disconnect: (() => void) | null = env.observe((entries) => {
        const hit = timingSince(entries, since);
        if (!hit) return;
        observed = hit;
        wake?.();
    });
    const stop = (): void => {
        disconnect?.();
        disconnect = null;
        wake = null;
    };
    const settle = (waitMs: number): Promise<RequestTiming | null> => {
        const found = timingSince(env.buffered(), since) ?? observed;
        if (found || !disconnect) {
            stop();
            return Promise.resolve(found);
        }
        return new Promise((resolve) => {
            const timer = env.setTimeout(() => {
                stop();
                resolve(observed);
            }, waitMs);
            wake = () => {
                env.clearTimeout(timer);
                stop();
                resolve(observed);
            };
        });
    };
    return { settle, stop };
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
