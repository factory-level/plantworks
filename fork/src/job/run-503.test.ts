// SPDX-License-Identifier: Apache-2.0
// PW-11 through the whole job path: an endpoint answering 503 (queue full) and 500, in front of
// the stub model, on 127.0.0.1 only. No shared inference: the stub is the only model.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runJob, type RunOptions } from "./run.ts";
import { stubConsumer, stubModel } from "./fixtures/stubs.ts";

const fakePi = [process.execPath, fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url))];
const envelope = { jobId: "kb-social-media-t_5030c01e-a1", team: "social-media", task: { prompt: "Say hi" } };

const open = new Set<() => Promise<unknown>>();
afterEach(async () => {
  const closing = [...open];
  open.clear();
  await Promise.all(closing.map((close) => close()));
});

/**
 * An endpoint in front of the stub model. `plan(n)` decides the n-th chat completion (from 1): a
 * status to answer with, or "forward" to pass it to the stub (JSON or SSE, as asked).
 */
async function front(plan: (n: number) => number | "forward") {
  const model = await stubModel("hello from the stub");
  open.add(model.close);
  let posts = 0;
  const at: number[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", async () => {
      const path = (req.url ?? "").replace(/^\/v1/, "");
      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        at.push(Date.now());
        const step = plan(++posts);
        if (step !== "forward") return res.writeHead(step, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `stub ${step}` } }));
      }
      const upstream = await fetch(`${model.url}${path}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? raw : undefined });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  open.add(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model, posts: () => posts, gaps: () => at.slice(1).map((t, i) => t - at[i]!) };
}

/** A sealed environment built from scratch: no inherited OpenRig, endpoint or credential variables. */
function sealed(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...extra };
}

async function job(url: string, piCommand: string[], extra: Partial<RunOptions> = {}, piMode = "ok") {
  const consumer = await stubConsumer();
  open.add(consumer.close);
  const home = mkdtempSync(join(tmpdir(), "pw-run503-"));
  const result = await runJob({
    envelope, callbackUrl: consumer.url, openrigHome: home, cwd: home, piCommand,
    env: sealed(home, { PLANTWORKS_LLM_URL: url, PI_FAKE_MODE: piMode }), log: () => {}, ...extra,
  });
  return { result, states: consumer.states() };
}

test("a busy endpoint (503, 503, then 200) is waited out by the governor: the job runs to done and no attempt is counted", async () => {
  const f = await front((n) => (n <= 2 ? 503 : "forward"));
  const { result, states } = await job(f.url, fakePi);
  assert.deepEqual([result.state, result.detail, result.text], ["done", { outcome: "succeeded" }, "hello from the stub"]);
  assert.deepEqual(states, ["queued", "claimed", "running", "done"], "running -> done, never failed in between");
  assert.equal(f.posts(), 3, "the governor retried the same call twice, behind Pi's back");
  assert.equal(f.model.requests.length, 1, "Pi made one call; the 503s were not attempts");
});

test("an endpoint that stays busy (503 throughout) ends the job at timeoutSeconds as failed/timeout, not call-deadline", async () => {
  const f = await front(() => 503);
  const started = Date.now();
  const { result, states } = await job(f.url, fakePi, { envelope: { ...envelope, timeoutSeconds: 2 } });
  assert.equal(result.state, "failed");
  assert.equal((result.detail as { reason: string }).reason, "timeout");
  assert.deepEqual(states, ["queued", "claimed", "running", "failed"]);
  assert.ok(f.posts() >= 2, "the governor kept retrying 503 until the job timed out");
  assert.equal(f.model.requests.length, 0);
  assert.ok(Date.now() - started < 10_000);
});

// Real Pi, gated like run.test.ts: PLANTWORKS_PI_BIN is the pinned Pi's cli.js. It records what Pi
// itself does with an error the governor passes through (a 500 here; a deadline 504 is the same
// status class). The answer is pinned in fork/src/llm/README.md.
test("real Pi: a 5xx the governor passes through (500, and 504 as the governor's deadline answer) is retried by Pi itself, 3 times with growing backoff", { skip: !process.env.PLANTWORKS_PI_BIN && "PLANTWORKS_PI_BIN not set" }, async () => {
  const pi = process.env.PLANTWORKS_PI_BIN!;
  for (const status of [500, 504]) {
    const f = await front(() => status);
    const { result } = await job(f.url, /\.m?js$/.test(pi) ? [process.execPath, pi] : [pi], { envelope: { ...envelope, timeoutSeconds: 60 } });
    process.stderr.write(`pi ${status}: ${f.posts()} calls, gaps ${JSON.stringify(f.gaps())} ms\n`);
    assert.equal(result.state, "failed", JSON.stringify(result));
    assert.equal(f.posts(), 4, `${status}: one call and 3 retries by Pi; the governor does not retry it`);
    assert.ok(f.gaps().every((g, i) => i === 0 || g > f.gaps()[i - 1]!), `${status}: backoff grows: ${f.gaps()}`);
  }
});

test("real Pi: one busy period (503, 503, then 200) costs Pi a single call", { skip: !process.env.PLANTWORKS_PI_BIN && "PLANTWORKS_PI_BIN not set" }, async () => {
  const pi = process.env.PLANTWORKS_PI_BIN!;
  const f = await front((n) => (n <= 2 ? 503 : "forward"));
  const { result } = await job(f.url, /\.m?js$/.test(pi) ? [process.execPath, pi] : [pi], { envelope: { ...envelope, timeoutSeconds: 60 } });
  assert.equal(result.state, "done", JSON.stringify(result));
  assert.equal(f.posts(), 3);
  assert.equal(f.model.requests.length, 1);
});
