import { describe, expect, test } from "bun:test";
import { RECOVERY_LIVE_SEEK_WINDOW_MS, stallLadder } from "../src/live/player/stall-escalation.ts";
import {
    newStallMachine,
    OWN_ACTION_SETTLE_MS,
    STALL_RECHECK_MS,
    stallEpisodeOpen,
    stallInput,
    type LiveView,
    type StallAction,
    type StallConfig,
    type StallEvent,
} from "../src/live/player/stall-machine.ts";

interface Driver {
    input(ev: StallEvent): StallAction[];
    open(): boolean;
}

function machineDriver(cfg: StallConfig, paused: boolean): Driver {
    const m = newStallMachine(paused);
    return { input: (ev) => stallInput(m, cfg, ev), open: () => stallEpisodeOpen(m) };
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
    driver: Driver;
    onAction: (action: StallAction) => void = () => {};
    afterInput: () => void = () => {};

    constructor(readonly cfg: StallConfig) {
        this.driver = makeDriver(cfg, false);
    }

    send(kind: EventKind, view: LiveView = STILL): void {
        if (kind === "pause") this.paused = true;
        if (kind === "play") this.paused = false;
        const ev = (kind === "progress" ? { kind, now: this.now, view } : { kind, now: this.now }) as StallEvent;
        const actions = this.driver.input(ev);
        for (const action of actions) this.carry(action);
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
            if (!this.failRecovery && !wasPaused) {
                this.send("pause");
                this.send("play");
            }
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
    for (const [name, cfg] of [["G=8", G8], ["G=20", G20], ["native", NATIVE]] as const) {
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

    test("the pause and play of the recovery itself do not close the episode", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8000);
        expect(sim.driver.open()).toBe(true);
        sim.to(8000 + OWN_ACTION_SETTLE_MS - 1);
        sim.send("pause");
        sim.send("play");
        expect(sim.driver.open()).toBe(true);
        sim.to(20000);
        expect(sim.steps()).toEqual([[4000, "reload"], [8000, "recover-media"], [12000, "teardown"]]);
    });

    test("a viewer who pauses right after a recovery stops the episode before its next step", () => {
        const sim = new Sim(G8);
        sim.send("waiting");
        sim.to(8100);
        sim.send("pause");
        sim.to(60000);
        expect(sim.driver.open()).toBe(false);
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
}

function runRandomSequence(seed: number): string | null {
    const rand = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const cfg = pick([G8, G20, NATIVE]);
    const ladder = stallLadder(cfg.graceMs, cfg.hlsJs);
    const teardownRung = ladder[ladder.length - 1].atMs;
    const lateMs = pick([0, 0, 40, 150]);
    const bound = teardownRung + ladder.length * (STALL_RECHECK_MS + 2 * lateMs) + 1000;
    const sim = new Sim(cfg);
    sim.timerLateMs = lateMs;
    let episode: EpisodeTrack | null = null;
    let failure: string | null = null;
    let step = 0;
    const fail = (message: string) => {
        if (failure === null) failure = `seed ${seed} step ${step} t=${sim.now}: ${message}`;
    };
    sim.onAction = (action) => {
        if (action.kind === "close") {
            episode = null;
            return;
        }
        if (action.kind === "seek-live") {
            if (sim.paused) fail("live seek while paused");
            return;
        }
        const stallStep = action.kind === "reload" || ((action.kind === "recover-media" || action.kind === "teardown") && action.cause === "stall");
        if (!stallStep) {
            if (action.kind === "teardown") episode = null;
            return;
        }
        if (sim.paused) fail(`${action.kind} while paused`);
        if (episode === null) {
            fail(`${action.kind} without an open episode`);
            return;
        }
        const ep: EpisodeTrack = episode;
        const rung = ladder[ep.steps.length];
        if (!rung || rung.step !== action.kind) fail(`${action.kind} out of order after [${ep.steps.join(",")}]`);
        else if (sim.now - ep.startedAt < rung.atMs) fail(`${action.kind} ${sim.now - ep.startedAt} ms into the episode, before ${rung.atMs}`);
        ep.steps.push(action.kind);
        if (action.kind === "teardown") episode = null;
    };
    sim.afterInput = () => {
        const open = sim.driver.open();
        if (open && episode === null) episode = { startedAt: sim.now, steps: [] };
        if (!open) episode = null;
        if (open && sim.timerAt === null) fail("open episode without a pending timer");
        if (episode !== null && sim.now - episode.startedAt > bound) fail(`episode open for ${sim.now - episode.startedAt} ms`);
    };
    const randomView = (): LiveView => {
        const currentTime = 50 + rand() * 50;
        const syncPosition = rand() < 0.1 ? null : currentTime + rand() * 15;
        const end = currentTime + rand() * 20;
        return { currentTime, syncPosition, ranges: [{ start: currentTime - rand() * 5, end }], behindLive: rand() < 0.1 };
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
        else sim.to(sim.now + (rand() < 0.2 ? rand() * cfg.graceMs * 2 : rand() * 2500));
        if (episode !== null) {
            const ep: EpisodeTrack = episode;
            if (sim.now - ep.startedAt > bound) fail(`episode open for ${sim.now - ep.startedAt} ms`);
        }
    }
    return failure;
}

test("random event sequences keep every stall invariant", () => {
    const failures: string[] = [];
    for (let run = 0; run < RANDOM_RUNS; run++) {
        const failure = runRandomSequence(RANDOM_BASE_SEED + run);
        if (failure !== null) failures.push(failure);
    }
    if (failures.length > 0) console.log(`${failures.length} of ${RANDOM_RUNS} sequences failed, first:`, failures.slice(0, 5));
    expect(failures).toEqual([]);
});
