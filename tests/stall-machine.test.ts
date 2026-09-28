import { describe, expect, test } from "bun:test";
import { RECOVERY_LIVE_SEEK_WINDOW_MS, stallLadder } from "../src/live/player/stall-escalation.ts";
import { lowLatencyStallGraceMs } from "../src/live/player/far-tier.ts";
import { WAITING_STALL_MS } from "../src/live/constants.ts";
import {
    newStallMachine,
    OWN_ACTION_SETTLE_MS,
    STALL_RECHECK_MS,
    STALL_FRESH_PROGRESS_MS,
    stallEpisodeOpen,
    stallInput,
    stallOwnsPlayhead,
    type LiveView,
    type StallAction,
    type StallConfig,
    type StallEvent,
} from "../src/live/player/stall-machine.ts";

interface Driver {
    input(ev: StallEvent): StallAction[];
    open(): boolean;
    ownsPlayhead(now: number): boolean;
}

function machineDriver(cfg: StallConfig, paused: boolean): Driver {
    const m = newStallMachine(paused);
    return { input: (ev) => stallInput(m, cfg, ev), open: () => stallEpisodeOpen(m), ownsPlayhead: (now) => stallOwnsPlayhead(m, now) };
}

const makeDriver: (cfg: StallConfig, paused: boolean) => Driver = machineDriver;

type EventKind = StallEvent["kind"];

const STILL: LiveView = { currentTime: 0, syncPosition: null, ranges: [], behindLive: false };

interface Logged {
    at: number;
    action: StallAction;
}

class Sim {
    now = 0;
    timerAt: number | null = null;
    paused = false;
    failRecovery = false;
    timerLateMs = 0;
    log: Logged[] = [];
    snaps: number[] = [];
    progressLog: number[] = [];
    sending: EventKind[] = [];
    driver: Driver;
    onAction: (action: StallAction) => void = () => {};
    onSnap: () => void = () => {};
    beforeInput: (kind: EventKind, view: LiveView) => void = () => {};
    afterInput: () => void = () => {};

    constructor(readonly cfg: StallConfig) {
        this.driver = makeDriver(cfg, false);
    }

    send(kind: EventKind, view: LiveView = STILL): void {
        this.beforeInput(kind, view);
        if (kind === "pause") this.paused = true;
        if (kind === "play") {
            this.paused = false;
            if (this.cfg.hlsJs && !this.driver.ownsPlayhead(this.now)) {
                this.snaps.push(this.now);
                this.onSnap();
            }
        }
        if (kind === "progress") this.progressLog.push(this.now);
        const ev = (kind === "progress" ? { kind, now: this.now, view } : { kind, now: this.now }) as StallEvent;
        this.sending.push(kind);
        const actions = this.driver.input(ev);
        for (const action of actions) this.carry(action);
        this.sending.pop();
        this.afterInput();
    }

    private carry(action: StallAction): void {
        if (action.kind === "arm") {
            this.timerAt = this.now + action.ms;
            return;
        }
        if (action.kind === "disarm") {
            this.timerAt = null;
            return;
        }
        this.log.push({ at: this.now, action });
        this.onAction(action);
        if (action.kind === "recover-media") {
            const wasPaused = this.paused;
            this.send(this.failRecovery ? "media-recovery-failed" : "media-recovered");
            if (!this.failRecovery && !wasPaused) this.send("play");
        }
        if (action.kind === "teardown") {
            this.timerAt = null;
            this.driver = makeDriver(this.cfg, this.paused);
        }
    }

    to(t: number): void {
        while (this.timerAt !== null && this.timerAt + this.timerLateMs <= t) {
            this.now = Math.max(this.now, this.timerAt + this.timerLateMs);
            this.timerAt = null;
            this.send("timer");
        }
        this.now = Math.max(this.now, t);
    }

    playTo(t: number, view: LiveView = STILL): void {
        let at = this.now;
        while (at + 250 <= t) {
            at += 250;
            this.to(at);
            this.send("progress", view);
        }
        this.to(t);
    }

    steps(): Array<[number, string]> {
        return this.log
            .filter((l) => l.action.kind === "reload" || l.action.kind === "recover-media" || l.action.kind === "teardown")
            .map((l) => [l.at, l.action.kind]);
    }

    stallSteps(): Array<[number, string]> {
        return this.log
            .filter((l) => l.action.kind === "reload" || ((l.action.kind === "recover-media" || l.action.kind === "teardown") && l.action.cause === "stall"))
            .map((l) => [l.at, l.action.kind]);
    }
}

