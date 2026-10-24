// SPDX-License-Identifier: Apache-2.0
// End to end through the real `plantworks` binary (needs the upstream CLI built, like PW-08's tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stubConsumer, stubModel } from "./fixtures/stubs.ts";

const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  promisify(execFile)(process.execPath, [bin, ...args], { env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));

test("plantworks pw job run: done prints the result, a rejected job exits 2", async () => {
  const model = await stubModel("hi from the stub");
  const consumer = await stubConsumer();
  const home = mkdtempSync(join(tmpdir(), "pw-cli-"));
  const file = join(home, "job.json");
  writeFileSync(file, JSON.stringify({ jobId: "kb-default-t_00ff00ff-a1", team: "social-media", task: { prompt: "hi" } }));
  // Built from scratch: nothing from the caller's seat (its OPENRIG_* point at a live daemon) reaches the CLI.
  const env = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: home, PLANTWORKS_LLM_URL: model.url, PLANTWORKS_FRONTDOOR_CALLBACK: consumer.url };

  const ok = await run(["pw", "job", "run", file, "--pi", fakePi, "--cwd", home], env);
  assert.equal(ok.code, 0, ok.stderr);
  const { usage, artifacts, ...rest } = JSON.parse(ok.stdout);
  assert.deepEqual(rest, { jobId: "kb-default-t_00ff00ff-a1", state: "done", detail: { outcome: "succeeded" }, text: "hi from the stub", undelivered: [] });
  assert.deepEqual([usage.promptTokens, usage.completionTokens, typeof usage.wallSeconds], [10, 2, "number"]);
  assert.equal(artifacts.branch, null);
  assert.deepEqual(consumer.states(), ["queued", "claimed", "running", "done"]);

  writeFileSync(file, JSON.stringify({ jobId: "nope", team: "social-media", task: { prompt: "hi" } }));
  const bad = await run(["pw", "job", "run", file, "--pi", fakePi], env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /job rejected: invalid envelope/);

  await Promise.all([model.close(), consumer.close()]);
});

test("plantworks pw job run: SIGTERM stops Pi and reports failed (interrupted); the lock lives in the selected home", async () => {
  const model = await stubModel("unused");
  const consumer = await stubConsumer();
  const seatHome = mkdtempSync(join(tmpdir(), "pw-cli-seat-"));
  const productHome = mkdtempSync(join(tmpdir(), "pw-cli-home-"));
  const file = join(productHome, "job.json");
  writeFileSync(file, JSON.stringify({ jobId: "kb-default-t_00ff00ff-a1", team: "social-media", task: { prompt: "hi" } }));
  // PLANTWORKS_HOME wins over OPENRIG_HOME (#82), so the lock follows it.
  const env = { PATH: process.env.PATH, HOME: productHome, OPENRIG_HOME: seatHome, PLANTWORKS_HOME: productHome, PLANTWORKS_LLM_URL: model.url, PLANTWORKS_FRONTDOOR_CALLBACK: consumer.url, PI_FAKE_MODE: "hang" };
  const child = spawn(process.execPath, [bin, "pw", "job", "run", file, "--pi", fakePi, "--cwd", productHome], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    while (!consumer.states().includes("running")) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(join(productHome, "plantworks", "job.lock")), "the lock is in PLANTWORKS_HOME");
    assert.equal(existsSync(join(seatHome, "plantworks", "job.lock")), false, "and not in OPENRIG_HOME");
  } finally {
    child.kill("SIGTERM");
  }
  assert.equal(await exited, 1, stderr);
  assert.deepEqual(JSON.parse(stdout).detail.reason, "interrupted");
  assert.deepEqual(consumer.states(), ["queued", "claimed", "running", "failed"]);
  assert.match(stderr, /interrupted: stopping Pi/);
  assert.equal(existsSync(join(productHome, "plantworks", "job.lock")), false, "released on the way out");
  await Promise.all([model.close(), consumer.close()]);
});
