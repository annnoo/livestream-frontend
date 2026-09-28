import { expect, test } from "bun:test";
import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats, PlaylistLoaderContext } from "hls.js";
import { FAILED_PROBE, needsRttFetch, primedMasterLoader, probeOutcome, rttFromTiming, startPathFor, timingSince } from "../src/live/player/master-probe.ts";

const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000\nsource/index.m3u8?ll=1\n";

test("403 quality-locked locks, other 403 bodies do not", () => {
    expect(probeOutcome(403, JSON.stringify({ error: "quality-locked" })).locked).toBe(true);
    expect(probeOutcome(403, JSON.stringify({ error: "forbidden" })).locked).toBe(false);
    expect(probeOutcome(403, "not json").locked).toBe(false);
    expect(probeOutcome(200, JSON.stringify({ error: "quality-locked" })).locked).toBe(false);
});

test("404 and 410 are offline, other failures are not", () => {
    expect(probeOutcome(404, "").missing).toBe(true);
    expect(probeOutcome(410, "").missing).toBe(true);
    expect(probeOutcome(500, "").missing).toBe(false);
    expect(probeOutcome(403, "").missing).toBe(false);
});

test("origin low latency is read only from a playable master", () => {
    expect(probeOutcome(200, master)).toEqual({ locked: false, missing: false, originLL: true, playable: true });
    expect(probeOutcome(200, master.replace("?ll=1", "")).originLL).toBe(false);
    expect(probeOutcome(200, master.replace("ll=1", "prefetch=1")).originLL).toBe(true);
    expect(probeOutcome(500, master).originLL).toBe(false);
    expect(probeOutcome(500, master).playable).toBe(false);
});

test("start path keeps locked and offline ahead of every player", () => {
    const locked = probeOutcome(403, JSON.stringify({ error: "quality-locked" }));
    const missing = probeOutcome(404, "");
    const ok = probeOutcome(200, master);
    expect(startPathFor(locked, true, true)).toBe("quality-locked");
    expect(startPathFor(missing, false, true)).toBe("offline");
    expect(startPathFor(ok, true, true)).toBe("native");
    expect(startPathFor(ok, false, true)).toBe("low-latency");
    expect(startPathFor(ok, false, false)).toBe("standard");
    expect(startPathFor(FAILED_PROBE, false, true)).toBe("low-latency");
    expect(startPathFor(FAILED_PROBE, false, false)).toBe("standard");
});

test("only a standard origin start without probe timing pays a second request", () => {
    expect(needsRttFetch("low-latency", false, null)).toBe(false);
    expect(needsRttFetch("native", false, null)).toBe(false);
    expect(needsRttFetch("quality-locked", false, null)).toBe(false);
    expect(needsRttFetch("offline", false, null)).toBe(false);
    expect(needsRttFetch("standard", true, null)).toBe(false);
    expect(needsRttFetch("standard", false, 25)).toBe(false);
    expect(needsRttFetch("standard", false, null)).toBe(true);
});

test("probe round trip comes from request and response start", () => {
    expect(rttFromTiming({ requestStart: 100, responseStart: 132 })).toBe(32);
    expect(rttFromTiming({ requestStart: 0, responseStart: 0 })).toBeNull();
    expect(rttFromTiming({ requestStart: 100, responseStart: 90 })).toBeNull();
    expect(rttFromTiming({ requestStart: Number.NaN, responseStart: 5 })).toBeNull();
    expect(rttFromTiming(null)).toBeNull();
    expect(rttFromTiming(undefined)).toBeNull();
});

class FakeLoader {
    static requests: FakeLoader[] = [];
    context: LoaderContext | null = null;
    stats = { loading: { start: 1, first: 2, end: 3 }, loaded: 4 } as LoaderStats;
    aborted = false;
    destroyed = false;
    constructor(_config: HlsConfig) {}
    load(context: LoaderContext, _config: LoaderConfiguration, _callbacks: LoaderCallbacks<LoaderContext>) {
        this.context = context;
        FakeLoader.requests.push(this);
    }
    abort() { this.aborted = true; }
    destroy() { this.destroyed = true; }
}

