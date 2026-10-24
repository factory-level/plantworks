// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";

// Team `t`, whose one class has limits unlike either built-in class, so the tests show the
// worker path enforces the team spec's own perCall/context.
const PER_CALL = { maxOutputTokens: 700, deadlineSeconds: 1 };
function teamsDir() {
  const dir = mkdtempSync(join(tmpdir(), "pw-worker-teams-"));
  const emitted = emitTeam({
    team: "t", trains: 1, perTrain: { orchestrators: 1, workers: { small: 1 } },
    endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "t" }, defaultClass: "small",
    classes: { small: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 8192, thinkingTokens: 0 }, perCall: PER_CALL, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
    events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
  }, dir, { ...PHASE_0_1, slotCaps: { t: 1 } });
  assert.ok("files" in emitted);
  return dir;
}

/** Points `worker run` at a stub broker and LLM endpoint, with its own teams dir and home; restored after the test. */
function workerEnv(t: { after: (fn: () => void) => void }, brokerPort: number, llmUrl = "http://127.0.0.1:9/v1") {
  const home = mkdtempSync(join(tmpdir(), "pw-worker-home-"));
  const platform = join(home, "platform.json");
  writeFileSync(platform, JSON.stringify({ ...PHASE_0_1, slotCaps: { t: 1 } }));
  const env: Record<string, string> = { PLANTWORKS_BROKER_URL: `http://127.0.0.1:${brokerPort}`, PLANTWORKS_TEAMS_DIR: teamsDir(), PLANTWORKS_PLATFORM_FILE: platform, PLANTWORKS_LLM_URL: llmUrl, PLANTWORKS_GOVERNOR_PORT: "0", OPENRIG_HOME: home };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return home;
}

test("worker waits on an ambiguous reservation until logical completion before claiming again", async (t) => {
  let claims = 0;
  let state = "running";
  const server = createServer((req, res) => {
    if (req.url === "/plantworks/v1/claim-next" && req.method === "POST") {
      claims++;
      if (claims === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "handoff_unconfirmed", jobId: "job-a", qitemId: "qitem-a" }));
      } else {
        res.writeHead(204);
        res.end();
        server.close();
      }
      return;
    }
    if (req.url === "/plantworks/v1/jobs/job-a") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const oldArgv = process.argv;
  workerEnv(t, (server.address() as { port: number }).port);
  process.argv = ["node", "plantworks", "worker", "run", "--team", "t", "--seat", "s", "--poll-ms", "250"];
  t.after(() => { process.argv = oldArgv; });
  const program = new Command();
  const [{ workerVerb }] = await Promise.all([import("./worker.ts"), import("../../../packages/cli/dist/index.js")]);
  workerVerb(program);
  const running = import("../../../packages/cli/dist/index.js").then(({ runProgram }) => runProgram(program, process.argv));
  t.after(() => { process.emit("SIGTERM" as NodeJS.Signals); });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(claims, 1, "the reservation must prevent another claim while unresolved");
  state = "done";
  await new Promise<void>((resolve) => {
    const check = () => claims === 2 ? resolve() : setTimeout(check, 10);
    check();
  });
  assert.equal(claims, 2, "the worker may resume claiming after broker completion");
  process.emit("SIGTERM" as NodeJS.Signals);
  await running;
});

test("worker run resumes only its own seat at start, and a failed resume does not stop the loop", async (t) => {
  const seen: string[] = [];
  let claims = 0;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "DELETE") { res.writeHead(500).end("broker hiccup"); return; }
    if (req.url === "/plantworks/v1/claim-next") { claims++; res.writeHead(204).end(); return; }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const oldArgv = process.argv;
  const oldWrite = process.stderr.write;
  const errors: string[] = [];
  process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  workerEnv(t, (server.address() as { port: number }).port);
  process.argv = ["node", "plantworks", "worker", "run", "--team", "t", "--seat", "worker-0@team", "--poll-ms", "250"];
  t.after(() => {
    process.argv = oldArgv;
    process.stderr.write = oldWrite;
  });
  const program = new Command();
  const [{ workerVerb }, { runProgram }] = await Promise.all([import("./worker.ts"), import("../../../packages/cli/dist/index.js")]);
  workerVerb(program);
  const running = runProgram(program, process.argv);
  while (claims < 1) await new Promise((r) => setTimeout(r, 10));
  process.emit("SIGTERM" as NodeJS.Signals);
  await running;
  assert.deepEqual(seen.filter((s) => s.startsWith("DELETE")), ["DELETE /plantworks/v1/seats/worker-0%40team/drain"], "exactly its own seat, once");
  assert.ok(seen.indexOf("POST /plantworks/v1/claim-next") > seen.indexOf("DELETE /plantworks/v1/seats/worker-0%40team/drain"), "the resume comes before the first claim");
  assert.match(errors.join(""), /could not resume worker-0@team \(500\)/);
});

