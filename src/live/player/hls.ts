import { segmentPrefetchLoader } from "./segment-prefetch.ts";
import Hls from "hls.js";
import { video } from "../dom.ts";
import { ctx, isCurrent, track } from "./context.ts";
import { HLS_BEACON_INTERVAL_MS, HLS_QUALITY_STORAGE_KEY, LOW_LATENCY_STORAGE_KEY, PAUSE_SUSPEND_MS, PRUNE_KEEP_S, WAITING_STALL_MS } from "../constants.ts";
import { readLocalStorage } from "../../storage.ts";
import { ensureViewerId } from "../../player-shared/viewer-id.ts";
import { needsCredentials } from "../../player-shared/needs-credentials.ts";
import { beatUrl, beatVariants, ladderGrew, newLadderWatch } from "../../player-shared/hls-beat.ts";
import { loadSourceOnce } from "../../player-shared/source-once.ts";
import { captchaQuery } from "../../captcha.ts";
import { beginTransport, fullTeardown, goOffline, resetRetryBackoff, restartAfterFailure, setPoster, setState, suspendForPause } from "./lifecycle.ts";
import { closeQualityUpsell, enterQualityLockedTerminal } from "../quality-upsell.ts";
import { attachVideoFailureListeners, setStallGraceMs, stallDriftSnap } from "./health.ts";
import { renderQualityMenu } from "../quality-menu.ts";
import { parseLockedVariants, streamQualityText } from "../../quality.ts";
import { isPhoneUA, type LatencyWindow } from "./latency-window.ts";
import { lowLatencyStallGraceMs } from "./far-tier.ts";
import { plainHlsTuning, plainLevelWindow, plainPlayerSetup } from "./plain-setup.ts";
import { edgeLowLatencyReprobeMs, edgeLowLatencyUpgrade, edgeReprobeDue, partsTransition, watchesEdgeLowLatencyOffer, type ReprobeView } from "./edge-low-latency.ts";
import { bufferedAheadOf, STARTUP_RUNWAY_S, startupHoldOver } from "./startup-hold.ts";
import { updateSeekBar } from "../seekbar.ts";
import { LL_STARTUP_RUNWAY_S, lowLatencyChosen, lowLatencyHlsConfig, lowLatencyRequested, masterMode, newLowLatencyTrim, trimLowLatency } from "../../player-shared/low-latency.ts";
import { browserResourceTimingEnv, FAILED_PROBE, needsRttFetch, primedMasterLoader, probeOutcome, RESOURCE_TIMING_WAIT_MS, rttFromTiming, startPathFor, watchResourceTiming, type PrimedMaster } from "./master-probe.ts";

export interface HlsLevelEntry {
    index: number;
    label: string;
}

function sendHLSBeat(g: number): void {
    void Promise.all([captchaQuery(), ensureViewerId(ctx.mediaBase, ctx.username)]).then(async ([tq, vid]) => {
        if (!isCurrent(g)) return;
        const res = await fetch(beatUrl(ctx.mediaBase, ctx.username, vid, tq), { method: "POST", credentials: "include" });
        const variants = beatVariants(res.status, await res.text());
        if (!isCurrent(g)) return;
        if (hlsInstance && ladderGrew(ladderWatch, variants, video.paused)) beginTransport();
    }).catch(() => {});
}

const ladderWatch = newLadderWatch();

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

let hlsInstance: Hls | null = null;
let hlsLevelEntries: HlsLevelEntry[] = [];

export function destroyHls(): void {
    if (hlsInstance) {
        try {
            hlsInstance.destroy();
        } catch {}
        hlsInstance = null;
    }
    hlsLevelEntries = [];
    ladderWatch.master = null;
}

export function hlsLevels(): HlsLevelEntry[] {
    return hlsLevelEntries;
}

export function hlsAutoEnabled(): boolean {
    return hlsInstance ? hlsInstance.autoLevelEnabled : true;
}

export function hlsCurrentLevel(): number {
    return hlsInstance ? hlsInstance.currentLevel : -1;
}

export function hlsLevelLabel(): string {
    if (!hlsInstance || hlsAutoEnabled()) return "Auto";
    const entry = hlsLevelEntries.find((e) => e.index === hlsInstance!.currentLevel);
    return entry ? entry.label : "Auto";
}

export function setHlsLevel(index: number): void {
    if (!hlsInstance) return;
    hlsInstance.currentLevel = index;
    renderQualityMenu();
}

