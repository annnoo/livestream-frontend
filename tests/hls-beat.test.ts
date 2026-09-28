import { expect, test } from "bun:test";
import { beatUrl, beatVariants, ladderGrew, newLadderWatch, type LadderWatch } from "../src/player-shared/hls-beat.ts";
import { HLS_BEACON_INTERVAL_MS as LIVE_BEACON_MS } from "../src/live/constants.ts";
import { HLS_BEACON_INTERVAL_MS as EMBED_BEACON_MS } from "../src/embed/constants.ts";

const GO_LIVE_BEAT_WINDOW_MS = 90000;

test("beat url carries the escaped channel, viewer id and captcha query", () => {
    expect(beatUrl("https://media.example", "Al ice", "a.b+c", "&t=x")).toBe("https://media.example/hls/Al%20ice/beat?id=a.b%2Bc&t=x");
    expect(beatUrl("", "bob", "id", "")).toBe("/hls/bob/beat?id=id");
});

test("beat reply yields the variant count", () => {
    expect(beatVariants(200, JSON.stringify({ variants: 3 }))).toBe(3);
    expect(beatVariants(200, JSON.stringify({ variants: 0 }))).toBe(0);
});

test("an old go-live's empty 204 or a broken reply yields nothing", () => {
    expect(beatVariants(204, "")).toBeNull();
    expect(beatVariants(200, "")).toBeNull();
    expect(beatVariants(200, "not json")).toBeNull();
    expect(beatVariants(200, "null")).toBeNull();
    expect(beatVariants(200, JSON.stringify({}))).toBeNull();
    expect(beatVariants(200, JSON.stringify({ variants: "2" }))).toBeNull();
    expect(beatVariants(200, JSON.stringify({ variants: 1.5 }))).toBeNull();
    expect(beatVariants(200, JSON.stringify({ variants: -1 }))).toBeNull();
    expect(beatVariants(404, JSON.stringify({ variants: 3 }))).toBeNull();
});

function watching(master: number | null): LadderWatch {
    const watch = newLadderWatch();
    watch.master = master;
    return watch;
}

test("only a ladder larger than the master at start restarts the player", () => {
    expect(ladderGrew(watching(1), 2, false)).toBe(true);
    expect(ladderGrew(watching(1), 1, false)).toBe(false);
    expect(ladderGrew(watching(2), 1, false)).toBe(false);
    expect(ladderGrew(watching(1), null, false)).toBe(false);
});

test("hls.js holding fewer levels than the master lists never restarts", () => {
    const watch = watching(3);
    for (let beat = 0; beat < 5; beat++) {
        expect(ladderGrew(watch, 3, false)).toBe(false);
    }
    expect(watch.restartedFor).toBeNull();
});

test("a paused player or one without a parsed manifest never restarts", () => {
    expect(ladderGrew(watching(1), 2, true)).toBe(false);
    expect(ladderGrew(watching(0), 2, false)).toBe(false);
    expect(ladderGrew(watching(null), 2, false)).toBe(false);
});

test("a paused beat does not use up the growth", () => {
    const watch = watching(1);
    expect(ladderGrew(watch, 2, true)).toBe(false);
    expect(ladderGrew(watch, 2, false)).toBe(true);
});

test("a growth restarts once even if the next master still lists fewer", () => {
    const watch = watching(2);
    expect(ladderGrew(watch, 3, false)).toBe(true);
    watch.master = 2;
    expect(ladderGrew(watch, 3, false)).toBe(false);
    expect(ladderGrew(watch, 3, false)).toBe(false);
    expect(ladderGrew(watch, 4, false)).toBe(true);
});

test("a shrink then a regrowth restarts again", () => {
    const watch = watching(2);
    expect(ladderGrew(watch, 3, false)).toBe(true);
    watch.master = 3;
    expect(ladderGrew(watch, 2, false)).toBe(false);
    watch.master = 2;
    expect(ladderGrew(watch, 3, false)).toBe(true);
});

test("the beat interval leaves go-live's viewer window three beats deep", () => {
    expect(LIVE_BEACON_MS * 3).toBeLessThanOrEqual(GO_LIVE_BEAT_WINDOW_MS);
    expect(EMBED_BEACON_MS * 3).toBeLessThanOrEqual(GO_LIVE_BEAT_WINDOW_MS);
    expect(LIVE_BEACON_MS).toBeGreaterThan(10000);
});
