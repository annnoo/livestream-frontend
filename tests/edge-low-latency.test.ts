import { describe, expect, test } from "bun:test";
import * as edgeLowLatency from "../src/live/player/edge-low-latency.ts";
import {
    edgeLowLatencyUpgrade,
    edgeOfferWatch,
    edgeReprobeDue,
    partsTransition,
    watchesEdgeLowLatencyOffer,
    type ReprobeView,
} from "../src/live/player/edge-low-latency.ts";
import { beatEdgeLowLatency, beatVariants } from "../src/player-shared/hls-beat.ts";
import { lowLatencyChosen, lowLatencyRequested, masterMode, masterOffersLowLatency } from "../src/player-shared/low-latency.ts";
import { probeOutcome, startPathFor } from "../src/live/player/master-probe.ts";
import { DEFAULT_LIVE_WINDOW, FAR_LIVE_WINDOW, plainHlsTuning, plainLevelWindow, plainPlayerSetup, TIGHT_LIVE_WINDOW } from "../src/live/player/plain-setup.ts";
import { FAR_ABR_ESTIMATE_BPS, FAR_STALL_GRACE_MS, lowLatencyStallGraceMs } from "../src/live/player/far-tier.ts";
import { WAITING_STALL_MS } from "../src/live/constants.ts";
import { STARTUP_RUNWAY_S } from "../src/live/player/startup-hold.ts";
import { nudgeSeekTarget, recoveryLiveSeek } from "../src/live/player/stall-escalation.ts";