export function hlsLiveSyncPosition(): number | null {
    return hlsInstance ? hlsInstance.liveSyncPosition : null;
}

export function stopHlsLoad(): boolean {
    if (!hlsInstance) return false;
    try {
        hlsInstance.stopLoad();
    } catch {}
    return true;
}

export function resumeHlsLoad(): void {
    if (!hlsInstance) return;
    try {
        hlsInstance.startLoad();
    } catch {}
}

export function recoverHlsMedia(): boolean {
    if (!hlsInstance) return false;
    try {
        hlsInstance.recoverMediaError();
    } catch {
        return false;
    }
    return true;
}

function withCaptchaHint<T>(g: number, p: Promise<T>): Promise<T> {
    const t = window.setTimeout(() => {
        if (isCurrent(g) && !ctx.terminal) setPoster("Checking access", false, true);
    }, 300);
    return p.finally(() => window.clearTimeout(t));
}

export function lowLatencyAvailable(): boolean {
    return lowLatencyRequested(ctx.lowLatencyEntitled, ctx.edgeServed, ctx.transportKind === "hls-native");
}

export function lowLatencyPreferred(): boolean {
    return readLocalStorage(LOW_LATENCY_STORAGE_KEY) !== "0";
}

export function lowLatencyWanted(): boolean {
    return lowLatencyAvailable() && lowLatencyPreferred();
}

async function buildMasterUrl(lowLatency: boolean): Promise<string> {
    const tq = await captchaQuery();
    return `${ctx.mediaBase}/hls/${encodeURIComponent(ctx.username)}/master.m3u8?${masterMode(lowLatency)}${tq}`;
}

function reprobeView(): ReprobeView {
    return { paused: video.paused, behindLive: ctx.behindLive, visible: document.visibilityState === "visible" };
}

function watchEdgeLowLatencyOffer(g: number, hls: Hls): void {
    let attempt = 0;
    let timer: number | null = null;
    const live = () => isCurrent(g) && hlsInstance === hls;
    const schedule = () => {
        timer = window.setTimeout(probe, edgeLowLatencyReprobeMs(attempt));
        attempt += 1;
    };
    const probe = () => {
        timer = null;
        if (!live()) return;
        if (!edgeReprobeDue(reprobeView()) || !ctx.edgeServed || !lowLatencyWanted()) {
            schedule();
            return;
        }
        void buildMasterUrl(true)
            .then((url) => fetch(url, { credentials: "include" }))
            .then((res) => (res.ok ? res.text() : ""))
            .catch(() => "")
            .then((body) => {
                if (!live()) return;
                if (!edgeLowLatencyUpgrade(body, reprobeView())) {
                    schedule();
                    return;
                }
                console.log("live: edge now offers low latency, switching to the parts playlist");
                beginTransport();
            });
    };
    schedule();
    track(() => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
    });
}

function watchEdgeParts(g: number, hls: Hls): void {
    let hadParts: boolean | null = null;
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        const hasParts = (data.details.partList?.length ?? 0) > 0;
        const change = partsTransition(hadParts, hasParts);
        hadParts = hasParts;
        if (change === "withdrawn") console.log("live: edge withdrew low latency, playing its plain playlist on the same url");
        if (change === "restored") console.log("live: edge restored low latency parts");
    });
}

function startLowLatencyPlayer(g: number, src: string, primed: PrimedMaster | null, edgeServed: boolean): void {
    console.log(edgeServed ? "live: hls low latency, parts playlist and media via the edge's zone" : "live: hls low latency, parts playlist and media via the region's cdn zone");
    setStallGraceMs(lowLatencyStallGraceMs(edgeServed, WAITING_STALL_MS));
    const hls = new Hls(lowLatencyHlsConfig(Hls.DefaultConfig.loader, primed, PRUNE_KEEP_S, (url) => needsCredentials(url, ctx.mediaBase, location.origin)));
    hlsInstance = hls;
    hlsLevelEntries = [];
    watchMasterLadder(g, hls);
    if (edgeServed) watchEdgeParts(g, hls);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        hlsLevelEntries = hls.levels.map((level, index) => ({
            index,
            label: streamQualityText(level.width ?? 0, level.height ?? 0, level.frameRate ?? 0),
        }));
        applyPreferredLevel(hls);
        renderQualityMenu();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        renderQualityMenu();
    });
    const trim = newLowLatencyTrim(Date.now());
    hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) trim.lastTargetChangeAt = Date.now();
        if (data.details === Hls.ErrorDetails.BUFFER_FULL_ERROR) return;
        if (!data.fatal) return;
        console.warn("live: hls.js fatal error, restarting", data);
        restartAfterFailure(g);
    });
    hls.on(Hls.Events.MEDIA_ATTACHED, loadSourceOnce(hls, src, () => isCurrent(g) && hlsInstance === hls));
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
    const dvrTimer = window.setInterval(() => {
        if (!isCurrent(g) || hlsInstance !== hls) {
            window.clearInterval(dvrTimer);
            return;
        }
        if (video.paused && Date.now() - ctx.lastProgressAt > PAUSE_SUSPEND_MS) suspendForPause();
        if (!video.paused && !ctx.behindLive && trimLowLatency(hls, video, trim, Date.now())) stallDriftSnap();
        updateSeekBar();
    }, HLS_DVR_TICK_MS);
    track(() => window.clearInterval(dvrTimer));
}

