import { expect, test } from "bun:test";

test("controls.ts leaves the playhead to a running stall recovery and snaps otherwise", () => {
    const run = Bun.spawnSync([process.execPath, "test", "./tests/isolated/live-controls-snap.isolated.ts"], {
        cwd: `${import.meta.dir}/..`,
        stdout: "pipe",
        stderr: "pipe",
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    if (run.exitCode !== 0) console.log(output);
    expect(run.exitCode).toBe(0);
    expect(output).toMatch(/\b6 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
});
