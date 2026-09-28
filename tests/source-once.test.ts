import { expect, test } from "bun:test";
import { loadSourceOnce } from "../src/player-shared/source-once.ts";

function fakeHls() {
    const loads: string[] = [];
    return { loads, loadSource: (url: string) => { loads.push(url); } };
}

const src = "https://origin.example/hls/alice/master.m3u8?ll=1&t=minted-at-start";

test("a second media attach from recoverMediaError does not reload the source", () => {
    const hls = fakeHls();
    const onAttached = loadSourceOnce(hls, src, () => true);
    onAttached();
    onAttached();
    onAttached();
    expect(hls.loads).toEqual([src]);
});

test("an attach while the player is stale loads nothing and leaves the load pending", () => {
    const hls = fakeHls();
    let active = false;
    const onAttached = loadSourceOnce(hls, src, () => active);
    onAttached();
    expect(hls.loads).toEqual([]);
    active = true;
    onAttached();
    onAttached();
    expect(hls.loads).toEqual([src]);
});

test("each player instance loads its own source once", () => {
    const first = fakeHls();
    const second = fakeHls();
    loadSourceOnce(first, src, () => true)();
    const again = src.replace("minted-at-start", "fresh");
    loadSourceOnce(second, again, () => true)();
    expect(first.loads).toEqual([src]);
    expect(second.loads).toEqual([again]);
});