function watchMasterLadder(g: number, hls: Hls): void {
    hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        ladderWatch.master = data.levels.length;
    });
}

function applyPreferredLevel(hls: Hls): void {
    const preferred = readLocalStorage(HLS_QUALITY_STORAGE_KEY);
    if (!preferred) return;
    const match = hlsLevelEntries.find((entry) => entry.label === preferred);
    if (match) hls.currentLevel = match.index;
}

function wireVideoLifecycle(g: number): void {
    const onPlaying = () => {
        if (!isCurrent(g)) return;
        resetRetryBackoff();
        setState("playing");
        renderQualityMenu();
    };
    const onEnded = () => {
        if (!isCurrent(g)) return;
        console.log("live: stream ended, waiting for next");
        fullTeardown();
        goOffline(g);
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("ended", onEnded);
    track(() => video.removeEventListener("playing", onPlaying));
    track(() => video.removeEventListener("ended", onEnded));
}

function startNativeHLS(g: number, src: string): void {
    video.src = src;
    void video.play().catch(() => {});
    startHLSBeacon(g);
    const uiTimer = window.setInterval(() => {
        if (!isCurrent(g)) {
            window.clearInterval(uiTimer);
            return;
        }
        updateSeekBar();
    }, HLS_DVR_TICK_MS);
    track(() => window.clearInterval(uiTimer));
}

const HLS_DVR_TICK_MS = 500;

function isPhone(): boolean {
    const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
    return isPhoneUA(navigator.userAgent, typeof uaData?.mobile === "boolean" ? uaData.mobile : null);
}

function startHlsJsPlayer(g: number, src: string, originLL: boolean, rttMs: number | null, primed: PrimedMaster | null, watchEdgeOffer: boolean): void {
    const phone = isPhone();
    const edgeServed = ctx.edgeServed;
    const setup = plainPlayerSetup(edgeServed, rttMs, originLL, phone, WAITING_STALL_MS, STARTUP_RUNWAY_S);
    const tier = setup.tier;
    console.log("live: hls latency tier", tier, rttMs === null ? "unmeasured" : `${Math.round(rttMs)}ms`, phone ? "phone" : "desktop", edgeServed ? "edge" : "origin");
    setStallGraceMs(setup.graceMs);
    const startupRunwayS = setup.startupRunwayS;
    let normalLiveWindow: LatencyWindow = setup.window;
    let dvrHoldActive = false;
    const prefetch = segmentPrefetchLoader(Hls.DefaultConfig.loader);
    track(prefetch.clear);
    const hls = new Hls({
        loader: prefetch.loader,
        ...(primed ? { pLoader: primedMasterLoader(prefetch.loader, primed) } : {}),
        ...plainHlsTuning(setup, PRUNE_KEEP_S),
        xhrSetup: (xhr, url) => {
            xhr.withCredentials = needsCredentials(url, ctx.mediaBase, location.origin);
        },
    });
    hlsInstance = hls;
    hlsLevelEntries = [];
    const applyLiveWindow = (target: LatencyWindow): void => {
        hls.config.liveSyncDuration = target.sync;
        hls.config.liveMaxLatencyDuration = target.max;
    };
    watchMasterLadder(g, hls);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        hlsLevelEntries = hls.levels.map((level, index) => ({
            index,
            label: streamQualityText(level.width ?? 0, level.height ?? 0, level.frameRate ?? 0),
        }));
        applyPreferredLevel(hls);
        renderQualityMenu();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        renderQualityMenu();
    });
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        if (data.details.live === false) {
            console.log("live: playlist is finalized, playing out remaining media");
            return;
        }
        const target = plainLevelWindow(edgeServed, tier, data.details, ctx.mediaBase);
        if (normalLiveWindow.sync !== target.sync || normalLiveWindow.max !== target.max) {
            normalLiveWindow = target;
            if (!dvrHoldActive) applyLiveWindow(target);
        }
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!isCurrent(g) || hlsInstance !== hls) return;
        if (data.details === Hls.ErrorDetails.BUFFER_FULL_ERROR) return;
        if (!data.fatal) return;
        console.warn("live: hls.js fatal error, restarting", data);
        restartAfterFailure(g);
    });
    hls.on(Hls.Events.MEDIA_ATTACHED, loadSourceOnce(hls, src, () => isCurrent(g) && hlsInstance === hls));
    hls.attachMedia(video);
    if (watchEdgeOffer) watchEdgeLowLatencyOffer(g, hls);
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
        if (!startupHoldOver(bufferedAheadOf(ranges, video.currentTime), Date.now() - holdStarted, startupRunwayS)) return;
        window.clearInterval(holdTimer);
        void video.play().catch(() => {});
    }, 200);
    track(() => window.clearInterval(holdTimer));
    startHLSBeacon(g);
    const dvrTimer = window.setInterval(() => {
        if (!isCurrent(g) || hlsInstance !== hls) {
            window.clearInterval(dvrTimer);
            return;
        }
        if (video.paused && Date.now() - ctx.lastProgressAt > PAUSE_SUSPEND_MS) suspendForPause();
        const hold = ctx.behindLive || video.paused;
        if (hold !== dvrHoldActive) {
            dvrHoldActive = hold;
            applyLiveWindow(dvrHoldActive ? { sync: normalLiveWindow.sync, max: PRUNE_KEEP_S } : normalLiveWindow);
        }
        updateSeekBar();
    }, HLS_DVR_TICK_MS);
    track(() => window.clearInterval(dvrTimer));
}

