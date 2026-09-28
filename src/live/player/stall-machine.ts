import { mediaErrorStep, RECOVERY_LIVE_SEEK_WINDOW_MS, recoveryLiveSeek, stallLadder, type StallRung } from "./stall-escalation.ts";

export const STALL_RECHECK_MS = 2000;
export const STALL_FRESH_PROGRESS_MS = 1000;
export const OWN_ACTION_SETTLE_MS = 500;

export interface StallConfig {
    graceMs: number;
    hlsJs: boolean;
}

export interface LiveView {
    currentTime: number;
    syncPosition: number | null;
    ranges: Array<{ start: number; end: number }>;
    behindLive: boolean;
}

export type StallCause = "stall" | "error";

export type StallEvent =
    | { kind: "waiting"; now: number }
    | { kind: "playing"; now: number }
    | { kind: "progress"; now: number; view: LiveView }
    | { kind: "pause"; now: number }
    | { kind: "play"; now: number }
    | { kind: "seek"; now: number }
    | { kind: "go-live"; now: number }
    | { kind: "drift-snap"; now: number }
    | { kind: "timer"; now: number }
    | { kind: "error"; now: number }
    | { kind: "media-recovered"; now: number }
    | { kind: "media-recovery-failed"; now: number };

export type StallAction =
    | { kind: "arm"; ms: number }
    | { kind: "disarm" }
    | { kind: "reload" }
    | { kind: "recover-media"; cause: StallCause }
    | { kind: "teardown"; cause: StallCause }
    | { kind: "seek-live"; to: number }
    | { kind: "close" };

const CLOSING_EVENTS: ReadonlySet<StallEvent["kind"]> = new Set(["pause", "play", "seek", "go-live", "drift-snap"]);

export interface StallEpisode {
    startedAt: number;
    taken: number;
    stepAt: number;
    since: number;
    confirmed: boolean;
}

export type StallPhase =
    | { kind: "idle" }
    | ({ kind: "stalled" } & StallEpisode)
    | ({ kind: "resumed" } & StallEpisode);

export interface StallMachine {
    phase: StallPhase;
    paused: boolean;
    progressAt: number;
    ownSeekAt: number;
    liveSeekAt: number;
    recoverAt: number;
    mediaRecoveredAt: number;
    liveSeekUntil: number | null;
    recovering: StallCause | null;
    timerAt: number | null;
}

export function newStallMachine(paused: boolean, mediaRecoveredAt = Number.NEGATIVE_INFINITY): StallMachine {
    return {
        phase: { kind: "idle" },
        paused,
        progressAt: Number.NEGATIVE_INFINITY,
        ownSeekAt: Number.NEGATIVE_INFINITY,
        liveSeekAt: Number.NEGATIVE_INFINITY,
        recoverAt: Number.NEGATIVE_INFINITY,
        mediaRecoveredAt,
        liveSeekUntil: null,
        recovering: null,
        timerAt: null,
    };
}

export function stallEpisodeOpen(m: StallMachine): boolean {
    return m.phase.kind !== "idle";
}

export function stallDeadline(m: StallMachine, ladder: StallRung[]): number | null {
    const phase = m.phase;
    if (phase.kind === "idle") return null;
    if (phase.kind === "resumed") return phase.since + STALL_RECHECK_MS;
    return nextRungAt(ladder, phase);
}

function nextRungAt(ladder: StallRung[], episode: StallEpisode): number {
    const rung = ladder[Math.min(episode.taken, ladder.length - 1)];
    if (episode.taken === 0) return episode.startedAt + rung.atMs;
    const gap = rung.atMs - ladder[episode.taken - 1].atMs;
    return Math.max(episode.startedAt + rung.atMs, episode.stepAt + gap);
}

function freshSince(m: StallMachine, now: number, since: number): boolean {
    return m.progressAt > since && now - m.progressAt < STALL_FRESH_PROGRESS_MS;
}

function stallConfirmed(episode: StallEpisode): boolean {
    return episode.confirmed || episode.taken > 0;
}

function supersedesEpisode(m: StallMachine, episode: StallEpisode, now: number): boolean {
    if (now - m.liveSeekAt < OWN_ACTION_SETTLE_MS) return true;
    return !stallConfirmed(episode) && freshSince(m, now, episode.startedAt);
}

function close(m: StallMachine, out: StallAction[]): void {
    if (m.phase.kind === "idle") return;
    m.phase = { kind: "idle" };
    out.push({ kind: "close" });
}

function teardown(m: StallMachine, cause: StallCause, out: StallAction[]): void {
    m.phase = { kind: "idle" };
    m.liveSeekUntil = null;
    m.recovering = null;
    out.push({ kind: "teardown", cause });
}