const G8: StallConfig = { graceMs: 8000, hlsJs: true };
const G20: StallConfig = { graceMs: 20000, hlsJs: true };
const NATIVE: StallConfig = { graceMs: 8000, hlsJs: false };
const EDGE_LL: StallConfig = { graceMs: lowLatencyStallGraceMs(true, WAITING_STALL_MS), hlsJs: true };
const ORIGIN_LL: StallConfig = { graceMs: lowLatencyStallGraceMs(false, WAITING_STALL_MS), hlsJs: true };

function stutterUntilTeardown(sim: Sim, stallMs: number, playMs: number, limitMs: number): void {
    while (sim.now < limitMs && !sim.steps().some(([, s]) => s === "teardown")) {
        sim.send("waiting");
        sim.to(sim.now + stallMs);
        if (sim.steps().some(([, s]) => s === "teardown")) break;
        sim.send("playing");
        sim.playTo(sim.now + playMs);
    }
}

describe("stall machine timings", () => {
    test("a stall climbs reload, recover-media and teardown at 0.5 G, G and 1.5 G", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("the far and edge grace stretches the steps to 10, 20 and 30 s", () => {
        const sim = new Sim(G20);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[10000, "reload"], [20000, "recover-media"], [30000, "teardown"]]);
    });

    test("edge low latency takes the far steps at 10, 20 and 30 s, origin low latency keeps 4, 8 and 12 s", () => {
        const edge = new Sim(EDGE_LL);
        edge.send("waiting");
        edge.to(60000);
        expect(edge.steps()).toEqual([[10000, "reload"], [20000, "recover-media"], [30000, "teardown"]]);
        const origin = new Sim(ORIGIN_LL);
        origin.send("waiting");
        origin.to(60000);
        expect(origin.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("an edge low latency viewer rides out the wait for the next released segment when the edge falls back", () => {
        const sim = new Sim(EDGE_LL);
        sim.playTo(3000);
        sim.send("waiting");
        sim.to(9500);
        sim.send("playing");
        sim.playTo(40000);
        expect(sim.steps()).toEqual([]);
        expect(sim.driver.open()).toBe(false);
    });

    test("native playback keeps a single teardown at G", () => {
        const sim = new Sim(NATIVE);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[8000, "teardown"]]);
    });

    test("a late timer takes one step at a time and keeps the gap to the next step", () => {
        const sim = new Sim(G8);
        sim.timerLateMs = 5000;
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[9000, "reload"], [18000, "recover-media"], [27000, "teardown"]]);
    });
});

describe("R1: an open episode always has a timer", () => {
    test("a brief resume after a step rechecks 2 s later and closes when playback kept going", () => {
        const sim = new Sim(G8);
        sim.afterInput = () => {
            if (sim.driver.open()) expect(sim.timerAt).not.toBeNull();
        };
        sim.send("waiting");
        sim.to(4000);
        sim.to(7500);
        sim.send("playing");
        sim.playTo(9400);
        expect(sim.driver.open()).toBe(true);
        sim.playTo(9600);
        expect(sim.driver.open()).toBe(false);
        expect(sim.timerAt).toBeNull();
        expect(sim.steps()).toEqual([[4000, "reload"]]);
    });

    test("a brief resume that stalls again without a waiting event takes the next step at the recheck", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(4000);
        sim.to(7000);
        sim.send("playing");
        sim.playTo(7500);
        sim.to(20000);
        expect(sim.steps()).toEqual([[4000, "reload"], [9000, "recover-media"], [13000, "teardown"]]);
    });

    for (const trigger of ["go-live", "seek", "drift-snap", "unpause"] as const) {
        test(`a stall minutes after a brief resume starts from step 1 (${trigger})`, () => {
            const sim = new Sim(G8);
            sim.send("waiting");
            sim.to(4000);
            sim.to(7500);
            sim.send("playing");
            sim.playTo(8000);
            sim.playTo(200000);
            if (trigger === "unpause") {
                sim.send("pause");
                sim.to(260000);
                sim.send("play");
            } else {
                sim.send(trigger);
                sim.send("progress");
            }
            sim.send("playing");
            sim.playTo(sim.now + 250);
            const stalledAt = sim.now;
            sim.send("waiting");
            sim.to(stalledAt + 3999);
            expect(sim.steps()).toEqual([[4000, "reload"]]);
            sim.to(stalledAt + 20000);
            expect(sim.steps().slice(1)).toEqual([[stalledAt + 4000, "reload"], [stalledAt + 8000, "recover-media"], [stalledAt + 12000, "teardown"]]);
        });
    }

    test("a stall after the episode closed starts from step 1 with the full grace", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(4000);
        sim.to(5000);
        sim.send("playing");
        sim.playTo(8500);
        expect(sim.driver.open()).toBe(false);
        sim.send("waiting");
        sim.to(30000);
        expect(sim.steps()).toEqual([[4000, "reload"], [12500, "reload"], [16500, "recover-media"], [20500, "teardown"]]);
    });

    test("a timeupdate just after waiting does not fall through to the watchdog", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(4500);
        sim.send("playing");
        sim.playTo(6000);
        sim.send("waiting");
        sim.to(6050);
        sim.send("progress");
        sim.to(30000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("a late straggler timeupdate delays the step by at most the recheck", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(4500);
        sim.send("playing");
        sim.playTo(6000);
        sim.send("waiting");
        sim.to(7500);
        sim.send("progress");
        sim.to(30000);
        expect(sim.steps()).toEqual([[4000, "reload"], [10000, "recover-media"], [14000, "teardown"]]);
    });
});