export function startHLSTransport(g: number): void {
    attachVideoFailureListeners(g);
    closeQualityUpsell();
    wireVideoLifecycle(g);
    if (ctx.state !== "offline") setState("buffering");
    const requested = lowLatencyWanted();
    const edgeServed = ctx.edgeServed;
    void withCaptchaHint(g, buildMasterUrl(requested)).then(async (src) => {
        if (!isCurrent(g)) return;
        let probe = FAILED_PROBE;
        let primed: PrimedMaster | null = null;
        let masterBody = "";
        const probeTiming = watchResourceTiming(performance.now(), browserResourceTimingEnv(src));
        try {
            const res = await fetch(src, { credentials: "include" });
            const body = await res.text().catch(() => "");
            probe = probeOutcome(res.status, body);
            if (probe.playable) {
                masterBody = body;
                ctx.lockedQualities = parseLockedVariants(body);
                if (body) primed = { url: res.url || src, text: body };
            }
        } catch {}
        if (!isCurrent(g)) {
            probeTiming.stop();
            return;
        }
        const chosen = lowLatencyChosen(requested, edgeServed, masterBody);
        const path = startPathFor(probe, ctx.transportKind === "hls-native", chosen);
        if (path !== "standard") probeTiming.stop();
        if (path === "quality-locked") {
            enterQualityLockedTerminal();
            return;
        }
        if (path === "offline") {
            goOffline(g);
            return;
        }
        if (path === "native") {
            startNativeHLS(g, src);
            return;
        }
        if (path === "low-latency") {
            startLowLatencyPlayer(g, src, primed, edgeServed);
            return;
        }
        let rttMs = primed ? rttFromTiming(await probeTiming.settle(RESOURCE_TIMING_WAIT_MS)) : null;
        probeTiming.stop();
        if (!isCurrent(g)) return;
        if (needsRttFetch(path, ctx.edgeServed, rttMs)) {
            try {
                const t0 = performance.now();
                await fetch(src, { credentials: "include" });
                rttMs = performance.now() - t0;
            } catch {}
            if (!isCurrent(g)) return;
        }
        startHlsJsPlayer(g, src, probe.originLL, rttMs, primed, watchesEdgeLowLatencyOffer(requested, edgeServed, chosen));
    });
}
