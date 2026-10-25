// SPDX-License-Identifier: Apache-2.0
// PW-28 at stub level: the fork's endpoint contract (preflight, 503 handling, the D13 deadline rule,
// priority hints, streamed usage) through stand-ins for the vLLM production-stack router and the
// LiteLLM proxy (fixtures/routers.ts). Everything is on 127.0.0.1 in this process; no real router or
// model is involved. The real in-cluster run is gated; see fork/docs/router-compat.md.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES } from "./classes.ts";
import { preflight } from "./endpoint.ts";
import { startGovernor, type CallRecord, type GovernorOptions } from "./governor.ts";
import { stubModel } from "../job/fixtures/stubs.ts";
import { liteLLMProxy, vllmBackend, vllmRouter } from "./fixtures/routers.ts";

const open = new Set<() => Promise<unknown>>();
afterEach(async () => {
  const closing = [...open];
  open.clear();
  await Promise.all(closing.map((close) => close()));
});
const track = <T extends { close: () => Promise<unknown> }>(x: T) => (open.add(x.close), x);

const MODEL = "qwen3.5:9b";
type Plan = Parameters<typeof vllmBackend>[1];

/** The stub model behind one vLLM backend behind the named router. */
async function stack(router: "vllm" | "litellm", plan?: Plan, opts: Parameters<typeof liteLLMProxy>[1] = {}) {
  const model = track(await stubModel("hello through the router"));
  const backend = track(await vllmBackend(model, plan));
  const front = router === "vllm" ? track(await vllmRouter({ [MODEL]: backend.url })) : track(await liteLLMProxy({ [MODEL]: backend.url }, opts));
  return { backend, front };
}

