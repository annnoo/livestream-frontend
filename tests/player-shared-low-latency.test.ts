import { expect, test } from "bun:test";
import type { HlsConfig, LevelDetails } from "hls.js";
import Hls from "hls.js";
import { bufferedRangeEndAt, lowLatencyAvailable, lowLatencyForToken, lowLatencyHlsConfig, masterMode, newLowLatencyTrim, trimLowLatency, type BufferedRanges, type TrimmableHls } from "../src/player-shared/low-latency.ts";
import { DRIFT_SNAP_COOLDOWN_MS } from "../src/live/player/drift-snap.ts";
import { STALL_DECAY_QUIET_MS } from "../src/live/player/stall-decay.ts";

function ranges(list: Array<[number, number]>): BufferedRanges {
    return {
        length: list.length,
        start: (i) => list[i]![0],
        end: (i) => list[i]![1],
    };
}

test("low latency needs the token bit and an origin-served channel", () => {
    expect(lowLatencyAvailable(true, false)).toBe(true);
    expect(lowLatencyAvailable(true, true)).toBe(false);
    expect(lowLatencyAvailable(false, false)).toBe(false);
    expect(lowLatencyAvailable(false, true)).toBe(false);
});

test("embed takes low latency from the captcha token", () => {
    expect(lowLatencyForToken("100.nonce.1.sig", false)).toBe(true);
    expect(lowLatencyForToken("100.nonce.1.sig", true)).toBe(false);
    expect(lowLatencyForToken("100.nonce.0.sig", false)).toBe(false);
    expect(lowLatencyForToken(null, false)).toBe(false);
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
