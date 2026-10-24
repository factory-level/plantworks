// SPDX-License-Identifier: Apache-2.0
// Every test talks to a local stub OpenAI-compatible server, never to shared inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLASSES, ceilingProblems } from "./classes.ts";
import { preflight, readEndpoint } from "./endpoint.ts";
import { governBody, startGovernor, usageOf, type CallRecord } from "./governor.ts";

type Seen = { method: string; url: string; auth?: string; body: string };

async function stub(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const s = { method: req.method!, url: req.url!, auth: req.headers.authorization, body };
    seen.push(s);
    handler(req, res, s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, seen, close: () => new Promise<void>((r) => {
    if (!server.listening) return r();
    server.closeAllConnections();
    server.close(() => r());
  }) };
}

const models = (ids: string[]) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
};

test("PLANTWORKS_LLM_URL is required, http(s), credential-free, and loses its trailing slash", () => {
  assert.throws(() => readEndpoint({}), /PLANTWORKS_LLM_URL is not set/);
  assert.throws(() => readEndpoint({ PLANTWORKS_LLM_URL: "ftp://example.invalid/v1" }), /must be http/);
  assert.throws(() => readEndpoint({ PLANTWORKS_LLM_URL: "http://u:p@example.invalid/v1" }), /must not carry credentials/);
  assert.deepEqual(readEndpoint({ PLANTWORKS_LLM_URL: "http://example.invalid/v1/", PLANTWORKS_LLM_API_KEY: "k" }), { url: "http://example.invalid/v1", apiKey: "k" });
});

