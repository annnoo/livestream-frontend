import { recoveryDeadlineMs } from "./recovery-deadline.ts";
import { video } from "../dom.ts";
import { ctx, isCurrent, track } from "./context.ts";
import { HEALTH_CHECK_INTERVAL_MS, HEALTH_STALE_MS, HEALTH_STUCK_MS, WAITING_STALL_MS } from "../constants.ts";
import { beginTransport, clearRetryTimer, restartAfterFailure } from "./lifecycle.ts";
import { hlsLiveSyncPosition, recoverHlsMedia, resumeHlsLoad } from "./hls.ts";
import { mediaErrorStep, nextStallCheckMs, nudgeSeekTarget, stallEpisodeOnPlaying, stallEpisodeOnWaiting, stallLadder, stallRecovered, stallStepDue, stallTeardownMs, type StallEpisode, type StallRung, type StallStep } from "./stall-escalation.ts";

let waitingTimer: number | null = null;
let stallGraceMs = WAITING_STALL_MS;
let stallEpisode: StallEpisode | null = null;
let lastMediaRecoveryAt = Number.NEGATIVE_INFINITY;

export function setStallGraceMs(ms: number): void {
    stallGraceMs = ms;
}

export function resetStallGraceMs(): void {
    stallGraceMs = WAITING_STALL_MS;
}

export function clearWaitingTimer(): void {
    if (waitingTimer !== null) {
        window.clearTimeout(waitingTimer);
        waitingTimer = null;
    }
    stallEpisode = null;
}

function hlsJsActive(): boolean {
    return ctx.transportKind === "hls-js";
}

function currentStallLadder(): StallRung[] {
    return stallLadder(stallGraceMs, hlsJsActive());
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

function recoverMedia(): boolean {
    const wasPaused = video.paused;
    if (!recoverHlsMedia()) return false;
    lastMediaRecoveryAt = Date.now();
    if (!wasPaused) void video.play().catch(() => {});
    return true;
}

function applyStallStep(g: number, step: StallStep): void {
    if (step === "reload") {
        console.log("live: stalled, restarting hls loading");
        ctx.pauseSuspended = false;
        resumeHlsLoad();
        const target = nudgeSeekTarget(video.currentTime, hlsLiveSyncPosition(), bufferedRanges(), ctx.behindLive);
        if (target !== null) video.currentTime = target;
        return;
    }
    if (step === "recover-media" && recoverMedia()) {
        console.warn("live: still stalled, recovering media");
        return;
    }
    console.warn("live: stall did not recover, restarting");
    restartAfterFailure(g);
}

function scheduleStallCheck(g: number): void {
    const episode = stallEpisode;
    if (!episode || waitingTimer !== null) return;
    const delay = nextStallCheckMs(currentStallLadder(), Date.now() - episode.startedAt, episode.taken);
    if (delay === null) return;
    waitingTimer = window.setTimeout(() => {
        waitingTimer = null;
        runStallCheck(g);
    }, delay);
}

function runStallCheck(g: number): void {
    if (!isCurrent(g)) return;
    const episode = stallEpisode;
    if (!episode) return;
    if (stallRecovered(Date.now() - ctx.lastProgressAt, video.paused)) {
        stallEpisode = null;
        return;
    }
    const due = stallStepDue(currentStallLadder(), Date.now() - episode.startedAt, episode.taken);
    if (due) {
        episode.taken = due.taken;
        applyStallStep(g, due.step);
    }
    if (isCurrent(g) && stallEpisode === episode) scheduleStallCheck(g);
}

export function attachVideoFailureListeners(g: number): void {
    const onError = () => {
        if (!isCurrent(g)) return;
        if (mediaErrorStep(hlsJsActive(), Date.now() - lastMediaRecoveryAt) === "recover-media" && recoverMedia()) {
            console.warn("live: video error, recovering media");
            return;
        }
        console.warn("live: video error, restarting");
        restartAfterFailure(g);
    };
    const onWaiting = () => {
        if (!isCurrent(g)) return;
        const episode = stallEpisodeOnWaiting(stallEpisode, Date.now(), ctx.lastProgressAt);
        if (episode !== stallEpisode) {
            clearWaitingTimer();
            stallEpisode = episode;
        }
        scheduleStallCheck(g);
    };
    const onPlaying = () => {
        if (!isCurrent(g)) return;
        stallEpisodeOnPlaying(stallEpisode, Date.now());
    };

    video.addEventListener("error", onError);
    video.addEventListener("stalled", onWaiting);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);

    track(() => video.removeEventListener("error", onError));
    track(() => video.removeEventListener("stalled", onWaiting));
    track(() => video.removeEventListener("waiting", onWaiting));
    track(() => video.removeEventListener("playing", onPlaying));
    track(clearWaitingTimer);
}
