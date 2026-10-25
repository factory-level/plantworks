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
  // The host lock goes under a temp XDG_RUNTIME_DIR: never the real /run/user or /tmp/plantworks-<uid>.
  const env = { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: home, XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), "pw-cli-run-")), PLANTWORKS_LLM_URL: model.url, PLANTWORKS_FRONTDOOR_CALLBACK: consumer.url };

  const ok = await run(["pw", "job", "run", file, "--pi", fakePi, "--cwd", home], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { jobId: "kb-default-t_00ff00ff-a1", state: "done", detail: { outcome: "succeeded" }, text: "hi from the stub", undelivered: [] });
  assert.deepEqual(consumer.states(), ["queued", "claimed", "running", "done"]);

  writeFileSync(file, JSON.stringify({ jobId: "nope", team: "social-media", task: { prompt: "hi" } }));
  const bad = await run(["pw", "job", "run", file, "--pi", fakePi], env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /job rejected: invalid envelope/);

  await Promise.all([model.close(), consumer.close()]);
});

test("plantworks pw job run: SIGTERM stops Pi and reports failed (interrupted); the lock is the host's", async () => {
  const model = await stubModel("unused");
  const consumer = await stubConsumer();
  const seatHome = mkdtempSync(join(tmpdir(), "pw-cli-seat-"));
  const productHome = mkdtempSync(join(tmpdir(), "pw-cli-home-"));
  const file = join(productHome, "job.json");
  writeFileSync(file, JSON.stringify({ jobId: "kb-default-t_00ff00ff-a1", team: "social-media", task: { prompt: "hi" } }));
  // D14: the lock is the host's (per uid), under XDG_RUNTIME_DIR, not in either home.
  const runtime = mkdtempSync(join(tmpdir(), "pw-cli-run-"));
  const hostLock = join(runtime, "plantworks", "job.lock");
  const env = { PATH: process.env.PATH, HOME: productHome, OPENRIG_HOME: seatHome, PLANTWORKS_HOME: productHome, XDG_RUNTIME_DIR: runtime, PLANTWORKS_LLM_URL: model.url, PLANTWORKS_FRONTDOOR_CALLBACK: consumer.url, PI_FAKE_MODE: "hang" };
  const child = spawn(process.execPath, [bin, "pw", "job", "run", file, "--pi", fakePi, "--cwd", productHome], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    while (!consumer.states().includes("running")) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(hostLock), "the lock is under XDG_RUNTIME_DIR");
    for (const home of [productHome, seatHome]) assert.equal(existsSync(join(home, "plantworks", "job.lock")), false, "and in neither home");
  } finally {
    child.kill("SIGTERM");
  }
  assert.equal(await exited, 1, stderr);
  assert.deepEqual(JSON.parse(stdout).detail.reason, "interrupted");
  assert.deepEqual(consumer.states(), ["queued", "claimed", "running", "failed"]);
  assert.match(stderr, /interrupted: stopping Pi/);
  assert.equal(existsSync(hostLock), false, "released on the way out");
  await Promise.all([model.close(), consumer.close()]);
});

test("D14: two jobs from different homes on one host conflict over the host lock; PLANTWORKS_JOB_LOCK still separates them", async () => {
  const model = await stubModel("ok");
  const first = await stubConsumer();
  const second = await stubConsumer();
  const runtime = mkdtempSync(join(tmpdir(), "pw-cli-run-"));
  const job = (home: string) => { const f = join(home, "job.json"); writeFileSync(f, JSON.stringify({ jobId: "kb-default-t_00ff00ff-a1", team: "social-media", task: { prompt: "hi" } })); return f; };
  const env = (home: string, callback: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: home, PLANTWORKS_HOME: home, XDG_RUNTIME_DIR: runtime, PLANTWORKS_LLM_URL: model.url, PLANTWORKS_FRONTDOOR_CALLBACK: callback, ...extra });
  const homeA = mkdtempSync(join(tmpdir(), "pw-cli-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "pw-cli-b-"));
  const holder = spawn(process.execPath, [bin, "pw", "job", "run", job(homeA), "--pi", fakePi, "--cwd", homeA], { env: env(homeA, first.url, { PI_FAKE_MODE: "hang" }), stdio: "ignore" });
  const held = new Promise((resolve) => holder.once("exit", resolve));
  try {
    while (!first.states().includes("running")) await new Promise((r) => setTimeout(r, 20));
    const refused = await run(["pw", "job", "run", job(homeB), "--pi", fakePi, "--cwd", homeB], env(homeB, second.url));
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /one job at a time on this host: .*\(the host default under \$XDG_RUNTIME_DIR; PLANTWORKS_JOB_LOCK overrides it\)/);
    assert.equal(second.events.length, 0, "the refused job emitted nothing");
    const apart = await run(["pw", "job", "run", job(homeB), "--pi", fakePi, "--cwd", homeB], env(homeB, second.url, { PLANTWORKS_JOB_LOCK: join(homeB, "own.lock") }));
    assert.equal(apart.code, 0, apart.stderr);
    assert.equal(JSON.parse(apart.stdout).state, "done", "a separate PLANTWORKS_JOB_LOCK runs alongside");
  } finally {
    holder.kill("SIGTERM");
    await held;
    await Promise.all([model.close(), first.close(), second.close()]);
  }
});