function master(...uris: string[]): string {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:9"];
    uris.forEach((uri, i) => lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${6000000 - i * 1000000},RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.64002a,mp4a.40.2"`, uri));
    lines.push("#EXT-X-ITZON-LOCKED:RESOLUTION=2560x1440,FRAME-RATE=60,TIER=2");
    return lines.join("\n") + "\n";
}

const ZONE = "https://fra-edge-hls.itzon.tv/hls/alice/";
const ZONE_TOKEN = "token=AbC-dEf_0&expires=1790000000&token_path=%2Fhls%2Falice%2Fsource%2F";

const OFFERED: Record<string, string> = {
    "zone": master(`${ZONE}source/live.m3u8?ll=1&v=1790000000`, `${ZONE}720p60/live.m3u8?ll=1&v=1790000000`),
    "zone with token auth": master(`${ZONE}source/live.m3u8?ll=1&${ZONE_TOKEN}&v=1790000000`),
    "no zone": master("live.m3u8?ll=1", "720p60/live.m3u8?ll=1"),
    "no zone with token": master("live.m3u8?ll=1&t=100.nonce.1.sig", "720p60/live.m3u8?ll=1&t=100.nonce.1.sig"),
    "crlf line ends": master(`${ZONE}source/live.m3u8?ll=1&v=1`).replace(/\n/g, "\r\n"),
};

const NOT_OFFERED: Record<string, string> = {
    "zone": master(`${ZONE}source/live.m3u8?v=1790000000`, `${ZONE}720p60/live.m3u8?v=1790000000`),
    "zone with token auth": master(`${ZONE}source/live.m3u8?${ZONE_TOKEN}&v=1790000000`),
    "no zone": master("live.m3u8?prefetch=1", "720p60/live.m3u8?prefetch=1"),
    "no zone with token": master("live.m3u8?prefetch=1&t=100.nonce.1.sig"),
    "bare variant": master("live.m3u8"),
    "ll=1 only in the token path": master(`${ZONE}source/live.m3u8?token_path=%2Fhls%2Fll%3D1%2F&v=1`),
    "ll=1 only inside the token": master("live.m3u8?prefetch=1&t=all%3D1.ll=1x"),
    "ll set to another value": master("live.m3u8?ll=10&t=x", "720p60/live.m3u8?ll=0"),
    "ll=1 only in a fragment": master("live.m3u8?prefetch=1#ll=1"),
    "one variant without ll=1": master(`${ZONE}source/live.m3u8?ll=1&v=1`, `${ZONE}720p60/live.m3u8?v=1`),
    "no variants": "#EXTM3U\n#EXT-X-VERSION:9\n",
    "stream-inf without a uri": "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n",
    "empty body": "",
    "quality-locked 403 body": JSON.stringify({ error: "quality-locked" }),
};

describe("the edge offer is read from the master's variant URIs", () => {
    for (const [name, body] of Object.entries(OFFERED)) {
        test(`offered: ${name}`, () => {
            expect(masterOffersLowLatency(body)).toBe(true);
        });
    }
    for (const [name, body] of Object.entries(NOT_OFFERED)) {
        test(`not offered: ${name}`, () => {
            expect(masterOffersLowLatency(body)).toBe(false);
        });
    }
});

describe("start path for an entitled edge viewer", () => {
    for (const [name, body] of Object.entries(OFFERED)) {
        test(`takes the low latency path when offered (${name})`, () => {
            expect(startPathFor(probeOutcome(200, body), false, lowLatencyChosen(true, true, body))).toBe("low-latency");
        });
    }

    test("403 and 404/410 keep their paths ahead of the offer", () => {
        expect(startPathFor(probeOutcome(403, JSON.stringify({ error: "quality-locked" })), false, lowLatencyChosen(true, true, ""))).toBe("quality-locked");
        expect(startPathFor(probeOutcome(404, ""), false, lowLatencyChosen(true, true, ""))).toBe("offline");
        expect(startPathFor(probeOutcome(410, ""), false, lowLatencyChosen(true, true, ""))).toBe("offline");
    });

    test("native Safari on an edge keeps the prefetch master and the native path", () => {
        expect(lowLatencyRequested(true, true, true)).toBe(false);
        expect(masterMode(lowLatencyRequested(true, true, true))).toBe("prefetch=1");
    });
});

describe("switch off: an edge that does not offer low latency plays exactly as before", () => {
    const rtts = [null, 5, 30, 60, 200];
    const expectedSetup = {
        tier: "far",
        graceMs: 20000,
        startupRunwayS: 6,
        window: { sync: 5, max: 12 },
        abrEstimateBps: 2500000,
    };

    for (const [name, body] of Object.entries(NOT_OFFERED)) {
        test(`asking with ll=1 picks the same path as asking with prefetch=1 (${name})`, () => {
            const status = name === "quality-locked 403 body" ? 403 : 200;
            const asked = startPathFor(probeOutcome(status, body), false, lowLatencyChosen(true, true, body));
            const before = startPathFor(probeOutcome(status, body), false, false);
            expect(asked).toBe(before);
            expect(watchesEdgeLowLatencyOffer(true, true, lowLatencyChosen(true, true, body))).toBe(true);
        });
    }

    test("the plain edge setup keeps the far tier, mid window, 20 s grace, 6 s runway and far ABR estimate", () => {
        for (const rtt of rtts) {
            for (const originLL of [false, true]) {
                for (const phone of [false, true]) {
                    expect(plainPlayerSetup(true, rtt, originLL, phone, WAITING_STALL_MS, STARTUP_RUNWAY_S)).toEqual(expectedSetup as ReturnType<typeof plainPlayerSetup>);
                }
            }
        }
        expect(FAR_STALL_GRACE_MS).toBe(20000);
        expect(FAR_ABR_ESTIMATE_BPS).toBe(2500000);
    });

    test("the plain edge hls.js tuning is unchanged", () => {
        expect(plainHlsTuning(plainPlayerSetup(true, null, false, false, WAITING_STALL_MS, STARTUP_RUNWAY_S), 300)).toEqual({
            lowLatencyMode: false,
            abrEwmaDefaultEstimate: 2500000,
            backBufferLength: 300,
            liveSyncDuration: 5,
            liveMaxLatencyDuration: 12,
            maxLiveSyncPlaybackRate: 1.05,
            enableWorker: true,
        });
    });

    test("the plain edge level window stays the mid window, widened and clamped as before", () => {
        const url = "https://fra-edge-hls.itzon.tv/hls/alice/source/live.m3u8?v=1";
        expect(plainLevelWindow(true, "far", { targetduration: 1, totalduration: 30, url }, "https://fra.edge.itzon.tv")).toEqual({ sync: 5, max: 12 });
        expect(plainLevelWindow(true, "far", { targetduration: 2, totalduration: 30, url }, "https://fra.edge.itzon.tv")).toEqual({ sync: 5, max: 12 });
        expect(plainLevelWindow(true, "far", { targetduration: 6, totalduration: 60, url }, "https://fra.edge.itzon.tv")).toEqual({ sync: 9, max: 18 });
        expect(plainLevelWindow(true, "far", { targetduration: 1, totalduration: 6, url }, "https://fra.edge.itzon.tv")).toEqual({ sync: 4, max: 6 });
    });
});

describe("origin viewers are unchanged", () => {
    test("an entitled origin viewer takes low latency on the request alone, as before", () => {
        for (const body of [...Object.values(OFFERED), ...Object.values(NOT_OFFERED)]) {
            expect(lowLatencyChosen(true, false, body)).toBe(true);
            expect(lowLatencyChosen(false, false, body)).toBe(false);
        }
        expect(watchesEdgeLowLatencyOffer(true, false, true)).toBe(false);
        expect(watchesEdgeLowLatencyOffer(false, false, false)).toBe(false);
    });

    test("the plain origin setup keeps its tiers", () => {
        expect(plainPlayerSetup(false, 20, true, false, 8000, 2.5)).toEqual({ tier: "near", graceMs: 8000, startupRunwayS: 2.5, window: TIGHT_LIVE_WINDOW, abrEstimateBps: 10000000 });
        expect(plainPlayerSetup(false, 20, true, true, 8000, 2.5)).toEqual({ tier: "mid", graceMs: 8000, startupRunwayS: 2.5, window: DEFAULT_LIVE_WINDOW, abrEstimateBps: 10000000 });
        expect(plainPlayerSetup(false, null, false, false, 8000, 2.5)).toEqual({ tier: "mid", graceMs: 8000, startupRunwayS: 2.5, window: DEFAULT_LIVE_WINDOW, abrEstimateBps: 10000000 });
        expect(plainPlayerSetup(false, 120, false, false, 8000, 2.5)).toEqual({ tier: "far", graceMs: 20000, startupRunwayS: 6, window: FAR_LIVE_WINDOW, abrEstimateBps: 2500000 });
    });

    test("the plain origin level window keeps the far, near and mid rules", () => {
        const base = "https://origin.itzon.tv";
        expect(plainLevelWindow(false, "far", { targetduration: 1, totalduration: 60, url: `${base}/x` }, base)).toEqual({ sync: 8, max: 14 });
        expect(plainLevelWindow(false, "near", { targetduration: 1, totalduration: 60, url: `${base}/x` }, base)).toEqual({ sync: 2.5, max: 8 });
        expect(plainLevelWindow(false, "near", { targetduration: 1, totalduration: 60, url: "https://zone.b-cdn.net/x" }, base)).toEqual({ sync: 5, max: 12 });
        expect(plainLevelWindow(false, "mid", { targetduration: 1, totalduration: 60, url: `${base}/x` }, base)).toEqual({ sync: 5, max: 12 });
    });
});

describe("edge low latency stall grace", () => {
    test("an edge low latency viewer gets the far grace, an origin one keeps the base", () => {
        expect(lowLatencyStallGraceMs(true, WAITING_STALL_MS)).toBe(FAR_STALL_GRACE_MS);
        expect(lowLatencyStallGraceMs(false, WAITING_STALL_MS)).toBe(WAITING_STALL_MS);
        expect(lowLatencyStallGraceMs(true, 30000)).toBe(30000);
    });
});

describe("fall back to the plain playlist on the same url", () => {
    test("a tail that moved back a segment or two never makes the reload nudge or the recovery seek jump backwards", () => {
        const ranges = [{ start: 90, end: 101 }];
        expect(nudgeSeekTarget(99, 97.5, ranges, false)).toBeNull();
        expect(recoveryLiveSeek({ currentTime: 99, syncPosition: 97.5, ranges, behindLive: false, paused: false })).toEqual({ kind: "wait" });
    });

    test("parts transitions are reported once each way", () => {
        expect(partsTransition(null, true)).toBeNull();
        expect(partsTransition(null, false)).toBeNull();
        expect(partsTransition(true, true)).toBeNull();
        expect(partsTransition(true, false)).toBe("withdrawn");
        expect(partsTransition(false, false)).toBeNull();
        expect(partsTransition(false, true)).toBe("restored");
    });
});

describe("re-probing the edge for its offer", () => {
    const view = { paused: false, behindLive: false, visible: true };

    test("only an entitled edge viewer left on the plain variant re-probes", () => {
        expect(watchesEdgeLowLatencyOffer(true, true, false)).toBe(true);
        expect(watchesEdgeLowLatencyOffer(true, true, true)).toBe(false);
        expect(watchesEdgeLowLatencyOffer(false, true, false)).toBe(false);
        expect(watchesEdgeLowLatencyOffer(true, false, false)).toBe(false);
    });

    test("no re-probe while paused, behind live or hidden", () => {
        expect(edgeReprobeDue(view)).toBe(true);
        expect(edgeReprobeDue({ ...view, paused: true })).toBe(false);
        expect(edgeReprobeDue({ ...view, behindLive: true })).toBe(false);
        expect(edgeReprobeDue({ ...view, visible: false })).toBe(false);
    });

    test("upgrades only on an offered master while still watching live", () => {
        expect(edgeLowLatencyUpgrade(OFFERED["zone"], view)).toBe(true);
        expect(edgeLowLatencyUpgrade(NOT_OFFERED["zone"], view)).toBe(false);
        expect(edgeLowLatencyUpgrade("", view)).toBe(false);
        expect(edgeLowLatencyUpgrade(OFFERED["zone"], { ...view, paused: true })).toBe(false);
        expect(edgeLowLatencyUpgrade(OFFERED["zone"], { ...view, behindLive: true })).toBe(false);
    });
});

const TODAY_BEAT = JSON.stringify({ variants: 3 });
const OFFER_BEAT = JSON.stringify({ variants: 3, edgeLL: true });

class OfferHarness {
    fetches = 0;
    switches = 0;
    view: ReprobeView = { paused: false, behindLive: false, visible: true };
    wanted = true;
    live = true;
    master: string | null = OFFERED["zone"];
    pending: Array<() => void> = [];
    beat = edgeOfferWatch({
        live: () => this.live,
        wanted: () => this.wanted,
        view: () => this.view,
        fetchMaster: () => {
            this.fetches += 1;
            const body = this.master;
            return new Promise((resolve) => this.pending.push(() => resolve(body)));
        },
        switchToLowLatency: () => {
            this.switches += 1;
            this.live = false;
        },
    });

    send(status: number, body: string): void {
        this.beat(beatEdgeLowLatency(status, body));
    }

    async answer(): Promise<void> {
        for (const resolve of this.pending.splice(0)) resolve();
        for (let i = 0; i < 5; i++) await Promise.resolve();
    }
}

describe("the beat reply carries the edge's low latency offer", () => {
    test("only a literal edgeLL true on a 200 reply is an offer", () => {
        expect(beatEdgeLowLatency(200, OFFER_BEAT)).toBe(true);
        expect(beatEdgeLowLatency(200, TODAY_BEAT)).toBe(false);
        expect(beatEdgeLowLatency(200, JSON.stringify({ variants: 3, edgeLL: false }))).toBe(false);
        for (const garbage of ["true", "1", 1, "yes", null, {}, [true]]) {
            expect(beatEdgeLowLatency(200, JSON.stringify({ variants: 3, edgeLL: garbage }))).toBe(false);
        }
        expect(beatEdgeLowLatency(204, "")).toBe(false);
        expect(beatEdgeLowLatency(200, "")).toBe(false);
        expect(beatEdgeLowLatency(200, "not json")).toBe(false);
        expect(beatEdgeLowLatency(200, "null")).toBe(false);
        expect(beatEdgeLowLatency(200, "true")).toBe(false);
        expect(beatEdgeLowLatency(404, OFFER_BEAT)).toBe(false);
    });

    test("the variant count reads the same with or without the field", () => {
        expect(beatVariants(200, OFFER_BEAT)).toBe(3);
        expect(beatVariants(200, TODAY_BEAT)).toBe(3);
    });

    test("there is no timed master poll left", () => {
        expect(Object.keys(edgeLowLatency).filter((name) => /REPROBE|ReprobeMs/.test(name))).toEqual([]);
    });
});

describe("a plain edge viewer follows the offer in the beat", () => {
    test("beats without the field never fetch the master", async () => {
        const h = new OfferHarness();
        for (let beat = 0; beat < 20; beat++) {
            h.send(200, TODAY_BEAT);
            h.send(204, "");
            h.send(200, JSON.stringify({ variants: 3, edgeLL: "true" }));
            await h.answer();
        }
        expect(h.fetches).toBe(0);
        expect(h.switches).toBe(0);
    });

    test("a beat with the offer fetches the master once and switches", async () => {
        const h = new OfferHarness();
        h.send(200, TODAY_BEAT);
        h.send(200, OFFER_BEAT);
        h.send(200, OFFER_BEAT);
        expect(h.fetches).toBe(1);
        await h.answer();
        expect(h.switches).toBe(1);
        h.send(200, OFFER_BEAT);
        await h.answer();
        expect(h.fetches).toBe(1);
        expect(h.switches).toBe(1);
    });

    test("a master whose variant lacks ll=1 is not taken and is not fetched again until the offer returns", async () => {
        const h = new OfferHarness();
        h.master = NOT_OFFERED["zone"];
        h.send(200, OFFER_BEAT);
        await h.answer();
        h.send(200, OFFER_BEAT);
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([1, 0]);
        h.send(200, TODAY_BEAT);
        h.master = OFFERED["zone"];
        h.send(200, OFFER_BEAT);
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([2, 1]);
    });

    test("a failed master fetch is tried again on the next offering beat", async () => {
        const h = new OfferHarness();
        h.master = null;
        h.send(200, OFFER_BEAT);
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([1, 0]);
        h.master = OFFERED["zone"];
        h.send(200, OFFER_BEAT);
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([2, 1]);
    });

    test("no fetch while paused, behind live or hidden, and the next offering beat after that switches", async () => {
        for (const held of [{ paused: true }, { behindLive: true }, { visible: false }]) {
            const h = new OfferHarness();
            h.view = { ...h.view, ...held };
            h.send(200, OFFER_BEAT);
            await h.answer();
            expect(h.fetches).toBe(0);
            h.view = { paused: false, behindLive: false, visible: true };
            h.send(200, OFFER_BEAT);
            await h.answer();
            expect([h.fetches, h.switches]).toEqual([1, 1]);
        }
    });

    test("a viewer who paused while the master was in flight stays put and switches on a later beat", async () => {
        const h = new OfferHarness();
        h.send(200, OFFER_BEAT);
        h.view = { ...h.view, paused: true };
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([1, 0]);
        h.view = { ...h.view, paused: false };
        h.send(200, OFFER_BEAT);
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([2, 1]);
    });

    test("an opted out viewer or a replaced transport never fetches", async () => {
        const optedOut = new OfferHarness();
        optedOut.wanted = false;
        optedOut.send(200, OFFER_BEAT);
        const replaced = new OfferHarness();
        replaced.live = false;
        replaced.send(200, OFFER_BEAT);
        await optedOut.answer();
        await replaced.answer();
        expect(optedOut.fetches + replaced.fetches).toBe(0);
    });

    test("a transport replaced while the master was in flight does not switch", async () => {
        const h = new OfferHarness();
        h.send(200, OFFER_BEAT);
        h.live = false;
        await h.answer();
        expect([h.fetches, h.switches]).toEqual([1, 0]);
    });
});