const config = {} as HlsConfig;
const loadConfig = {} as LoaderConfiguration;
const src = "https://origin.example/hls/alice/master.m3u8?ll=1&t=abc";
const redirected = "https://origin2.example/hls/alice/master.m3u8?ll=1&t=abc";

function contextFor(type: string, url = src): PlaylistLoaderContext {
    return { url, responseType: "text", type, level: null, id: null, levelOrTrack: null, deliveryDirectives: null } as unknown as PlaylistLoaderContext;
}

function capture() {
    const seen: Array<{ url: string; data: unknown; code?: number; stats: LoaderStats }> = [];
    const callbacks = {
        onSuccess: (response: { url: string; data?: unknown; code?: number }, stats: LoaderStats) => seen.push({ url: response.url, data: response.data, code: response.code, stats }),
        onError: () => {},
        onTimeout: () => {},
    } as unknown as LoaderCallbacks<PlaylistLoaderContext>;
    return { seen, callbacks };
}

test("first manifest load is served from the probe without a request", async () => {
    FakeLoader.requests = [];
    const Loader = primedMasterLoader(FakeLoader, { url: redirected, text: master });
    const loader = new Loader(config);
    const { seen, callbacks } = capture();
    loader.load(contextFor("manifest"), loadConfig, callbacks);
    expect(seen.length).toBe(0);
    await Promise.resolve();
    expect(FakeLoader.requests.length).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe(redirected);
    expect(seen[0].data).toBe(master);
    expect(seen[0].code).toBe(200);
    expect(seen[0].stats.loaded).toBe(master.length);
    expect(loader.stats).toBe(seen[0].stats);
    expect(loader.getResponseHeader?.("age")).toBeNull();
});

test("the probe text is used once, later loads go to the network", async () => {
    FakeLoader.requests = [];
    const Loader = primedMasterLoader(FakeLoader, { url: src, text: master });
    const first = new Loader(config);
    first.load(contextFor("manifest"), loadConfig, capture().callbacks);
    await Promise.resolve();
    const second = new Loader(config);
    second.load(contextFor("manifest"), loadConfig, capture().callbacks);
    expect(FakeLoader.requests.length).toBe(1);
    expect(FakeLoader.requests[0].context?.url).toBe(src);
    expect(second.stats).toBe(FakeLoader.requests[0].stats);
});

test("level playlists are never served from the probe", () => {
    FakeLoader.requests = [];
    const Loader = primedMasterLoader(FakeLoader, { url: src, text: master });
    const level = new Loader(config);
    const levelUrl = "https://origin.example/hls/alice/source/index.m3u8?ll=1";
    level.load(contextFor("level", levelUrl), loadConfig, capture().callbacks);
    expect(FakeLoader.requests.length).toBe(1);
    expect(FakeLoader.requests[0].context?.url).toBe(levelUrl);
    const manifest = new Loader(config);
    manifest.load(contextFor("manifest"), loadConfig, capture().callbacks);
    expect(FakeLoader.requests.length).toBe(1);
});

test("abort before delivery suppresses the primed response", async () => {
    FakeLoader.requests = [];
    const Loader = primedMasterLoader(FakeLoader, { url: src, text: master });
    const loader = new Loader(config);
    const { seen, callbacks } = capture();
    loader.load(contextFor("manifest"), loadConfig, callbacks);
    loader.abort();
    await Promise.resolve();
    expect(seen.length).toBe(0);
    loader.destroy();
});

test("only a timing entry that started with the current probe is used", () => {
    const stale = { startTime: 100, requestStart: 110, responseStart: 400 };
    const current = { startTime: 5000, requestStart: 5010, responseStart: 5042 };
    expect(timingSince([stale], 4999)).toBeNull();
    expect(rttFromTiming(timingSince([stale], 4999))).toBeNull();
    expect(timingSince([stale, current], 4999)).toBe(current);
    expect(rttFromTiming(timingSince([stale, current], 4999))).toBe(32);
    expect(timingSince([current], 5000)).toBe(current);
    expect(timingSince([], 0)).toBeNull();
});

test("a stale entry recorded after the current one is still skipped", () => {
    const current = { startTime: 5000, requestStart: 5010, responseStart: 5042 };
    const stale = { startTime: 100, requestStart: 110, responseStart: 400 };
    expect(timingSince([current, stale], 4999)).toBe(current);
});