function takeStep(m: StallMachine, ladder: StallRung[], episode: StallEpisode, now: number, out: StallAction[]): void {
    const rung = ladder[episode.taken];
    episode.taken += 1;
    episode.stepAt = now;
    episode.since = now;
    m.ownSeekAt = now;
    if (rung.step === "teardown") {
        teardown(m, "stall", out);
        return;
    }
    if (rung.step === "reload") {
        out.push({ kind: "reload" });
        return;
    }
    m.recovering = "stall";
    m.recoverAt = now;
    out.push({ kind: "recover-media", cause: "stall" });
}

function evaluate(m: StallMachine, ladder: StallRung[], now: number, out: StallAction[]): void {
    const phase = m.phase;
    if (phase.kind === "idle") return;
    if (m.paused) {
        close(m, out);
        return;
    }
    if (phase.kind === "resumed") {
        if (now < phase.since + STALL_RECHECK_MS) return;
        if (now - m.progressAt < STALL_FRESH_PROGRESS_MS) {
            close(m, out);
            return;
        }
        m.phase = { ...phase, kind: "stalled", since: now };
        evaluate(m, ladder, now, out);
        return;
    }
    if (!stallConfirmed(phase)) {
        if (freshSince(m, now, phase.startedAt)) {
            close(m, out);
            return;
        }
    } else if (freshSince(m, now, phase.since)) {
        m.phase = { ...phase, kind: "resumed", since: now };
        return;
    }
    if (now >= nextRungAt(ladder, phase)) takeStep(m, ladder, phase, now, out);
}

function checkLiveSeek(m: StallMachine, view: LiveView, now: number, out: StallAction[]): void {
    if (m.liveSeekUntil === null) return;
    if (m.paused || now > m.liveSeekUntil) {
        m.liveSeekUntil = null;
        return;
    }
    const decision = recoveryLiveSeek({ ...view, paused: m.paused });
    if (decision.kind === "wait") return;
    m.liveSeekUntil = null;
    if (decision.kind === "seek") {
        m.ownSeekAt = now;
        m.liveSeekAt = now;
        out.push({ kind: "seek-live", to: decision.to });
    }
}

function apply(m: StallMachine, ladder: StallRung[], cfg: StallConfig, ev: StallEvent, out: StallAction[]): void {
    const now = ev.now;
    switch (ev.kind) {
        case "waiting": {
            if (m.paused) return;
            if (m.phase.kind !== "idle" && supersedesEpisode(m, m.phase, now)) close(m, out);
            const phase = m.phase;
            if (phase.kind === "idle") {
                m.phase = { kind: "stalled", startedAt: now, taken: 0, stepAt: now, since: now, confirmed: false };
            } else if (phase.kind === "resumed") {
                m.phase = { ...phase, kind: "stalled", since: now };
            }
            evaluate(m, ladder, now, out);
            return;
        }
        case "playing": {
            const phase = m.phase;
            if (phase.kind === "stalled") m.phase = { ...phase, kind: "resumed", since: now, confirmed: true };
            return;
        }
        case "progress":
            checkLiveSeek(m, ev.view, now, out);
            return;
        case "pause":
            m.paused = true;
            if (now - m.recoverAt < OWN_ACTION_SETTLE_MS) return;
            m.liveSeekUntil = null;
            close(m, out);
            return;
        case "play":
            m.paused = false;
            if (now - m.recoverAt >= OWN_ACTION_SETTLE_MS) close(m, out);
            return;
        case "seek":
        case "go-live":
        case "drift-snap":
            m.liveSeekUntil = null;
            close(m, out);
            return;
        case "timer":
            evaluate(m, ladder, now, out);
            return;
        case "error":
            if (mediaErrorStep(cfg.hlsJs, now - m.mediaRecoveredAt) === "recover-media") {
                m.recovering = "error";
                m.recoverAt = now;
                out.push({ kind: "recover-media", cause: "error" });
                return;
            }
            teardown(m, "error", out);
            return;
        case "media-recovered":
            m.mediaRecoveredAt = now;
            m.ownSeekAt = now;
            m.recovering = null;
            m.liveSeekUntil = m.paused ? null : now + RECOVERY_LIVE_SEEK_WINDOW_MS;
            return;
        case "media-recovery-failed":
            teardown(m, m.recovering ?? "stall", out);
            return;
    }
}

export function stallInput(m: StallMachine, cfg: StallConfig, ev: StallEvent): StallAction[] {
    const ladder = stallLadder(cfg.graceMs, cfg.hlsJs);
    const effects: StallAction[] = [];
    if (ev.kind === "progress" && ev.now - m.ownSeekAt >= OWN_ACTION_SETTLE_MS) m.progressAt = ev.now;
    if (ev.kind === "timer") m.timerAt = null;
    else if (!CLOSING_EVENTS.has(ev.kind) && m.timerAt !== null && ev.now >= m.timerAt) evaluate(m, ladder, ev.now, effects);
    apply(m, ladder, cfg, ev, effects);
    const deadline = stallDeadline(m, ladder);
    if (deadline === m.timerAt) return effects;
    m.timerAt = deadline;
    return [deadline === null ? { kind: "disarm" } : { kind: "arm", ms: Math.max(0, deadline - ev.now) }, ...effects];
}
