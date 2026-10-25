// SPDX-License-Identifier: Apache-2.0
// PW-30: `pw llm bench` against a 127.0.0.1 stub with a serving model (2 slots), so the knee is
// known in advance. No real endpoint, no inference.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Command } from "commander";
import { llmVerb } from "./command.ts";
import { checkBenchTarget, findKnee, runBench, TOOLS, type LevelResult } from "./bench.ts";
import { stubModel, stubServingModel } from "../job/fixtures/stubs.ts";

const open = new Set<() => Promise<unknown>>();
afterEach(async () => {
  const closing = [...open];
  open.clear();
  await Promise.all(closing.map((close) => close()));
  process.exitCode = undefined;
});

/** Runs `pw llm bench <args>` in-process and returns its exit code and output. */
async function bench(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (s: string) => out.push(s);
  console.error = (s: string) => err.push(s);
  try {
    const pw = new Command().exitOverride();
    llmVerb(pw);
    await pw.parseAsync(["llm", "bench", ...args], { from: "user" });
  } finally {
    [console.log, console.error] = [log, error];
  }
  return { code: process.exitCode ?? 0, out: out.join("\n"), err: err.join("\n") };
}

test("bench finds the knee at the stub's slot count: throughput flattens and p95 grows past it", async () => {
  // Each session waits on its own client between calls, so 2 sessions leave the 2 slots a little idle:
  // a gain threshold of 0.3 keeps that slack from reading as "still scaling".
  const model = await stubServingModel({ slots: 2, prefillTokensPerSecond: 500_000, decodeTokensPerSecond: 25_000 });
  open.add(model.close);
  const { code, out } = await bench(["--url", model.url, "--levels", "1,2,4,8", "--knee-gain", "0.3", "--json"]);
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.equal(report.synthetic, true);
  assert.deepEqual(report.profiles, ["prefill-heavy", "tool-calls", "compaction"]);
  assert.equal(report.knee, 2);
  assert.ok(model.stats.peakInFlight <= 2);
  const [l1, l2, l4, l8] = report.levels as LevelResult[];
  assert.ok(l2.outputTokensPerSecond > l1.outputTokensPerSecond * 1.5, "below the knee, a second session nearly doubles throughput");
  assert.ok(l8.outputTokensPerSecond < l2.outputTokensPerSecond * 1.3, "past the knee, more sessions add little");
  assert.ok(l8.p95Ms > l2.p95Ms * 2, "past the knee, sessions queue: p95 grows");
  for (const l of report.levels as LevelResult[]) {
    assert.equal(l.errors, 0);
    assert.equal(l.calls, l.concurrency * (2 + 8 + 7), "3 sessions per worker: one of each profile (2 + 8 + 7 calls at 16K)");
    assert.ok(l.jobsPerHourMeasured > 0 && l.jobsPerHourEstimated > 0);
  }
});

test("bench refuses a non-loopback endpoint without --i-have-a-window, before sending anything", async () => {
  const { code, err } = await bench(["--url", "http://192.0.2.1:8000/v1"]);
  assert.equal(code, 2);
  assert.match(err, /not loopback.*--i-have-a-window/);
  assert.match(checkBenchTarget("http://plantworks.example/v1", false)!, /not loopback/);
  for (const url of ["http://127.0.0.1:1/v1", "http://localhost:1/v1", "http://[::1]:1/v1"]) assert.equal(checkBenchTarget(url, false), undefined, url);
  assert.equal(checkBenchTarget("http://192.0.2.1:8000/v1", true), undefined, "the flag is the operator's word that a window is open");
});

test("bench counts failed sessions, exits 1, and treats a failing level as past the knee", async () => {
  const model = await stubModel("x", { value: "error" });
  open.add(model.close);
  const report = await runBench({ url: model.url }, "qwen3.5:9b", { levels: [1], sessions: 2, window: 16384, callTimeoutMs: 5000, minGain: 0.1 });
  assert.equal(report.levels[0].errors, 2);
  assert.match(report.levels[0].firstError!, /returned 400/);
  const { code } = await bench(["--url", model.url, "--levels", "1", "--sessions", "1"]);
  assert.equal(code, 1);
  const level = (concurrency: number, outputTokensPerSecond: number, errors = 0) => ({ concurrency, outputTokensPerSecond, errors }) as LevelResult;
  assert.equal(findKnee([level(1, 10), level(2, 19), level(4, 40, 1)]), 2);
  assert.equal(findKnee([level(1, 10), level(2, 20), level(4, 40)]), null, "still scaling: no knee yet");
});

test("bench refuses a redirect: a loopback URL can't forward the load to an endpoint the target check never saw", async () => {
  const elsewhere = await stubModel("x");
  open.add(elsewhere.close);
  const redirector = createServer((req, res) => { req.resume(); res.writeHead(307, { location: `${elsewhere.url}/chat/completions` }).end(); });
  redirector.listen(0, "127.0.0.1");
  await once(redirector, "listening");
  open.add(() => new Promise((r) => redirector.close(r)));
  const report = await runBench({ url: `http://127.0.0.1:${(redirector.address() as { port: number }).port}/v1` }, "qwen3.5:9b", { levels: [1], sessions: 1, window: 16384, callTimeoutMs: 5000, minGain: 0.1 });
  assert.equal(report.levels[0].errors, 1);
  assert.match(report.levels[0].firstError!, /redirect/);
  assert.equal(elsewhere.requests.length, 0, "nothing reached the redirect's target");
});

test("bench traffic is Pi-shaped: tool definitions on every call, tool calls answered by tool results", async () => {
  const model = await stubModel("x");
  open.add(model.close);
  await runBench({ url: model.url }, "qwen3.5:9b", { levels: [1], sessions: 3, window: 16384, callTimeoutMs: 5000, minGain: 0.1 });
  const bodies = model.requests.map((r) => r.body);
  assert.equal(bodies.length, 2 + 8 + 7);
  for (const b of bodies) assert.deepEqual(b.tools, TOOLS);
  // The tool-calls session (the worker's second, offset 1): 7 tool calls, each answered in the next call.
  const last = bodies[2 + 8 - 1].messages as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
  const asked = last.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  const answered = last.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.equal(asked.length, 7);
  assert.deepEqual(answered, asked, "every tool call is followed by its result");
  // Compaction (calls 10-16 at 16K: a start, 3 growing tool turns, the summary, 2 more): the call
  // after the summary carries only the system prompt, the summary and the new turn.
  assert.deepEqual(bodies[15].messages.map((m: { role: string }) => m.role), ["system", "user", "user"]);
  assert.ok(bodies[14].messages.length > 6, "the summary call itself sees the full history");
});