async function governor(url: string, extra: Partial<GovernorOptions> = {}) {
  const records: CallRecord[] = [];
  const fails: string[] = [];
  const g = track(await startGovernor({ endpoint: { url }, workerClass: CLASSES.quick, log: (r) => records.push(r), onFail: (r) => fails.push(r), backoffMs: { first: 10, max: 20 }, ...extra }));
  const call = (body: object = {}) => fetch(`${g.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], ...body }), signal: AbortSignal.timeout(10_000) });
  return { g, records, fails, call };
}

for (const router of ["vllm", "litellm"] as const) {
  test(`${router}: preflight lists the router's models and names one it doesn't serve`, async () => {
    const { front } = await stack(router);
    const ok = await preflight({ url: front.url }, [MODEL]);
    assert.deepEqual([ok.ok, ok.models, ok.missing], [true, [MODEL], []]);
    const missing = await preflight({ url: front.url }, [MODEL, "absent:1b"]);
    assert.deepEqual([missing.ok, missing.error], [false, "not served: absent:1b"]);
  });

  test(`${router}: a deadline-missing backend is cut by the governor, and three in a row fail the job with call-deadline (D13)`, async () => {
    const { front } = await stack(router, () => "hang");
    const { call, fails, records } = await governor(front.url, { workerClass: { ...CLASSES.quick, deadlineSeconds: 0.2 } });
    assert.deepEqual([(await call()).status, (await call()).status, (await call()).status], [504, 504, 504]);
    assert.deepEqual(fails, ["call-deadline"], "the router adds no timeout of its own that answers first");
    assert.ok(records.every((r) => r.deadline));
  });

  test(`${router}: a streamed completion relays through, and the governor counts its usage`, async () => {
    const { front } = await stack(router);
    const { g, call } = await governor(front.url);
    const res = await call({ stream: true, stream_options: { include_usage: true } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /hello through the router[\s\S]*\[DONE\]/);
    assert.deepEqual(g.usage(), { promptTokens: 10, completionTokens: 2 });
  });
}

test("vllm: an unknown model is a 404 with a plain-string error, passed to Pi unchanged", async () => {
  const { front } = await stack("vllm");
  const { call } = await governor(front.url);
  const res = await call({ model: "absent:1b" });
  assert.equal(res.status, 404);
  assert.match((await res.json() as { error: string }).error, /Model 'absent:1b' not found/);
});

test("vllm: a backend 503 passes through the router, and the governor waits it out without counting an attempt", async () => {
  const { front, backend } = await stack("vllm", (n) => (n <= 2 ? 503 : "forward"));
  const { call, records } = await governor(front.url);
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id")?.length, 36, "the router's request id comes back");
  assert.deepEqual([records[0]!.retries503, backend.bodies.length], [2, 3]);
});

test("vllm: the governor's priority reaches vLLM unchanged in the body, as do tool calls", async () => {
  const { front, backend } = await stack("vllm");
  const { call } = await governor(front.url, { priorityHints: true, priority: -3 });
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { cmd: { type: "string" } }, additionalProperties: false }, strict: true } }];
  assert.equal((await call({ tools })).status, 200);
  assert.equal(backend.bodies[0]!.priority, -3);
  assert.deepEqual(backend.bodies[0]!.tools, tools);
});

test("litellm: the endpoint key is the proxy's master key; without it preflight fails on the 401", async () => {
  const { front } = await stack("litellm", undefined, { masterKey: "sk-test-master" });
  assert.equal((await preflight({ url: front.url, apiKey: "sk-test-master" }, [MODEL])).ok, true);
  assert.match((await preflight({ url: front.url }, [MODEL])).error!, /returned 401/);
  const { call } = await governor(front.url, { endpoint: { url: front.url, apiKey: "sk-test-master" } });
  assert.equal((await call()).status, 200, "the governor sends PLANTWORKS_LLM_API_KEY as the bearer");
});

test("litellm: an unknown model is a 400, passed to Pi unchanged", async () => {
  const { front } = await stack("litellm");
  const { call } = await governor(front.url);
  const res = await call({ model: "absent:1b" });
  assert.equal(res.status, 400);
  assert.match((await res.json() as { error: { message: string } }).error.message, /Invalid model name passed in model=absent:1b/);
});

test("litellm: a backend 503 is retried by the proxy, so the governor sees a 200 and waits nothing", async () => {
  const { front, backend } = await stack("litellm", (n) => (n <= 2 ? 503 : "forward"));
  const { call, records } = await governor(front.url);
  const res = await call();
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("x-litellm-call-id"));
  assert.deepEqual([records[0]!.retries503, backend.bodies.length], [0, 3]);
});

test("litellm FINDING: a backend that stays busy becomes the proxy's 429, which the governor passes to Pi instead of waiting", async () => {
  const { front, backend } = await stack("litellm", () => 503);
  const { call, records, fails } = await governor(front.url);
  const res = await call();
  assert.equal(res.status, 429, "the governor waits out only 503 (governor.ts:159)");
  assert.ok(Number(res.headers.get("retry-after")) >= 1);
  assert.match((await res.json() as { error: { message: string } }).error.message, /No deployments available for selected model/);
  assert.deepEqual([records[0]!.retries503, backend.bodies.length, fails], [0, 3, []], "not a deadline either: Pi's own retries decide");
});

test("litellm FINDING: the proxy takes the priority, so vLLM never sees it; the response says it was used", async () => {
  const { front, backend } = await stack("litellm");
  const { call } = await governor(front.url, { priorityHints: true, priority: -3 });
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-litellm-request-prioritization-used"), "true");
  assert.equal("priority" in backend.bodies[0]!, false, "stripped by the proxy's scheduler");
});

test("litellm FINDING: a prioritised request queued while no deployment is healthy ends as a 408 at the proxy's timeout, passed to Pi", async () => {
  const { front, backend } = await stack("litellm", undefined, { requestTimeoutMs: 200 });
  front.coolDown(MODEL);
  const { call, records } = await governor(front.url, { priorityHints: true, priority: 0 });
  const res = await call();
  assert.equal(res.status, 408);
  assert.match((await res.json() as { error: { message: string } }).error.message, /timed out while polling queue/);
  assert.deepEqual([records[0]!.retries503, records[0]!.deadline, backend.bodies.length], [0, false, 0]);
});
