import Hls from "hls.js";
import { video } from "./dom.ts";
import { ctx, isCurrent, track } from "./context.ts";
import { HLS_BEACON_INTERVAL_MS } from "./constants.ts";
import { captchaQuery, getCaptchaToken } from "../captcha.ts";
import { ensureViewerId } from "../player-shared/viewer-id.ts";
import { needsCredentials } from "../player-shared/needs-credentials.ts";
import { goOffline, resetRetryBackoff, restartAfterFailure, setPlaying } from "./lifecycle.ts";
import { latencyTierFor } from "../live/player/latency-window.ts";
import { abrEstimateFor } from "../live/player/far-tier.ts";
import { attachVideoFailureListeners } from "./health.ts";
import { needsRttFetch, primedMasterLoader, resourceTimingOf, rttFromTiming, type PrimedMaster } from "../live/player/master-probe.ts";
import { bufferedAheadOf, startupHoldOver } from "../live/player/startup-hold.ts";
import { LL_STARTUP_RUNWAY_S, LL_TRIM_TICK_MS, lowLatencyForToken, lowLatencyHlsConfig, masterMode, newLowLatencyTrim, trimLowLatency } from "../player-shared/low-latency.ts";

function sendHLSBeat(g: number): void {
    void Promise.all([captchaQuery(), ensureViewerId(ctx.mediaBase, ctx.username)]).then(([tq, vid]) => {
        if (!isCurrent(g)) return;
        const url = `${ctx.mediaBase}/hls/${encodeURIComponent(ctx.username)}/beat?id=${encodeURIComponent(vid)}${tq}`;
        fetch(url, { method: "POST", credentials: "include" }).catch(() => {});
    });
}

let hlsBeaconTimer: number | null = null;

export function stopHLSBeacon(): void {
    if (hlsBeaconTimer !== null) {
        window.clearInterval(hlsBeaconTimer);
        hlsBeaconTimer = null;
    }
}

export function startHLSBeacon(g: number): void {
    stopHLSBeacon();
    const beat = () => {
        if (!isCurrent(g)) {
            stopHLSBeacon();
            return;
        }
        sendHLSBeat(g);
    };
    beat();
    hlsBeaconTimer = window.setInterval(beat, HLS_BEACON_INTERVAL_MS);
}

export function canUseNativeHLS(): boolean {
    return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

export function canUseHlsJs(): boolean {
    return Hls.isSupported();
}

let hlsInstance: Hls | null = null;

export function destroyHls(): void {
    if (hlsInstance) {
        try {
            hlsInstance.destroy();
        } catch {}
        hlsInstance = null;
    }
}

async function masterUrl(lowLatency: boolean): Promise<string> {
    const tq = await captchaQuery();
    return `${ctx.mediaBase}/hls/${encodeURIComponent(ctx.username)}/master.m3u8?${masterMode(lowLatency)}${tq}`;
}

function startNativeHLS(g: number, src: string): void {
    video.src = src;
    void video.play().catch(() => {});
    startHLSBeacon(g);
}

function startHlsJsPlayer(g: number, src: string, rttMs: number | null, primed: PrimedMaster | null): void {
    const tier = ctx.edgeServed ? "far" : latencyTierFor(rttMs, false);
    const hls = new Hls({
        ...(primed ? { pLoader: primedMasterLoader(Hls.DefaultConfig.loader, primed) } : {}),
        lowLatencyMode: false,
        abrEwmaDefaultEstimate: abrEstimateFor(tier),
        backBufferLength: 30,
        ...(tier === "far"
            ? { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8 }
            : tier === "near"
                ? { liveSyncDuration: 3.5, liveMaxLatencyDuration: 8 }
                : { liveSyncDuration: 5, liveMaxLatencyDuration: 12 }),
        maxLiveSyncPlaybackRate: 1,
        enableWorker: true,
        xhrSetup: (xhr, url) => {
            xhr.withCredentials = needsCredentials(url, ctx.mediaBase, location.origin);
        },
    });
    hlsInstance = hls;
    hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        if (data.details === Hls.ErrorDetails.BUFFER_FULL_ERROR) return;
        if (!data.fatal) return;
        restartAfterFailure(g);
    });
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        hls.loadSource(src);
    });
    hls.attachMedia(video);
    void video.play().catch(() => {});
    startHLSBeacon(g);
}

