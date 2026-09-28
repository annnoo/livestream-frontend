import { beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = () => void;

class FakeElement {
    private listeners = new Map<string, Listener[]>();
    classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    style = { setProperty() {} };
    hidden = false;
    innerHTML = "";
    title = "";
    value = "";
    textContent = "";

    addEventListener(type: string, fn: Listener): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
    }

    removeEventListener(type: string, fn: Listener): void {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
    }

    setAttribute() {}
    removeAttribute() {}

    fire(type: string): void {
        for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
    }
}

class FakeVideo extends FakeElement {
    currentTime = 100;
    paused = false;
    muted = false;
    volume = 1;
    buffered = { length: 0, start: () => 0, end: () => 0 };

    play(): Promise<void> {
        this.paused = false;
        return Promise.resolve();
    }

    pause(): void {
        this.paused = true;
    }
}

const video = new FakeVideo();
let liveSync: number | null = 112;
let recoveries = 0;
let now = 1000;
let nextTimerId = 0;
const timeouts = new Map<number, { at: number; fn: Listener }>();

Date.now = () => now;
(globalThis as unknown as { window: unknown }).window = {
    setTimeout(fn: Listener, ms: number): number {
        nextTimerId += 1;
        timeouts.set(nextTimerId, { at: now + ms, fn });
        return nextTimerId;
    },
    clearTimeout(id: number): void {
        timeouts.delete(id);
    },
    setInterval: () => 0,
    clearInterval() {},
};

function advance(to: number): void {
    for (;;) {
        const due = [...timeouts.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timeouts.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
    }
    now = Math.max(now, to);
}

const noop = () => {};
const el = () => new FakeElement();

mock.module("../../src/live/dom.ts", () => ({
    btnChatCollapse: el(),
    btnChatFullscreen: el(),
    btnChatMore: el(),
    btnChatPopout: el(),
    btnChatSide: el(),
    btnChatToggle: el(),
    btnCinema: el(),
    btnClip: el(),
    btnFullscreen: el(),
    btnLayoutToggle: el(),
    btnMute: el(),
    btnPlay: el(),
    chatOverflow: el(),
    stageEl: el(),
    video,
    volInput: el(),
    volpctEl: el(),
}));
mock.module("../../src/live/player/hls.ts", () => ({
    hlsLiveSyncPosition: () => liveSync,
    resumeHlsLoad: noop,
    recoverHlsMedia: () => {
        recoveries += 1;
        video.paused = true;
        return true;
    },
}));
mock.module("../../src/live/player/lifecycle.ts", () => ({
    beginTransport: noop,
    clearRetryTimer: noop,
    restartAfterFailure: noop,
    wirePageLifecycle: noop,
}));
mock.module("../../src/live/clip/button.ts", () => ({ wireClipButton: noop }));
mock.module("../../src/live/layout.ts", () => ({
    cycleLayout: noop,
    fitChat: noop,
    setChatCollapsed: noop,
    syncLayout: noop,
    toggleChat: noop,
    wireLayoutQuery: noop,
}));
mock.module("../../src/live/fullscreen.ts", () => ({
    enterFullscreen: noop,
    exitChatFullscreen: noop,
    exitFullscreen: noop,
    isChatFsNative: () => false,
    isChatFullscreen: () => false,
    isIOS: () => false,
    isVideoFullscreen: () => false,
    onFullscreenChange: noop,
    toggleChatFullscreen: noop,
    updateChatFullscreenButton: noop,
    volumeIsSettable: () => true,
}));
mock.module("../../src/live/cinema.ts", () => ({ isCinemaMode: () => false, exitCinemaMode: noop, toggleCinemaMode: noop }));
mock.module("../../src/live/browse-mini.ts", () => ({ isBrowseMode: () => false, wireBrowseMode: noop }));
mock.module("../../src/live/quality-menu.ts", () => ({ renderQualityMenu: noop, wireQualityMenu: noop }));
mock.module("../../src/live/stream-info.ts", () => ({ startFpsMeter: noop, updateQuality: noop }));
mock.module("../../src/live/seekbar.ts", () => ({ wireSeekBar: noop }));
mock.module("../../src/live/watch-beacon.ts", () => ({ wireWatchBeacon: noop }));

const { attachVideoElementListeners } = await import("../../src/live/controls.ts");
const { attachVideoFailureListeners } = await import("../../src/live/player/health.ts");
const { ctx } = await import("../../src/live/player/context.ts");

attachVideoElementListeners(video as unknown as HTMLVideoElement);

let gen = 0;

beforeEach(() => {
    for (const cleanup of ctx.genCleanup.splice(0)) cleanup();
    timeouts.clear();
    now += 60000;
    gen += 1;
    ctx.gen = gen;
    ctx.terminal = false;
    ctx.transportKind = "hls-js";
    ctx.behindLive = false;
    ctx.pauseSuspended = false;
    video.currentTime = 100;
    video.paused = false;
    liveSync = 112;
    recoveries = 0;
    attachVideoFailureListeners(gen);
});

function userPlay(): void {
    video.paused = false;
    video.fire("play");
}

describe("the edge snap on play in controls.ts", () => {
    test("snaps a viewer who plays far behind live when no recovery is running", () => {
        video.fire("pause");
        video.paused = true;
        userPlay();
        expect(video.currentTime).toBe(112);
    });

    test("leaves the playhead alone on the play that follows an error's media recovery", () => {
        video.fire("error");
        expect(recoveries).toBe(1);
        userPlay();
        expect(video.currentTime).toBe(100);
    });

    test("leaves the playhead alone while the recovery's seek back to live is pending", () => {
        video.fire("error");
        userPlay();
        advance(now + 5000);
        userPlay();
        expect(video.currentTime).toBe(100);
    });

    test("leaves the playhead alone on the play that follows a stall step's media recovery", () => {
        const start = now;
        video.fire("waiting");
        advance(start + 4000);
        expect(recoveries).toBe(0);
        advance(start + 8000);
        expect(recoveries).toBe(1);
        userPlay();
        expect(video.currentTime).toBe(100);
    });

    test("snaps again once the viewer's own pause hands the playhead back", () => {
        video.fire("error");
        userPlay();
        advance(now + 1000);
        video.paused = true;
        video.fire("pause");
        userPlay();
        expect(video.currentTime).toBe(112);
    });

    test("snaps again once the recovery's window is over", () => {
        video.fire("error");
        userPlay();
        advance(now + 31000);
        video.paused = true;
        userPlay();
        expect(video.currentTime).toBe(112);
    });
});