describe("R1: a stutter loop climbs in bounded time", () => {
    for (const [name, cfg] of [["G=8", G8], ["G=20", G20], ["edge LL", EDGE_LL], ["native", NATIVE]] as const) {
        for (const [stallMs, playMs] of [[500, 1500], [100, 1900], [1500, 500], [1000, 1000]]) {
            test(`${name}: stalls of ${stallMs} ms between plays of ${playMs} ms`, () => {
                const sim = new Sim(cfg);
                stutterUntilTeardown(sim, stallMs, playMs, 120000);
                const steps = sim.steps();
                const ladder = stallLadder(cfg.graceMs, cfg.hlsJs);
                expect(steps.map(([, s]) => s)).toEqual(ladder.map((r) => r.step));
                steps.forEach(([at], i) => expect(at).toBeGreaterThanOrEqual(ladder[i].atMs));
                const teardownAt = steps[steps.length - 1][0];
                expect(teardownAt).toBeLessThanOrEqual(ladder[ladder.length - 1].atMs + ladder.length * STALL_RECHECK_MS);
            });
        }
    }
});

describe("R1: user actions and pause", () => {
    for (const kind of ["go-live", "seek", "drift-snap", "play"] as const) {
        test(`${kind} closes an open episode and disarms its timer`, () => {
            const sim = new Sim(G8);
            sim.send("waiting");
            sim.to(5000);
            expect(sim.driver.open()).toBe(true);
            sim.send(kind);
            expect(sim.driver.open()).toBe(false);
            expect(sim.timerAt).toBeNull();
            sim.to(6000);
            sim.send("waiting");
            sim.to(9999);
            expect(sim.steps()).toEqual([[4000, "reload"]]);
            sim.to(10000);
            expect(sim.steps()).toEqual([[4000, "reload"], [10000, "reload"]]);
        });
    }

    test("pause closes the episode and a paused player never advances one", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(2000);
        sim.send("pause");
        expect(sim.driver.open()).toBe(false);
        expect(sim.timerAt).toBeNull();
        sim.send("waiting");
        sim.send("playing");
        sim.send("waiting");
        expect(sim.driver.open()).toBe(false);
        sim.to(120000);
        expect(sim.steps()).toEqual([]);
        sim.send("play");
        sim.send("waiting");
        sim.to(124000);
        expect(sim.steps()).toEqual([[124000, "reload"]]);
    });
});

describe("own seeks and media recovery", () => {
    test("the reload seek's own timeupdate does not count as recovery", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(4000);
        sim.to(4050);
        sim.send("progress");
        sim.send("playing");
        sim.to(20000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("real playback after the reload seek settles counts and closes the episode", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(4000);
        sim.send("playing");
        sim.playTo(4000 + OWN_ACTION_SETTLE_MS + STALL_RECHECK_MS + 250);
        expect(sim.driver.open()).toBe(false);
        expect(sim.steps()).toEqual([[4000, "reload"]]);
    });

    test("playback without a playing event still counts as resumed", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.playTo(9000);
        expect(sim.driver.open()).toBe(false);
        expect(sim.steps()).toEqual([]);
    });

    test("a video error recovers the media in place at most once per 10 s", () => {
        const sim = new Sim(G8);
        sim.send("error");
        sim.to(5000);
        sim.send("error");
        expect(sim.steps()).toEqual([[0, "recover-media"], [5000, "teardown"]]);
        sim.to(10000);
        sim.send("error");
        sim.to(19999);
        sim.send("error");
        expect(sim.steps().slice(2)).toEqual([[10000, "recover-media"], [19999, "teardown"]]);
    });

    test("native playback tears down on a video error", () => {
        const sim = new Sim(NATIVE);
        sim.send("error");
        expect(sim.steps()).toEqual([[0, "teardown"]]);
    });

    test("the play of the recovery itself does not close the episode", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        expect(sim.driver.open()).toBe(true);
        sim.to(8000 + OWN_ACTION_SETTLE_MS - 1);
        sim.send("play");
        expect(sim.driver.open()).toBe(true);
        sim.to(20000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("a viewer who pauses right after a recovery stops the episode at once", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8100);
        sim.send("pause");
        expect(sim.driver.open()).toBe(false);
        expect(sim.timerAt).toBeNull();
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"]]);
    });

    test("a failed media recovery tears down straight away", () => {
        const sim = new Sim(G8);
        sim.failRecovery = true;
        sim.send("waiting");
        sim.to(20000);
        expect(sim.log.map((l) => [l.at, l.action])).toEqual([
            [4000, { kind: "reload" }],
            [8000, { kind: "recover-media", cause: "stall" }],
            [8000, { kind: "teardown", cause: "stall" }],
        ]);
    });
});

