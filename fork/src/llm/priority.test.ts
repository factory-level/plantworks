// SPDX-License-Identifier: Apache-2.0
// PW-29: the governor sends the current job's effective priority as the request's `priority`, only
// when enabled. A stub endpoint on 127.0.0.1 records what reaches it; no inference.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSES } from "./classes.ts";
import { governBody, startGovernor } from "./governor.ts";
import { runJob } from "../job/run.ts";
import { stubConsumer, stubModel } from "../job/fixtures/stubs.ts";

const open = new Set<() => Promise<unknown>>();
afterEach(async () => {
  const closing = [...open];
  open.clear();
  await Promise.all(closing.map((close) => close()));
});

const call = (url: string, body: object) => fetch(`${url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.5:9b", messages: [], ...body }) });

test("governBody: a priority replaces whatever Pi sent; none leaves the body without one", () => {
  const body = (o: object) => Buffer.from(JSON.stringify({ model: "m", messages: [], ...o }));
  assert.equal(JSON.parse(governBody(body({ priority: 7 }), CLASSES.quick, -3).toString()).priority, -3);
  assert.equal("priority" in JSON.parse(governBody(body({}), CLASSES.quick).toString()), false);
});

test("governor: off by default, so no priority reaches the endpoint even after setPriority (Ollama and fcfs vLLM)", async () => {
  const model = await stubModel();
  open.add(model.close);
  const g = await startGovernor({ endpoint: { url: model.url }, workerClass: CLASSES.quick });
  open.add(g.close);
  g.setPriority(-3);
  assert.equal((await call(g.url, {})).status, 200);
  assert.equal("priority" in model.requests[0].body, false);
});

test("governor with priority hints: each request carries the current job's priority, and a seat's jobs switch it in turn", async () => {
  const model = await stubModel();
  open.add(model.close);
  const g = await startGovernor({ endpoint: { url: model.url }, workerClass: CLASSES.quick, priorityHints: true });
  open.add(g.close);
  await call(g.url, {}); // before any job: nothing set
  g.setPriority(-3); // an urgent job on a base-0 class
  await call(g.url, { priority: 5 }); // Pi's own value from models.json is replaced
  await call(g.url, {});
  g.setPriority(7); // the seat's next job: a low job on a base-5 class
  await call(g.url, {});
  g.setPriority(undefined); // between jobs
  await call(g.url, {});
  assert.deepEqual(model.requests.map((r) => r.body.priority), [undefined, -3, -3, 7, undefined]);
});

test("pw job run: an urgent job's offset reaches the endpoint when PLANTWORKS_LLM_PRIORITY=1, and nothing when unset", async () => {
  const fakePi = [process.execPath, fileURLToPath(new URL("../job/fixtures/fake-pi.mjs", import.meta.url))];
  for (const [flag, expected] of [["1", -3], [undefined, undefined]] as const) {
    const model = await stubModel("hi");
    open.add(model.close);
    const consumer = await stubConsumer();
    open.add(consumer.close);
    const home = mkdtempSync(join(tmpdir(), "pw-prio-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, PLANTWORKS_LLM_URL: model.url, ...(flag ? { PLANTWORKS_LLM_PRIORITY: flag } : {}) };
    const result = await runJob({
      envelope: { jobId: "kb-social-media-t_prio0001-a1", team: "social-media", priority: "urgent", task: { prompt: "p" } },
      callbackUrl: consumer.url, openrigHome: home, cwd: home, piCommand: fakePi, env, log: () => {},
    });
    assert.equal(result.state, "done");
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].body.priority, expected, `PLANTWORKS_LLM_PRIORITY=${flag}`);
  }
});
