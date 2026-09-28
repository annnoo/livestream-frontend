import { expect, test } from "bun:test";
import { beatUrl, beatVariants, ladderGrew } from "../src/player-shared/hls-beat.ts";
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

test("only a ladder larger than the loaded levels restarts the player", () => {
    expect(ladderGrew(2, 1, false)).toBe(true);
    expect(ladderGrew(1, 1, false)).toBe(false);
    expect(ladderGrew(1, 2, false)).toBe(false);
    expect(ladderGrew(null, 1, false)).toBe(false);
});

test("a paused player or one without a parsed manifest never restarts", () => {
    expect(ladderGrew(2, 1, true)).toBe(false);
    expect(ladderGrew(2, 0, false)).toBe(false);
});

test("the beat interval leaves go-live's viewer window three beats deep", () => {
    expect(LIVE_BEACON_MS * 3).toBeLessThanOrEqual(GO_LIVE_BEAT_WINDOW_MS);
    expect(EMBED_BEACON_MS * 3).toBeLessThanOrEqual(GO_LIVE_BEAT_WINDOW_MS);
    expect(LIVE_BEACON_MS).toBeGreaterThan(10000);
});