function view(currentTime: number, syncPosition: number | null, end: number, behindLive = false): LiveView {
    return { currentTime, syncPosition, ranges: [{ start: currentTime - 1, end }], behindLive };
}

function liveSeeks(sim: Sim): Array<[number, number]> {
    return sim.log.flatMap((l) => (l.action.kind === "seek-live" ? [[l.at, l.action.to] as [number, number]] : []));
}

describe("R2: the seek back to live after a media recovery", () => {
    test("waits until 2 s is buffered past the live sync position, then seeks there once", () => {
        const sim = new Sim(G8);
        sim.send("error");
        sim.to(250);
        sim.send("progress", view(100, 112, 112.5));
        sim.to(500);
        sim.send("progress", view(100.25, 112, 113.9));
        expect(liveSeeks(sim)).toEqual([]);
        sim.to(750);
        sim.send("progress", view(100.5, 112, 114));
        sim.to(1000);
        sim.send("progress", view(100.75, 112.25, 116));
        expect(liveSeeks(sim)).toEqual([[750, 112]]);
    });

    test("never seeks past the buffer or into a gap", () => {
        const sim = new Sim(G8);
        sim.send("error");
        sim.to(250);
        sim.send("progress", view(100, 112, 108));
        sim.to(500);
        sim.send("progress", { currentTime: 100, syncPosition: 112, ranges: [{ start: 99, end: 101 }, { start: 110, end: 113 }], behindLive: false });
        sim.to(750);
        sim.send("progress", { ...view(100, null, 120) });
        expect(liveSeeks(sim)).toEqual([]);
    });

    test("leaves a player already near live alone and keeps waiting", () => {
        const sim = new Sim(G8);
        sim.send("error");
        sim.to(250);
        sim.send("progress", view(100, 101.9, 110));
        sim.to(500);
        sim.send("progress", view(100.25, 108, 110));
        expect(liveSeeks(sim)).toEqual([[500, 108]]);
    });

    test("gives up for a paused or behind-live viewer", () => {
        const paused = new Sim(G8);
        paused.send("error");
        paused.to(OWN_ACTION_SETTLE_MS);
        paused.send("pause");
        paused.to(900);
        paused.send("play");
        paused.send("progress", view(100, 112, 120));
        expect(liveSeeks(paused)).toEqual([]);
        const early = new Sim(G8);
        early.send("error");
        early.to(100);
        early.send("pause");
        early.send("progress", view(100, 112, 120));
        expect(liveSeeks(early)).toEqual([]);
        const behind = new Sim(G8);
        behind.send("error");
        behind.to(250);
        behind.send("progress", view(100, 112, 120, true));
        behind.to(500);
        behind.send("progress", view(100, 112, 120));
        expect(liveSeeks(behind)).toEqual([]);
    });

    test("a user seek, GO LIVE or drift snap cancels it", () => {
        for (const kind of ["seek", "go-live", "drift-snap"] as const) {
            const sim = new Sim(G8);
            sim.send("error");
            sim.to(250);
            sim.send(kind);
            sim.send("progress", view(100, 112, 120));
            expect(liveSeeks(sim)).toEqual([]);
        }
    });

    test("does not depend on the drift snap cooldown", () => {
        const sim = new Sim(G8);
        sim.send("drift-snap");
        sim.to(1000);
        sim.send("error");
        sim.to(1250);
        sim.send("progress", view(100, 112, 120));
        expect(liveSeeks(sim)).toEqual([[1250, 112]]);
    });

    test("stops waiting once its window is over", () => {
        const sim = new Sim(G8);
        sim.send("error");
        sim.to(RECOVERY_LIVE_SEEK_WINDOW_MS + 1);
        sim.send("progress", view(100, 112, 120));
        expect(liveSeeks(sim)).toEqual([]);
    });

    test("the live seek's own timeupdate does not count as recovery", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        sim.to(8500);
        sim.send("playing");
        sim.playTo(9250);
        sim.to(9300);
        sim.send("progress", view(100, 112, 115));
        sim.to(9600);
        sim.send("progress", view(112, 112, 115));
        sim.to(20000);
        expect(liveSeeks(sim)).toEqual([[9300, 112]]);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("a recovery from a stall step also seeks back to live", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        sim.send("playing");
        sim.to(8250);
        sim.send("progress", view(100, 112, 116));
        expect(liveSeeks(sim)).toEqual([[8250, 112]]);
    });
});

