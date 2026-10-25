// SPDX-License-Identifier: Apache-2.0
// Every test talks to a local stub OpenAI-compatible server, never to shared inference.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLASSES, ceilingProblems } from "./classes.ts";
import { preflight, readEndpoint } from "./endpoint.ts";
import { governBody, startGovernor as startGovernorUntracked, usageOf, type CallRecord, type GovernorOptions } from "./governor.ts";
import { emitTeam } from "../team/command.ts";

type Seen = { method: string; url: string; auth?: string; body: string };

// Every stub server and governor a test starts is closed after it, pass or fail: one left listening
// keeps this file's process alive, so a failed assertion would hang the file until the per-test
// timeout instead of being reported. Both closes are idempotent.
const open = new Set<() => Promise<unknown>>();
afterEach(async () => {
  const closing = [...open];
  open.clear();
  await Promise.all(closing.map((close) => close()));
});
async function startGovernor(opts: GovernorOptions) {
  const g = await startGovernorUntracked(opts);
  open.add(g.close);
  return g;
}

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
  const close = () => new Promise<void>((r) => {
    if (!server.listening) return r();
    server.closeAllConnections();
    server.close(() => r());
  });
  open.add(close);
  return { url, seen, close };
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
  // Bounded: if the deadline didn't cut a call, it would never answer, so fail here and say so.
  const call = async () => {
    const res = await fetch(`${g.url}/models`, { signal: AbortSignal.timeout(5000) }).catch((e: Error) => { throw new Error(`the call was not cut at the 100 ms deadline within 5 s (${e.name})`); });
    return res.status;
  };
  assert.deepEqual([await call(), await call()], [504, 504]);
  hang = false;
  assert.equal(await call(), 200, "a good call resets the run of deadlines");
  hang = true;
  assert.deepEqual([await call(), await call(), await call(), await call()], [504, 504, 504, 504]);
  assert.deepEqual(fails, ["call-deadline"]);
  // Each cut call was aborted at the deadline: a 504 marked deadline, held at least the 100 ms deadline
  // less clock granularity (a 100 ms timer can read 99 ms on Date.now), and nowhere near "never".
  // No tight upper bound: a loaded CI runner may run the abort late.
  const cut = records.filter((r) => r.deadline);
  assert.equal(cut.length, 6);
  for (const r of cut) {
    assert.equal(r.status, 504);
    assert.ok(r.holdMs >= 90, `held ${r.holdMs} ms, under the 100 ms deadline`);
    assert.ok(r.holdMs < 5000, `held ${r.holdMs} ms: the deadline did not cut the call`);
  }
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
  assert.equal(g.usage(), undefined, "unknown until a call reports usage");
  for (let i = 0; i < 4; i++) await (await fetch(`${g.url}/chat/completions`, { method: "POST", body: "{}" })).text();
  await (await fetch(`${g.url}/models`)).text(); // not a completion
  assert.deepEqual(g.usage(), { promptTokens: 107, completionTokens: 23 });
  assert.equal(usageOf("not json"), undefined);
  assert.deepEqual(usageOf('{"usage":{"prompt_tokens":1,"completion_tokens":2}}'), { promptTokens: 1, completionTokens: 2 });
});