test("preflight lists models only and reports what is missing, failing, or silent", async () => {
  const s = await stub(models(["qwen3.5:9b", "other"]));
  const ok = await preflight({ url: s.url, apiKey: "secret" }, ["qwen3.5:9b"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(s.seen.map((r) => [r.method, r.url, r.auth]), [["GET", "/v1/models", "Bearer secret"]]);
  const missing = await preflight({ url: s.url }, ["qwen3.5:9b", "absent:1b"]);
  assert.deepEqual([missing.ok, missing.missing, missing.error], [false, ["absent:1b"], "not served: absent:1b"]);
  await s.close();

  const down = await stub((_q, res) => res.writeHead(500).end());
  assert.match((await preflight({ url: down.url }, ["m"])).error!, /returned 500/);
  await down.close();

  const silent = await stub(() => {});
  assert.match((await preflight({ url: silent.url }, ["m"], 100)).error!, /no answer within 100 ms/);
  await silent.close();
});

test("shipped classes are within the platform ceilings, and oversized ones are named", () => {
  for (const c of Object.values(CLASSES)) assert.deepEqual(ceilingProblems(c), []);
  assert.deepEqual(ceilingProblems({ model: "m", maxContextTokens: 32768, maxOutputTokens: 1536, deadlineSeconds: 90 }), ["deadline 90s > 60s", "output 1536 > 1024 tokens"]);
  assert.deepEqual(ceilingProblems({ model: "m", maxContextTokens: 65536, maxOutputTokens: 100, deadlineSeconds: 60 }), ["context 65536 > 32768"]);
});

test("governBody caps output and strips context resizing", () => {
  const gov = (o: object) => JSON.parse(governBody(Buffer.from(JSON.stringify(o)), CLASSES.quick).toString());
  assert.deepEqual(gov({ model: "m", max_tokens: 99999, options: { num_ctx: 65536 }, num_ctx: 65536 }), { model: "m", max_tokens: 1536 });
  assert.deepEqual(gov({ model: "m" }), { model: "m", max_tokens: 1536 });
  assert.deepEqual(gov({ model: "m", max_tokens: 200, max_completion_tokens: 5000 }), { model: "m", max_tokens: 200, max_completion_tokens: 1536 });
  assert.equal(governBody(Buffer.from("not json"), CLASSES.quick).toString(), "not json");
});

test("the governor streams through, with the budgeted body and the endpoint key", async () => {
  const s = await stub((_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'), 20);
  });
  const records: CallRecord[] = [];
  const g = await startGovernor({ endpoint: { url: s.url, apiKey: "endpoint-key" }, workerClass: CLASSES.quick, log: (r) => records.push(r) });
  const res = await fetch(`${g.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer pi-placeholder" },
    body: JSON.stringify({ model: "qwen3.5:9b", stream: true, max_tokens: 8000, options: { num_ctx: 32768 }, messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /hel[\s\S]*lo[\s\S]*\[DONE\]/);
  assert.equal(s.seen[0].url, "/v1/chat/completions");
  assert.equal(s.seen[0].auth, "Bearer endpoint-key");
  assert.deepEqual(JSON.parse(s.seen[0].body), { model: "qwen3.5:9b", stream: true, max_tokens: 1536, messages: [] });
  assert.deepEqual([records[0].status, records[0].deadline, records[0].retries503], [200, false, 0]);
  await g.close();
  await s.close();
});

test("a full endpoint queue (503) is waited out, not counted as a failed attempt", async () => {
  let calls = 0;
  const s = await stub((_q, res) => (++calls <= 2 ? res.writeHead(503).end() : models(["m"])(_q, res)));
  const records: CallRecord[] = [];
  const g = await startGovernor({ endpoint: { url: s.url }, workerClass: CLASSES.quick, log: (r) => records.push(r), backoffMs: { first: 10, max: 15 } });
  const res = await fetch(`${g.url}/models`);
  assert.equal(res.status, 200);
  assert.deepEqual([records[0].retries503, records[0].waitMs, records[0].deadline], [2, 25, false]);
  await g.close();
  await s.close();
});

test("each call is cut at the deadline, and three in a row fail the job once with call-deadline", async () => {
  let hang = true;
  const s = await stub((_q, res) => { if (!hang) models(["m"])(_q, res); });
  const fails: string[] = [];
  const records: CallRecord[] = [];
  const workerClass = { ...CLASSES.quick, deadlineSeconds: 0.1 };
  const g = await startGovernor({ endpoint: { url: s.url }, workerClass, onFail: (r) => fails.push(r), log: (r) => records.push(r) });
  const call = async () => (await fetch(`${g.url}/models`)).status;
  assert.deepEqual([await call(), await call()], [504, 504]);
  hang = false;
  assert.equal(await call(), 200, "a good call resets the run of deadlines");
  hang = true;
  assert.deepEqual([await call(), await call(), await call(), await call()], [504, 504, 504, 504]);
  assert.deepEqual(fails, ["call-deadline"]);
  assert.ok(records.filter((r) => r.deadline).every((r) => r.holdMs >= 100 && r.holdMs < 1000));
  await g.close();
  await s.close();
});

test("an endpoint error between deadline aborts also breaks the run", async () => {
  let reply: number | null = null;
  const s = await stub((_q, res) => { if (reply) res.writeHead(reply).end(); });
  const fails: string[] = [];
  const g = await startGovernor({ endpoint: { url: s.url }, workerClass: { ...CLASSES.quick, deadlineSeconds: 0.1 }, onFail: (r) => fails.push(r), log: () => {} });
  const call = async (r: number | null) => { reply = r; return (await fetch(`${g.url}/models`)).status; };
  try {
    assert.deepEqual([await call(null), await call(null), await call(500), await call(null)], [504, 504, 500, 504]);
    assert.deepEqual(fails, [], "only two deadline aborts were consecutive");
  } finally {
    await g.close();
    await s.close();
  }
});

test("cutOff refuses the seat's calls and aborts the one in flight; restore lets calls through again", async (t) => {
  const s = await stub((req, res) => { if (req.url!.endsWith("/slow")) return; res.writeHead(200).end("{}"); });
  const records: CallRecord[] = [];
  const g = await startGovernor({ endpoint: { url: s.url }, workerClass: CLASSES.quick, log: (r) => records.push(r) });
  t.after(async () => { await g.close(); await s.close(); });
  const pending = fetch(`${g.url}/slow`, { method: "POST", body: "{}" });
  while (!s.seen.length) await new Promise((r) => setTimeout(r, 10));
  g.cutOff("job x passed its timeout");
  const aborted = await pending;
  assert.equal(aborted.status, 403, "the call in flight is aborted, not left to the 60 s deadline");
  assert.match(await aborted.text(), /cut off: job x passed its timeout/);
  const refused = await fetch(`${g.url}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(refused.status, 403);
  assert.equal(s.seen.length, 1, "a refused call never reaches the endpoint");
  g.restore();
  assert.equal((await fetch(`${g.url}/chat/completions`, { method: "POST", body: "{}" })).status, 200);
  assert.deepEqual(records.map((r) => [r.status, r.deadline]), [[403, false], [403, false], [200, false]]);
});

test("the governor totals the endpoint-reported tokens of successful completions, JSON or SSE", async (t) => {
  let reply = 0;
  const s = await stub((req, res) => {
    reply++;
    if (reply === 1) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    if (reply === 2) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      return res.end('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
    }
    if (reply === 3) return res.writeHead(200).end("{}"); // reports no usage: adds nothing
    return res.writeHead(400).end(JSON.stringify({ usage: { prompt_tokens: 999, completion_tokens: 999 } })); // a failed call is not counted
  });
  const g = await startGovernor({ endpoint: { url: s.url }, workerClass: CLASSES.quick, log: () => {} });
  t.after(async () => { await g.close(); await s.close(); });
  for (let i = 0; i < 4; i++) await (await fetch(`${g.url}/chat/completions`, { method: "POST", body: "{}" })).text();
  await (await fetch(`${g.url}/models`)).text(); // not a completion
  assert.deepEqual(g.usage(), { promptTokens: 107, completionTokens: 23 });
  assert.equal(usageOf("not json"), undefined);
  assert.deepEqual(usageOf('{"usage":{"prompt_tokens":1,"completion_tokens":2}}'), { promptTokens: 1, completionTokens: 2 });
});

test("`plantworks pw llm preflight` checks the class model against the endpoint", async () => {
  const s = await stub(models(["qwen3.5:9b"]));
  try {
    const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
    const run = (env: object) => promisify(execFile)(process.execPath, [bin, "pw", "llm", "preflight", "--json"], { env: { ...process.env, ...env } });
    const ok = await run({ PLANTWORKS_LLM_URL: s.url });
    assert.equal(JSON.parse(ok.stdout).ok, true);
    await s.close();
    await assert.rejects(run({ PLANTWORKS_LLM_URL: s.url }), (e: { code: number; stdout: string }) => e.code === 1 && JSON.parse(e.stdout).ok === false);
  } finally {
    await s.close();
  }
});