describe("M1: a stall event that playback ran through", () => {
    for (const [name, cfg, realAt] of [
        ["G=8", G8, 2000],
        ["G=8, after the first check", G8, 6000],
        ["G=20", G20, 9000],
        ["G=20, after the first check", G20, 12000],
        ["edge LL", EDGE_LL, 9000],
        ["edge LL, after the first check", EDGE_LL, 12000],
        ["native", NATIVE, 6000],
        ["native, after the first check", NATIVE, 9000],
    ] as const) {
        test(`${name}: a real stall at ${realAt} ms gets the full grace from that stall`, () => {
            const sim = new Sim(cfg);
            sim.send("waiting");
            sim.playTo(realAt);
            sim.send("waiting");
            sim.to(realAt + 60000);
            const ladder = stallLadder(cfg.graceMs, cfg.hlsJs);
            expect(sim.steps()).toEqual(ladder.map((r) => [realAt + r.atMs, r.step]));
        });
    }

    test("playback running through the stall event closes the episode at its recheck without a step", () => {
        const sim = new Sim(G20);
        sim.send("waiting");
        sim.playTo(10000);
        expect(sim.driver.open()).toBe(true);
        sim.playTo(12000);
        expect(sim.driver.open()).toBe(false);
        expect(sim.timerAt).toBeNull();
        sim.playTo(60000);
        expect(sim.steps()).toEqual([]);
    });

    test("a straggler timeupdate right after a real stall does not close it", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(50);
        sim.send("progress");
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("a second stall event during a real stall continues it", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(50);
        sim.send("progress");
        sim.to(3000);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("a playing event confirms the stall, so a quick re-stall continues the episode", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(300);
        sim.send("playing");
        sim.playTo(1300);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });
});

describe("M2: the stall caused by the seek back to live", () => {
    function seekBackToLive(): Sim {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(10600);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"]]);
        sim.send("playing");
        sim.playTo(11350);
        sim.to(11400);
        sim.send("progress", view(100, 112, 115));
        expect(liveSeeks(sim)).toEqual([[11400, 112]]);
        sim.to(11450);
        sim.send("waiting");
        return sim;
    }

    test("the seek's own waiting starts a fresh episode instead of taking the teardown", () => {
        const sim = seekBackToLive();
        sim.to(12100);
        sim.send("playing");
        sim.playTo(30000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"]]);
        expect(sim.driver.open()).toBe(false);
    });

    test("a stall that persists after the seek starts from step 1 and tears down at its recover-media rung", () => {
        const sim = seekBackToLive();
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [15450, "reload"], [19450, "teardown"]]);
    });
});

describe("N1: a recover-media, live seek, stall cycle", () => {
    function cycle(cfg: StallConfig, limitMs: number): Sim {
        const sim = new Sim(cfg);
        sim.send("waiting");
        while (sim.now < limitMs && !sim.steps().some(([, s]) => s === "teardown")) {
            const recoveries = sim.steps().filter(([, s]) => s === "recover-media").length;
            sim.to(sim.now + 250);
            if (sim.steps().filter(([, s]) => s === "recover-media").length === recoveries) continue;
            sim.send("playing");
            sim.playTo(sim.now + 750);
            const c = 100 + sim.now / 1000;
            sim.send("progress", view(c, c + 10, c + 13));
            sim.to(sim.now + 50);
            sim.send("waiting");
        }
        return sim;
    }

    for (const [name, cfg] of [["G=8", G8], ["G=20", G20], ["edge LL", EDGE_LL]] as const) {
        test(`${name}: an unplayable live edge gets one media recovery, then the teardown`, () => {
            const sim = cycle(cfg, 300000);
            const steps = sim.steps().map(([, s]) => s);
            expect(steps).toEqual(["reload", "recover-media", "reload", "teardown"]);
            expect(liveSeeks(sim).length).toBe(1);
            const [recoveredAt] = sim.steps()[1];
            const [teardownAt] = sim.steps()[3];
            expect(teardownAt - recoveredAt).toBeLessThan(RECOVERY_LIVE_SEEK_WINDOW_MS);
        });
    }

    test("a stall more than 30 s after the last media recovery recovers the media again", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        sim.send("playing");
        sim.playTo(RECOVERY_LIVE_SEEK_WINDOW_MS + 1);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [34001, "reload"], [38001, "recover-media"], [42001, "teardown"]]);
    });

    test("a stall soon after an error recovery takes the teardown at its recover-media rung", () => {
        const sim = new Sim(G8);
        sim.send("error");
        sim.playTo(5000);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[0, "recover-media"], [9000, "reload"], [13000, "teardown"]]);
    });
});