const EMBED_BACK_BUFFER_S = 30;

function startLowLatencyPlayer(g: number, src: string, primed: PrimedMaster | null): void {
    const hls = new Hls(lowLatencyHlsConfig(Hls.DefaultConfig.loader, primed, EMBED_BACK_BUFFER_S, (url) => needsCredentials(url, ctx.mediaBase, location.origin)));
    hlsInstance = hls;
    const trim = newLowLatencyTrim(Date.now());
    hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) trim.lastTargetChangeAt = Date.now();
        if (data.details === Hls.ErrorDetails.BUFFER_FULL_ERROR) return;
        if (!data.fatal) return;
        restartAfterFailure(g);
    });
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        hls.loadSource(src);
    });
    hls.attachMedia(video);
    const holdStarted = Date.now();
    const holdTimer = window.setInterval(() => {
        if (!isCurrent(g) || hlsInstance !== hls) {
            window.clearInterval(holdTimer);
            return;
        }
        const ranges: Array<{ start: number; end: number }> = [];
        for (let i = 0; i < video.buffered.length; i++) {
            ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
        }
        if (!startupHoldOver(bufferedAheadOf(ranges, video.currentTime), Date.now() - holdStarted, LL_STARTUP_RUNWAY_S)) return;
        window.clearInterval(holdTimer);
        void video.play().catch(() => {});
    }, 200);
    track(() => window.clearInterval(holdTimer));
    startHLSBeacon(g);
    const trimTimer = window.setInterval(() => {
        if (!isCurrent(g) || hlsInstance !== hls) {
            window.clearInterval(trimTimer);
            return;
        }
        if (!video.paused) trimLowLatency(hls, video, trim, Date.now());
    }, LL_TRIM_TICK_MS);
    track(() => window.clearInterval(trimTimer));
}

export function startHLSTransport(g: number): void {
    attachVideoFailureListeners(g);

    const onPlaying = () => {
        if (!isCurrent(g)) return;
        resetRetryBackoff();
        setPlaying();
    };
    const onEnded = () => {
        if (!isCurrent(g)) return;
        goOffline(g);
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("ended", onEnded);
    track(() => video.removeEventListener("playing", onPlaying));
    track(() => video.removeEventListener("ended", onEnded));

    void getCaptchaToken().then(async (token) => {
        if (!isCurrent(g)) return;
        const lowLatency = lowLatencyForToken(token || null, ctx.edgeServed);
        const src = await masterUrl(lowLatency);
        if (!isCurrent(g)) return;
        if (ctx.transportKind === "hls-native") {
            startNativeHLS(g, src);
            return;
        }
        let primed: PrimedMaster | null = null;
        try {
            const res = await fetch(src, { credentials: "include" });
            const body = await res.text();
            if (res.ok && body) primed = { url: res.url || src, text: body };
        } catch {}
        if (!isCurrent(g)) return;
        if (lowLatency) {
            startLowLatencyPlayer(g, src, primed);
            return;
        }
        let rttMs = primed ? rttFromTiming(resourceTimingOf(src)) : null;
        if (needsRttFetch("standard", ctx.edgeServed, rttMs)) {
            try {
                const t0 = performance.now();
                await fetch(src, { credentials: "include" });
                rttMs = performance.now() - t0;
            } catch {}
            if (!isCurrent(g)) return;
        }
        startHlsJsPlayer(g, src, rttMs, primed);
    });
}
