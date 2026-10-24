// SPDX-License-Identifier: Apache-2.0
// End to end through the real `plantworks` binary (needs the upstream CLI built, like PW-08's tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  const env = { ...process.env, OPENRIG_HOME: home, PLANTWORKS_LLM_URL: model.url, PLANTWORKS_FRONTDOOR_CALLBACK: consumer.url };

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