describe("an event that finds the teardown overdue", () => {
    test("does not also recover the media of the transport it tore down", () => {
        const sim = new Sim(G20);
        sim.send("waiting");
        sim.to(20000);
        expect(sim.steps()).toEqual([[10000, "reload"], [20000, "recover-media"]]);
        sim.timerLateMs = 100000;
        sim.to(30500);
        sim.send("error");
        expect(sim.log.filter((l) => l.at === 30500).map((l) => l.action)).toEqual([{ kind: "teardown", cause: "stall" }]);
    });

    test("does not tear down a second time", () => {
        const sim = new Sim(NATIVE);
        sim.timerLateMs = 100000;
        sim.send("waiting");
        sim.to(9000);
        sim.send("error");
        expect(sim.log.map((l) => [l.at, l.action])).toEqual([[9000, { kind: "teardown", cause: "stall" }]]);
    });
});

describe("N2: a stray playhead movement just before the first step", () => {
    for (const [name, cfg] of [["G=8", G8], ["G=20", G20], ["edge LL", EDGE_LL], ["native", NATIVE]] as const) {
        test(`${name}: the step is taken at the recheck when playback stayed silent`, () => {
            const ladder = stallLadder(cfg.graceMs, cfg.hlsJs);
            const first = ladder[0].atMs;
            const sim = new Sim(cfg);
            sim.send("waiting");
            sim.to(first - 500);
            sim.send("progress");
            sim.to(first);
            expect(sim.driver.open()).toBe(true);
            expect(sim.steps()).toEqual([]);
            sim.to(first + 120000);
            const at = first + STALL_RECHECK_MS;
            const expected: Array<[number, string]> = [[at, ladder[0].step]];
            let prev = at;
            for (let i = 1; i < ladder.length; i++) {
                prev = Math.max(ladder[i].atMs, prev + ladder[i].atMs - ladder[i - 1].atMs);
                expected.push([prev, ladder[i].step]);
            }
            expect(sim.steps()).toEqual(expected);
        });
    }

    test("a waiting after the stray movement takes the overdue step at once", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(3500);
        sim.send("progress");
        sim.to(5000);
        sim.send("waiting");
        expect(sim.steps()).toEqual([[5000, "reload"]]);
    });
});

describe("M3: a pause right after a media recovery", () => {
    test("is the viewer's own and cancels the seek back to live even if play follows", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        sim.to(8100);
        sim.send("pause");
        expect(sim.driver.open()).toBe(false);
        sim.to(8200);
        sim.send("play");
        sim.to(8450);
        sim.send("progress", view(100, 112, 116));
        expect(liveSeeks(sim)).toEqual([]);
        sim.to(8700);
        sim.send("waiting");
        sim.to(60000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12700, "reload"], [16700, "teardown"]]);
    });
});

describe("M4: the edge snap on play during a recovery", () => {
    test("the recovery's own play does not snap, so only the seek back to live moves the playhead", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"]]);
        expect(sim.snaps).toEqual([]);
        expect(sim.driver.ownsPlayhead(sim.now)).toBe(true);
        sim.to(8300);
        sim.send("progress", view(100, 112, 116));
        expect(liveSeeks(sim)).toEqual([[8300, 112]]);
        expect(sim.driver.ownsPlayhead(sim.now)).toBe(false);
        sim.send("pause");
        sim.send("play");
        expect(sim.snaps).toEqual([8300]);
    });

    test("the error path's recovery holds the playhead until its window ends", () => {
        const sim = new Sim(G8);
        sim.send("error");
        expect(sim.snaps).toEqual([]);
        sim.to(RECOVERY_LIVE_SEEK_WINDOW_MS);
        expect(sim.driver.ownsPlayhead(sim.now)).toBe(true);
        sim.to(RECOVERY_LIVE_SEEK_WINDOW_MS + 1);
        expect(sim.driver.ownsPlayhead(sim.now)).toBe(false);
    });

    test("a viewer's pause, seek, GO LIVE or drift snap hands the playhead back", () => {
        for (const kind of ["pause", "seek", "go-live", "drift-snap"] as const) {
            const sim = new Sim(G8);
            sim.send("error");
            sim.to(1000);
            sim.send(kind);
            expect(sim.driver.ownsPlayhead(sim.now)).toBe(false);
            sim.send("play");
            expect(sim.snaps).toEqual([1000]);
        }
    });

    test("a recovery while paused never holds the playhead", () => {
        const sim = new Sim(G8);
        sim.send("pause");
        sim.send("error");
        expect(sim.driver.ownsPlayhead(sim.now)).toBe(false);
        sim.send("play");
        expect(sim.snaps).toEqual([0]);
    });
});

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const RANDOM_BASE_SEED = 0x5eed1;
const RANDOM_RUNS = 3000;
const RANDOM_STEPS = 120;