test("W4-A holdUntilArmed: completions wait until armed (hints off too); a held call whose client leaves is dropped; disarming holds again", async () => {
  const s = await stub((_q, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  const g = await startGovernor({ endpoint: { url: s.url }, workerClass: CLASSES.quick, log: () => {}, holdUntilArmed: true });
  const call = (signal?: AbortSignal) => fetch(`${g.url}/chat/completions`, { method: "POST", body: "{}", signal }).then((r) => r.status);
  const first = call();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.seen.length, 0, "held: nothing reached the endpoint before arming");
  const gone = new AbortController();
  const dropped = call(gone.signal).catch(() => "aborted");
  await new Promise((r) => setTimeout(r, 100));
  gone.abort();
  assert.equal(await dropped, "aborted");
  await new Promise((r) => setTimeout(r, 100)); // let the governor see the closed connection, as #96's test does
  g.setArmed(true);
  assert.equal(await first, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.seen.length, 1, "the abandoned held call was never sent");
  assert.equal((await (await fetch(`${g.url}/models`)).status), 200, "only completions are held");
  g.setArmed(false);
  const again = call();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.seen.filter((x) => x.url.endsWith("/chat/completions")).length, 1, "held again after disarming");
  g.setArmed(true);
  assert.equal(await again, 200);
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

test("`plantworks pw llm preflight` with team specs checks every model their classes name, not just the default class", async () => {
  const quick = { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 };
  const team = (name: string, model: string) => ({
    team: name, trains: 1, perTrain: { orchestrators: 1, workers: { quick: 1, big: 1 } },
    endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: name }, defaultClass: "quick",
    classes: { quick, big: { ...quick, model } }, events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
  });
  const platform = { slotCaps: { a: 2, b: 2 }, models: ["qwen3.5:9b", "other-a:7b", "other-b:3b"], maxContextTokens: 32768 };
  const root = mkdtempSync(join(tmpdir(), "pw-preflight-"));
  const teams = join(root, "teams");
  const platformFile = join(root, "platform.json");
  writeFileSync(platformFile, JSON.stringify(platform));
  for (const [name, model] of [["a", "other-a:7b"], ["b", "other-b:3b"]]) assert.ok("files" in emitTeam(team(name, model), teams, platform));
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const run = (args: string[], env: Record<string, string>) => promisify(execFile)(process.execPath, [bin, "pw", "llm", "preflight", "--json", ...args],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ...env } })
    .then((r) => ({ code: 0, out: r.stdout, err: r.stderr }), (e) => ({ code: e.code as number, out: e.stdout as string, err: e.stderr as string }));
  const partial = await stub(models(["qwen3.5:9b", "other-a:7b"]));
  const full = await stub(models(["qwen3.5:9b", "other-a:7b", "other-b:3b", "unrelated"]));
  try {
    const missing = await run(["--teams", teams, "--platform", platformFile], { PLANTWORKS_LLM_URL: partial.url });
    assert.equal(missing.code, 1, missing.err);
    assert.deepEqual(JSON.parse(missing.out).checked, ["other-a:7b", "other-b:3b", "qwen3.5:9b"]);
    assert.deepEqual(JSON.parse(missing.out).missing, ["other-b:3b"], "the default class's model alone would have passed");

    const served = await run(["--teams", teams, "--platform", platformFile], { PLANTWORKS_LLM_URL: full.url });
    assert.equal(served.code, 0, served.err);
    assert.equal(JSON.parse(served.out).source, "teams");

    const fromEnv = await run(["--platform", platformFile], { PLANTWORKS_LLM_URL: partial.url, PLANTWORKS_TEAMS_DIR: teams });
    assert.deepEqual(JSON.parse(fromEnv.out).missing, ["other-b:3b"], "PLANTWORKS_TEAMS_DIR selects the same specs");

    const bad = await run(["--teams", join(root, "nowhere")], { PLANTWORKS_LLM_URL: full.url });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /preflight: /);

    // An explicit --class wins over an ambient PLANTWORKS_TEAMS_DIR (the image sets one); explicit conflicts refuse.
    const explicit = await run(["--class", "long"], { PLANTWORKS_LLM_URL: partial.url, PLANTWORKS_TEAMS_DIR: teams });
    assert.equal(explicit.code, 0, explicit.err);
    assert.deepEqual([JSON.parse(explicit.out).source, JSON.parse(explicit.out).checked], ["class", ["qwen3.5:9b"]]);
    for (const args of [["--class", "long", "--teams", teams], ["--platform", platformFile]]) {
      const refused = await run(args, { PLANTWORKS_LLM_URL: full.url });
      assert.equal(refused.code, 2, args.join(" "));
      assert.match(refused.err, /preflight: /, args.join(" "));
    }

    const classOnly = await run([], { PLANTWORKS_LLM_URL: partial.url });
    assert.equal(classOnly.code, 0, classOnly.err);
    assert.deepEqual([JSON.parse(classOnly.out).source, JSON.parse(classOnly.out).checked], ["class", ["qwen3.5:9b"]]);
  } finally {
    await partial.close();
    await full.close();
    rmSync(root, { recursive: true, force: true });
  }
});
