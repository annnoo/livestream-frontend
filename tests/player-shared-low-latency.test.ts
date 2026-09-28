import { expect, test } from "bun:test";
import type { HlsConfig, LevelDetails } from "hls.js";
import Hls from "hls.js";
import { bufferedRangeEndAt, lowLatencyChosen, lowLatencyForToken, lowLatencyRequested, lowLatencyHlsConfig, masterMode, newLowLatencyTrim, trimLowLatency, type BufferedRanges, type TrimmableHls } from "../src/player-shared/low-latency.ts";
import { DRIFT_SNAP_COOLDOWN_MS } from "../src/live/player/drift-snap.ts";
import { STALL_DECAY_QUIET_MS } from "../src/live/player/stall-decay.ts";

function ranges(list: Array<[number, number]>): BufferedRanges {
    return {
        length: list.length,
        start: (i) => list[i]![0],
        end: (i) => list[i]![1],
    };
}

test("an entitled viewer asks for low latency from an origin and from an edge, except native on an edge", () => {
    expect(lowLatencyRequested(true, false, false)).toBe(true);
    expect(lowLatencyRequested(true, false, true)).toBe(true);
    expect(lowLatencyRequested(true, true, false)).toBe(true);
    expect(lowLatencyRequested(true, true, true)).toBe(false);
    expect(lowLatencyRequested(false, false, false)).toBe(false);
    expect(lowLatencyRequested(false, true, false)).toBe(false);
});

test("embed takes the low latency request from the captcha token", () => {
    expect(lowLatencyForToken("100.nonce.1.sig", false, false)).toBe(true);
    expect(lowLatencyForToken("100.nonce.1.sig", true, false)).toBe(true);
    expect(lowLatencyForToken("100.nonce.1.sig", true, true)).toBe(false);
    expect(lowLatencyForToken("100.nonce.1.sig", false, true)).toBe(true);
    expect(lowLatencyForToken("100.nonce.0.sig", false, false)).toBe(false);
    expect(lowLatencyForToken(null, true, false)).toBe(false);
});

test("an origin viewer who asked keeps low latency whatever the master says, an edge viewer needs the offer", () => {
    const offered = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://fra-edge-hls.itzon.tv/hls/a/source/live.m3u8?ll=1&v=1\n";
    const plain = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://fra-edge-hls.itzon.tv/hls/a/source/live.m3u8?v=1\n";
    expect(lowLatencyChosen(true, false, "")).toBe(true);
    expect(lowLatencyChosen(true, false, plain)).toBe(true);
    expect(lowLatencyChosen(true, true, offered)).toBe(true);
    expect(lowLatencyChosen(true, true, plain)).toBe(false);
    expect(lowLatencyChosen(true, true, "")).toBe(false);
    expect(lowLatencyChosen(false, true, offered)).toBe(false);
    expect(lowLatencyChosen(false, false, offered)).toBe(false);
});

test("master mode follows the low latency choice", () => {
    expect(masterMode(true)).toBe("ll=1");
    expect(masterMode(false)).toBe("prefetch=1");
});

test("low latency config turns on hls.js low latency and passes the primed master", () => {
    const withPrimed = lowLatencyHlsConfig(Hls.DefaultConfig.loader, { url: "https://o/master.m3u8", text: "#EXTM3U" }, 30, () => true);
    expect(withPrimed.lowLatencyMode).toBe(true);
    expect(withPrimed.backBufferLength).toBe(30);
    expect(withPrimed.maxLiveSyncPlaybackRate).toBe(1.05);
    expect(typeof withPrimed.pLoader).toBe("function");
    const bare = lowLatencyHlsConfig(Hls.DefaultConfig.loader, null, 300, () => false);
    expect(bare.pLoader).toBeUndefined();
    expect(bare.backBufferLength).toBe(300);
});

test("low latency config sets credentials per url", () => {
    const cfg: Partial<HlsConfig> = lowLatencyHlsConfig(Hls.DefaultConfig.loader, null, 30, (url) => url.startsWith("https://origin"));
    const xhr = { withCredentials: false } as XMLHttpRequest;
    cfg.xhrSetup!(xhr, "https://origin/a.m3u8");
    expect(xhr.withCredentials).toBe(true);
    cfg.xhrSetup!(xhr, "https://cdn/a.m4s");
    expect(xhr.withCredentials).toBe(false);
});