test("worker run governs its seat with the team spec class: perCall caps output and cuts calls at its deadline, a 503 waits without touching the job", async (t) => {
  // The broker hands out one job and reports it running; the worker must only read it.
  const brokerCalls: string[] = [];
  const broker = createServer((req, res) => {
    brokerCalls.push(`${req.method} ${req.url}`);
    if (req.method === "DELETE") { res.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
    if (req.url === "/plantworks/v1/claim-next") {
      if (brokerCalls.filter((c) => c.endsWith("claim-next")).length > 1) { res.writeHead(204).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ job: { jobId: "job-a" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ state: "running" }));
  });
  // A stub OpenAI-compatible endpoint: 503 twice, then answers; `/slow` never answers.
  const seen: { path: string; body: Record<string, unknown>; auth?: string }[] = [];
  let busy = 2;
  const llm = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url!, body: raw ? JSON.parse(raw) : {}, auth: req.headers.authorization });
    if (req.url!.startsWith("/v1/slow")) return; // held open past the deadline
    if (busy-- > 0) { res.writeHead(503).end("queue full"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  });
  for (const s of [broker, llm]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  t.after(() => { broker.close(); llm.closeAllConnections(); llm.close(); });
  const port = (s: typeof broker) => (s.address() as { port: number }).port;
  const home = workerEnv(t, port(broker), `http://127.0.0.1:${port(llm)}/v1`);
  process.env.PLANTWORKS_LLM_API_KEY = "test-key";
  const oldArgv = process.argv;
  process.argv = ["node", "plantworks", "worker", "run", "--team", "t", "--seat", "worker-0@t", "--poll-ms", "250"];
  t.after(() => { process.argv = oldArgv; delete process.env.PLANTWORKS_LLM_API_KEY; });
  const program = new Command();
  const [{ workerVerb }, { runProgram }] = await Promise.all([import("./worker.ts"), import("../../../packages/cli/dist/index.js")]);
  workerVerb(program);
  const running = runProgram(program, process.argv);
  t.after(() => { process.emit("SIGTERM" as NodeJS.Signals); });

  const agentDir = join(home, "state", "pi", "worker-0@t", "agent");
  let models: { providers: Record<string, { baseUrl: string; apiKey: string; models: { contextWindow: number; maxTokens: number }[] }> } | undefined;
  while (!models) {
    try { models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")); } catch { await new Promise((r) => setTimeout(r, 20)); }
  }
  const provider = Object.values(models.providers)[0]!;
  assert.deepEqual([provider.models[0]!.contextWindow, provider.models[0]!.maxTokens], [8192, 700], "the seat files carry the team class, not a built-in class");
  assert.notEqual(provider.apiKey, "test-key", "the key stays in the governor");

  // What Pi would send, through the seat's baseUrl.
  const reply = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.5:9b", max_tokens: 99_999, num_ctx: 65_536, messages: [] }) });
  assert.equal(reply.status, 200, "two 503s are waited out");
  const calls = seen.filter((c) => c.path === "/v1/chat/completions");
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.body.max_tokens, PER_CALL.maxOutputTokens, "perCall.maxOutputTokens caps every call");
    assert.equal(c.body.num_ctx, undefined);
    assert.equal(c.auth, "Bearer test-key");
  }
  const started = Date.now();
  const cut = await fetch(`${provider.baseUrl}/slow`, { method: "POST", body: "{}" });
  assert.equal(cut.status, 504, "perCall.deadlineSeconds cuts the call");
  assert.ok(Date.now() - started < 5_000, "cut at the team's 1 s deadline, not the built-in 60 s");

  assert.deepEqual([...new Set(brokerCalls.map((c) => c.split(" ")[0]))].sort(), ["DELETE", "GET", "POST"]);
  assert.ok(brokerCalls.every((c) => c.startsWith("GET /plantworks/v1/jobs/job-a") || c.endsWith("/claim-next") || c.startsWith("DELETE")), "a 503 or a cut call changes nothing in the broker: the job stays as the broker has it");
  process.emit("SIGTERM" as NodeJS.Signals);
  await running;
  await assert.rejects(fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", body: "{}" }), "a stopped worker's governor takes no more calls");
});

test("worker run refuses to start without a valid team spec or an endpoint, before it claims anything", async () => {
  const { governSeat } = await import("./worker.ts");
  const home = mkdtempSync(join(tmpdir(), "pw-worker-home-"));
  const platform = join(home, "platform.json");
  writeFileSync(platform, JSON.stringify({ ...PHASE_0_1, slotCaps: { t: 1 } }));
  const base = { team: "t", seat: "s", teamsDir: teamsDir(), platform, port: 0, openrigHome: home, env: { PLANTWORKS_LLM_URL: "http://127.0.0.1:9/v1" } };
  await assert.rejects(governSeat({ ...base, teamsDir: undefined }), /no team specs/);
  await assert.rejects(governSeat({ ...base, openrigHome: undefined }), /OPENRIG_HOME/);
  await assert.rejects(governSeat({ ...base, class: "huge" }), /no class huge/);
  await assert.rejects(governSeat({ ...base, team: "other" }), /no team spec for other/);
  await assert.rejects(governSeat({ ...base, env: {} }), /PLANTWORKS_LLM_URL/);
  // The default platform has no slot cap for `t`, so the spec doesn't validate against it.
  await assert.rejects(governSeat({ ...base, platform: undefined }), /over the platform cap/);
});
