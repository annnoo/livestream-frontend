import { recoveryDeadlineMs } from "./recovery-deadline.ts";
import { video } from "../dom.ts";
import { ctx, isCurrent, track } from "./context.ts";
import { HEALTH_CHECK_INTERVAL_MS, HEALTH_STALE_MS, HEALTH_STUCK_MS, WAITING_STALL_MS } from "../constants.ts";
import { beginTransport, clearRetryTimer, restartAfterFailure } from "./lifecycle.ts";
import { hlsLiveSyncPosition, recoverHlsMedia, resumeHlsLoad } from "./hls.ts";
import { nudgeSeekTarget, stallTeardownMs } from "./stall-escalation.ts";
import { newStallMachine, stallInput, stallOwnsPlayhead, type LiveView, type StallAction, type StallEvent } from "./stall-machine.ts";

let stallTimer: number | null = null;
let stallGraceMs = WAITING_STALL_MS;
let stallMachine = newStallMachine(true);
let stallGen: number | null = null;

export function setStallGraceMs(ms: number): void {
    stallGraceMs = ms;
}

export function resetStallGraceMs(): void {
    stallGraceMs = WAITING_STALL_MS;
}

function cancelStallTimer(): void {
    if (stallTimer === null) return;
    window.clearTimeout(stallTimer);
    stallTimer = null;
}

export function clearWaitingTimer(): void {
    cancelStallTimer();
    stallMachine = newStallMachine(video.paused, stallMachine.mediaRecoveredAt);
}

function hlsJsActive(): boolean {
    return ctx.transportKind === "hls-js";
}

export function healthRestart(reason: string): void {
    if (ctx.terminal) return;
    console.log("live: health check restart:", reason);
    clearRetryTimer();
    beginTransport();
}

export function healthCheck(): void {
    if (ctx.terminal) return;
    const now = Date.now();
    if (ctx.state === "playing") {
        if (video.paused) return;
        const staleDeadline = recoveryDeadlineMs(HEALTH_STALE_MS, stallTeardownMs(stallGraceMs, hlsJsActive()));
        const progressStale = !video.paused && now - ctx.lastProgressAt > staleDeadline;
        if (progressStale) healthRestart("stale-playing");
        return;
    }
    const awaitingTransport = ctx.state === "connecting"
        || ctx.state === "buffering"
        || ctx.state === "reconnecting"
        || (ctx.state === "offline" && ctx.startedOnce);
    if (awaitingTransport && now - ctx.lastStateChangeAt > recoveryDeadlineMs(HEALTH_STUCK_MS, stallGraceMs)) healthRestart(`stuck-${ctx.state}`);
}

let healthTimer: number | null = null;

export function startHealthTimer(): void {
    if (healthTimer !== null) return;
    healthTimer = window.setInterval(() => {
        if (document.visibilityState === "visible") healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
}

export function stopHealthTimer(): void {
    if (healthTimer === null) return;
    window.clearInterval(healthTimer);
    healthTimer = null;
}

function bufferedRanges(): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < video.buffered.length; i++) {
        ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
    }
    return ranges;
}

function liveView(): LiveView {
    return { currentTime: video.currentTime, syncPosition: hlsLiveSyncPosition(), ranges: bufferedRanges(), behindLive: ctx.behindLive };
}

function feedStall(g: number, event: StallEvent): void {
    if (!isCurrent(g)) return;
    const actions = stallInput(stallMachine, { graceMs: stallGraceMs, hlsJs: hlsJsActive() }, event);
    for (const action of actions) {
        if (!isCurrent(g)) return;
        carryStallAction(g, action);
    }
}

function carryStallAction(g: number, action: StallAction): void {
    switch (action.kind) {
        case "arm":
            cancelStallTimer();
            stallTimer = window.setTimeout(() => {
                stallTimer = null;
                feedStall(g, { kind: "timer", now: Date.now() });
            }, action.ms);
            return;
        case "disarm":
            cancelStallTimer();
            return;
        case "reload": {
            console.log("live: stalled, restarting hls loading");
            ctx.pauseSuspended = false;
            resumeHlsLoad();
            const target = nudgeSeekTarget(video.currentTime, hlsLiveSyncPosition(), bufferedRanges(), ctx.behindLive);
            if (target !== null) video.currentTime = target;
            return;
        }
        case "recover-media": {
            const wasPaused = video.paused;
            if (!recoverHlsMedia()) {
                feedStall(g, { kind: "media-recovery-failed", now: Date.now() });
                return;
            }
            console.warn(action.cause === "stall" ? "live: still stalled, recovering media" : "live: video error, recovering media");
            if (!wasPaused) void video.play().catch(() => {});
            feedStall(g, { kind: "media-recovered", now: Date.now() });
            return;
        }
        case "teardown":
            console.warn(action.cause === "stall" ? "live: stall did not recover, restarting" : "live: video error, restarting");
            restartAfterFailure(g);
            return;
        case "seek-live":
            console.log("live: media recovered", (action.to - video.currentTime).toFixed(1), "s behind, seeking to live");
            video.currentTime = action.to;
            return;
        case "close":
            return;
    }
}

function feedCurrentStall(kind: "seek" | "go-live" | "drift-snap"): void {
    if (stallGen !== null) feedStall(stallGen, { kind, now: Date.now() });
}

export function stallUserSeek(): void {
    feedCurrentStall("seek");
}

export function stallGoLive(): void {
    feedCurrentStall("go-live");
}

export function stallDriftSnap(): void {
    feedCurrentStall("drift-snap");
}

export function stallRecoveryOwnsPlayhead(): boolean {
    return stallOwnsPlayhead(stallMachine, Date.now());
}

export function attachVideoFailureListeners(g: number): void {
    clearWaitingTimer();
    stallGen = g;
    let observedTime = video.currentTime;
    const onError = () => feedStall(g, { kind: "error", now: Date.now() });
    const onWaiting = () => feedStall(g, { kind: "waiting", now: Date.now() });
    const onPlaying = () => feedStall(g, { kind: "playing", now: Date.now() });
    const onPause = () => feedStall(g, { kind: "pause", now: Date.now() });
    const onPlay = () => feedStall(g, { kind: "play", now: Date.now() });
    const onTimeUpdate = () => {
        if (Math.abs(video.currentTime - observedTime) <= 0.01) return;
        observedTime = video.currentTime;
        feedStall(g, { kind: "progress", now: Date.now(), view: liveView() });
    };
    const listeners: Array<[string, () => void]> = [
        ["error", onError],
        ["stalled", onWaiting],
        ["waiting", onWaiting],
        ["playing", onPlaying],
        ["pause", onPause],
        ["play", onPlay],
        ["timeupdate", onTimeUpdate],
    ];
    for (const [type, listener] of listeners) {
        video.addEventListener(type, listener);
        track(() => video.removeEventListener(type, listener));
    }
    track(clearWaitingTimer);
}