interface EpisodeTrack {
    startedAt: number;
    steps: string[];
    confirmed: boolean;
}

const DIRECT_CLOSERS: ReadonlySet<EventKind> = new Set(["pause", "play", "seek", "go-live", "drift-snap", "waiting"]);

interface RealStallGuard {
    from: number;
    steps: number;
}

function runRandomSequence(seed: number): string | null {
    const rand = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const cfg = pick([G8, G20, EDGE_LL, NATIVE]);
    const ladder = stallLadder(cfg.graceMs, cfg.hlsJs);
    const teardownRung = ladder[ladder.length - 1].atMs;
    const lateMs = pick([0, 0, 40, 150]);
    const bound = teardownRung + ladder.length * (STALL_RECHECK_MS + 2 * lateMs) + 1000;
    const sim = new Sim(cfg);
    sim.timerLateMs = lateMs;
    let episode: EpisodeTrack | null = null;
    let guard: RealStallGuard | null = null;
    let failure: string | null = null;
    let step = 0;
    const fail = (message: string) => {
        if (failure === null) failure = `seed ${seed} step ${step} t=${sim.now}: ${message}`;    };
    let recoveredAt: number | null = null;
    let ownedUntil: number | null = null;
    const withinRecoveryWindow = () => recoveredAt !== null && sim.now - recoveredAt < RECOVERY_LIVE_SEEK_WINDOW_MS;
    const checkClose = () => {
        const closer = sim.sending[sim.sending.length - 1];
        if (episode === null || sim.paused || closer === undefined || DIRECT_CLOSERS.has(closer)) return;
        const ep: EpisodeTrack = episode;
        if (ep.confirmed || ep.steps.length > 0) return;
        const after = sim.progressLog.filter((p) => p > ep.startedAt);
        const early = after.some((p) => p <= sim.now - STALL_RECHECK_MS);
        const recent = after.some((p) => sim.now - p < STALL_FRESH_PROGRESS_MS);
        if (!early || !recent) fail(`unconfirmed episode closed on ${closer} without playback through a full recheck`);
    };
    sim.beforeInput = (kind, liveView) => {
        if (kind === "playing" && episode !== null) episode.confirmed = true;
        if (kind === "pause" || kind === "seek" || kind === "go-live" || kind === "drift-snap") ownedUntil = null;
        if (kind === "progress" && liveView.behindLive) ownedUntil = null;
    };
    sim.onSnap = () => {
        if (ownedUntil !== null && sim.now <= ownedUntil) fail("edge snap on play while the recovery owns the playhead");
    };
    sim.onAction = (action) => {
        if (action.kind === "close") {
            checkClose();
            episode = null;
            guard = null;
            return;
        }
        if (action.kind === "seek-live") {
            if (sim.paused) fail("live seek while paused");
            ownedUntil = null;
            return;
        }
        if (action.kind === "teardown") ownedUntil = null;
        const stallStep = action.kind === "reload" || ((action.kind === "recover-media" || action.kind === "teardown") && action.cause === "stall");
        if (action.kind === "recover-media") {
            if (stallStep && withinRecoveryWindow()) fail(`stall recover-media ${sim.now - (recoveredAt ?? 0)} ms after the last media recovery`);
            recoveredAt = sim.now;
            ownedUntil = sim.paused ? null : sim.now + RECOVERY_LIVE_SEEK_WINDOW_MS;
        }
        const capped = action.kind === "teardown" && withinRecoveryWindow();
        if (action.kind === "teardown") recoveredAt = null;
        if (!stallStep) {
            if (action.kind === "teardown") {
                episode = null;
                guard = null;
            }
            return;
        }
        if (sim.paused) fail(`${action.kind} while paused`);
        if (guard !== null) {
            const g: RealStallGuard = guard;
            const rung = ladder[g.steps];
            if (rung && sim.now - g.from < rung.atMs) fail(`${action.kind} ${sim.now - g.from} ms after a real stall that followed a stall playback ran through, before ${rung.atMs}`);
            g.steps += 1;
            if (action.kind === "teardown") guard = null;
        }
        if (episode === null) {
            fail(`${action.kind} without an open episode`);
            return;
        }
        const ep: EpisodeTrack = episode;
        const rung = ladder[ep.steps.length];
        const inPlace = rung && (rung.step === action.kind || (capped && rung.step === "recover-media"));
        if (!inPlace) fail(`${action.kind} out of order after [${ep.steps.join(",")}]`);
        else if (rung && sim.now - ep.startedAt < rung.atMs) fail(`${action.kind} ${sim.now - ep.startedAt} ms into the episode, before ${rung.atMs}`);
        ep.steps.push(action.kind);
        if (action.kind === "teardown") episode = null;
    };
    sim.afterInput = () => {
        const open = sim.driver.open();
        if (open && episode === null) episode = { startedAt: sim.now, steps: [], confirmed: false };
        const owned = ownedUntil !== null && sim.now <= ownedUntil;
        if (sim.driver.ownsPlayhead(sim.now) !== owned) fail(`machine ${owned ? "released" : "holds"} the playhead ${owned ? "inside" : "outside"} a recovery's live seek window`);
        if (!open) {
            episode = null;
            guard = null;
        }
        if (open && sim.timerAt === null) fail("open episode without a pending timer");
        if (episode !== null && sim.now - episode.startedAt > bound) fail(`episode open for ${sim.now - episode.startedAt} ms`);
    };
    const randomView = (): LiveView => {
        const currentTime = 50 + rand() * 50;
        const syncPosition = rand() < 0.1 ? null : currentTime + rand() * 15;
        const end = currentTime + rand() * 20;
        return { currentTime, syncPosition, ranges: [{ start: currentTime - rand() * 5, end }], behindLive: rand() < 0.1 };
    };
    const spuriousThenReal = () => {
        const idle = !sim.paused && !sim.driver.open();
        sim.send("waiting");
        if (!idle) return;
        sim.playTo(sim.now + 1000 + rand() * cfg.graceMs);
        sim.send("waiting");
        if (sim.driver.open()) guard = { from: sim.now, steps: 0 };
    };
    const seekableView = (): LiveView => {
        const currentTime = 50 + rand() * 50;
        const syncPosition = currentTime + 2 + rand() * 13;
        return { currentTime, syncPosition, ranges: [{ start: currentTime - 1, end: syncPosition + 2 + rand() * 5 }], behindLive: false };
    };
    const recoverSeekStall = () => {
        const idle = cfg.hlsJs && !sim.paused && !sim.driver.open();
        sim.send("waiting");
        if (!idle) return;
        sim.to(sim.now + cfg.graceMs + 2 * lateMs + rand() * 300);
        sim.send("playing");
        sim.playTo(sim.now + 500 + rand() * 1500);
        sim.send("progress", seekableView());
        sim.to(sim.now + rand() * 450);
        sim.send("waiting");
        sim.to(sim.now + rand() * cfg.graceMs * 2);
    };
    const strayBeforeFirstStep = () => {
        const idle = !sim.paused && !sim.driver.open();
        sim.send("waiting");
        if (!idle) return;
        sim.to(sim.now + ladder[0].atMs - 100 - rand() * 800);
        sim.send("progress");
        sim.to(sim.now + rand() * cfg.graceMs * 2);
    };
    for (step = 0; step < RANDOM_STEPS && failure === null; step++) {
        const r = rand();
        if (r < 0.2) sim.send("waiting");
        else if (r < 0.32) sim.send("playing");
        else if (r < 0.5) sim.playTo(sim.now + rand() * 3000, rand() < 0.3 ? randomView() : STILL);
        else if (r < 0.53) sim.send("pause");
        else if (r < 0.58) sim.send("play");
        else if (r < 0.6) sim.send("seek");
        else if (r < 0.62) sim.send("go-live");
        else if (r < 0.64) sim.send("drift-snap");
        else if (r < 0.66) sim.send("error");
        else if (r < 0.72) sim.send("progress", randomView());
        else if (r < 0.77) spuriousThenReal();
        else if (r < 0.82) recoverSeekStall();
        else if (r < 0.87) strayBeforeFirstStep();
        else sim.to(sim.now + (rand() < 0.2 ? rand() * cfg.graceMs * 2 : rand() * 2500));
        if (episode !== null) {
            const ep: EpisodeTrack = episode;
            if (sim.now - ep.startedAt > bound) fail(`episode open for ${sim.now - ep.startedAt} ms`);
        }
    }
    return failure;
}

test("random event sequences cover the edge low latency grace", () => {
    let edgeRuns = 0;
    for (let run = 0; run < RANDOM_RUNS; run++) {
        const rand = mulberry32(RANDOM_BASE_SEED + run);
        if ([G8, G20, EDGE_LL, NATIVE][Math.floor(rand() * 4)] === EDGE_LL) edgeRuns += 1;
    }
    expect(EDGE_LL.graceMs).toBe(20000);
    expect(edgeRuns).toBeGreaterThan(RANDOM_RUNS / 8);
});

test("random event sequences keep every stall invariant", () => {
    const failures: string[] = [];
    for (let run = 0; run < RANDOM_RUNS; run++) {
        const failure = runRandomSequence(RANDOM_BASE_SEED + run);
        if (failure !== null) failures.push(failure);
    }
    if (failures.length > 0) console.log(`${failures.length} of ${RANDOM_RUNS} sequences failed, first:`, failures.slice(0, 5));
    expect(failures).toEqual([]);
});