test("buffered range end is found only for a buffered position", () => {
    const b = ranges([[0, 4], [10, 20]]);
    expect(bufferedRangeEndAt(b, 12)).toBe(20);
    expect(bufferedRangeEndAt(b, 2)).toBe(4);
    expect(bufferedRangeEndAt(b, 7)).toBe(0);
    expect(bufferedRangeEndAt(ranges([]), 1)).toBe(0);
});

function fakeHls(latency: number, targetLatency: number, liveSyncPosition: number | null, details: Partial<LevelDetails> | null): TrimmableHls {
    return { latency, targetLatency, liveSyncPosition, latestLevelDetails: details as LevelDetails | null } as TrimmableHls;
}

test("trim snaps a drifted player to the live sync position", () => {
    const hls = fakeHls(9, 2, 100, { targetduration: 1, partHoldBack: 2, holdBack: 3 });
    const media = { buffered: ranges([[90, 101]]), currentTime: 91 };
    const trim = newLowLatencyTrim(0);
    const now = DRIFT_SNAP_COOLDOWN_MS + 1;
    trimLowLatency(hls, media, trim, now);
    expect(media.currentTime).toBe(100);
    expect(trim.lastDriftSnapAt).toBe(now);
});

test("trim leaves an on-target player alone", () => {
    const hls = fakeHls(2.2, 2, 100, { targetduration: 1, partHoldBack: 2, holdBack: 3 });
    const media = { buffered: ranges([[90, 101]]), currentTime: 97.8 };
    const trim = newLowLatencyTrim(0);
    trimLowLatency(hls, media, trim, 1000);
    expect(media.currentTime).toBe(97.8);
    expect(hls.targetLatency).toBe(2);
    expect(trim).toEqual({ lastDriftSnapAt: 0, lastTargetChangeAt: 0 });
});

test("trim lowers a stall-raised target after a quiet period", () => {
    const hls = fakeHls(4, 4, 100, { targetduration: 1, partHoldBack: 2, holdBack: 3 });
    const media = { buffered: ranges([[90, 101]]), currentTime: 96 };
    const trim = newLowLatencyTrim(0);
    trimLowLatency(hls, media, trim, STALL_DECAY_QUIET_MS);
    expect(hls.targetLatency).toBe(3);
    expect(trim.lastTargetChangeAt).toBe(STALL_DECAY_QUIET_MS);
});

test("trim does not snap into an unbuffered position", () => {
    const hls = fakeHls(9, 2, 100, { targetduration: 1, partHoldBack: 2, holdBack: 3 });
    const media = { buffered: ranges([[90, 95]]), currentTime: 91 };
    const trim = newLowLatencyTrim(0);
    trimLowLatency(hls, media, trim, DRIFT_SNAP_COOLDOWN_MS + 1);
    expect(media.currentTime).toBe(91);
});

test("trim leaves an edge player alone while the edge serves its plain playlist on the parts url", () => {
    const hls = fakeHls(1.5, 3, 97, { targetduration: 1, partHoldBack: 0, holdBack: 0 });
    const media = { buffered: ranges([[90, 101]]), currentTime: 99.5 };
    const trim = newLowLatencyTrim(0);
    const now = DRIFT_SNAP_COOLDOWN_MS + STALL_DECAY_QUIET_MS;
    expect(trimLowLatency(hls, media, trim, now)).toBe(false);
    expect(media.currentTime).toBe(99.5);
    expect(hls.targetLatency).toBe(3);
    expect(trim).toEqual({ lastDriftSnapAt: 0, lastTargetChangeAt: 0 });
});

test("trim never lowers the target toward a plain playlist that has no hold-back", () => {
    const hls = fakeHls(4, 4, 100, { targetduration: 1, partHoldBack: 0, holdBack: 0 });
    const media = { buffered: ranges([[90, 101]]), currentTime: 96 };
    const trim = newLowLatencyTrim(0);
    trimLowLatency(hls, media, trim, STALL_DECAY_QUIET_MS * 3);
    expect(hls.targetLatency).toBe(4);
});

test("trim snaps forward once when the edge's parts return and the new live edge is buffered", () => {
    const hls = fakeHls(8, 3, 105, { targetduration: 1, partHoldBack: 3, holdBack: 3 });
    const media = { buffered: ranges([[90, 106]]), currentTime: 97 };
    const trim = newLowLatencyTrim(0);
    const now = DRIFT_SNAP_COOLDOWN_MS + 1;
    expect(trimLowLatency(hls, media, trim, now)).toBe(true);
    expect(media.currentTime).toBe(105);
    media.currentTime = 97;
    expect(trimLowLatency(hls, media, trim, now + 1000)).toBe(false);
    expect(media.currentTime).toBe(97);
});
