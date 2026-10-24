// SPDX-License-Identifier: Apache-2.0
// The Hermes kit against a stub broker: an SDK client calls the tools in memory, over HTTP and
// over stdio through the real binary. No real Hermes, broker or inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createKit, serveHttp, HELD_NOTE, RESULT_PAGE_CHARS, MESSAGE_CHARS } from "./kit.ts";
import { kitOptions } from "./command.ts";

const TEAM = "social-media";
const BROKER_TOKEN = "broker-secret-value";
type Rec = Record<string, unknown> & { envelope?: unknown };

/** A stub of the PW-17 jobs API, with knobs for the cases a real broker should never produce. */
async function stubBroker(opts: { token?: string; foreignReplay?: boolean; status?: number } = {}) {
  const jobs = new Map<string, Rec>();
  const calls: Array<{ method: string; path: string; auth?: string }> = [];
  const record = (r: Rec) => { const { envelope: _, ...rest } = r; return rest; };
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = req.url!.replace("/plantworks/v1", "");
    calls.push({ method: req.method!, path, auth: req.headers.authorization });
    if (opts.status) return send(opts.status, { error: "boom", message: "stub status" });
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { error: "unauthorized", message: "no" });
    const m = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(path);
    if (req.method === "POST" && path === "/jobs") {
      const env = JSON.parse(text);
      if (env.class === "nope") return send(400, { error: "unknown_class", message: `team ${env.team} has no class nope` });
      const old = jobs.get(env.jobId);
      if (old) {
        if (opts.foreignReplay) return send(200, record(old));
        return JSON.stringify(old.envelope) === JSON.stringify(env) ? send(200, record(old)) : send(409, { error: "job_conflict", message: "exists", job: record(old) });
      }
      const rec = { jobId: env.jobId, team: env.team, class: env.class ?? "quick", state: "queued", detail: {}, createdAt: "t", updatedAt: "t", result: null, envelope: env };
      jobs.set(env.jobId, rec);
      return send(201, record(rec));
    }
    if (m && !m[2] && req.method === "GET") {
      const rec = jobs.get(decodeURIComponent(m[1]));
      return rec ? send(200, record(rec)) : send(404, { error: "not_found", message: "no job" });
    }
    if (m && m[2] && req.method === "POST") {
      const rec = jobs.get(decodeURIComponent(m[1]));
      if (!rec) return send(404, { error: "not_found", message: "no job" });
      if (rec.state === "queued" || rec.state === "held") Object.assign(rec, { state: "cancelled", detail: { reason: "front-door" } });
      return rec.state === "cancelled" ? send(200, record(rec)) : send(409, { error: "not_cancellable", message: "no", job: record(rec) });
    }
    send(404, { error: "not_found", message: "route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const put = (jobId: string, team: string, extra: Rec = {}) =>
    jobs.set(jobId, { jobId, team, class: "quick", state: "queued", detail: {}, createdAt: "t", updatedAt: "t", result: null, envelope: { secret: `${team} private prompt` }, ...extra });
  return { url, jobs, calls, put, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

async function connect(brokerUrl: string, brokerToken?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createKit({ brokerUrl, team: TEAM, brokerToken }).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const outputs: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(r));
    return { error: r.isError === true, data: r.structuredContent as Record<string, any>, text: (r.content as Array<{ text: string }>)[0].text };
  };
  return { client, call, outputs };
}

const submitArgs = (extra: Record<string, unknown> = {}) => ({ board: "social-media", cardId: "t_3fa9c01e", attempt: 1, prompt: "write the post", title: "post", ...extra });

test("submit is idempotent, fixes the team itself, and checks the envelope before the broker", async () => {
  const broker = await stubBroker();
  const { call, client } = await connect(broker.url);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["job_cancel", "job_inspect", "job_submit"]);

  const first = await call("job_submit", submitArgs({ team: "other-team" }));
  assert.deepEqual(first.data, { jobId: "kb-social-media-t_3fa9c01e-a1", state: "queued", created: true });
  assert.equal((broker.jobs.get("kb-social-media-t_3fa9c01e-a1")!.envelope as { team: string }).team, TEAM);
  assert.equal((await call("job_submit", submitArgs())).data.created, false);

  const before = broker.calls.length;
  const bad = await call("job_submit", submitArgs({ board: "Not A Slug" }));
  assert.equal(bad.error, true);
  assert.equal(bad.data.code, "invalid_envelope");
  assert.equal(broker.calls.length, before, "an invalid envelope never reaches the broker");

  const cls = await call("job_submit", submitArgs({ cardId: "t_00000001", class: "nope" }));
  assert.deepEqual([cls.data.code, cls.data.brokerError], ["broker_rejected", "unknown_class"]);
  await broker.close();
});

test("isolation: nothing of another team's job comes back through submit, inspect or cancel", async () => {
  const broker = await stubBroker();
  const { call } = await connect(broker.url);
  const foreign = "kb-social-media-t_3fa9c01e-a1"; // the same jobId, held by another team
  broker.put(foreign, "other-team", { state: "queued" });
  const leaks = (t: string) => /other-team|private prompt/.test(t);

  const clash = await call("job_submit", submitArgs());
  assert.deepEqual(clash.data, { ok: false, code: "job_conflict", message: `job ${foreign} already exists with a different envelope`, jobId: foreign });
  assert.equal(leaks(clash.text), false);

  const inspect = await call("job_inspect", { jobId: foreign });
  const unknown = await call("job_inspect", { jobId: "kb-x-t_1-a1" });
  assert.equal(inspect.data.code, "not_found");
  for (const odd of ["..", "x/../y", "../jobs"]) {
    const before = broker.calls.length;
    assert.equal((await call("job_inspect", { jobId: odd })).data.code, "not_found", odd);
    assert.equal((await call("job_cancel", { jobId: odd })).data.code, "not_found", odd);
    assert.equal(broker.calls.length, before, "a malformed jobId never reaches the broker");
  }
  assert.equal(inspect.data.message.replace(foreign, "ID"), unknown.data.message.replace("kb-x-t_1-a1", "ID"), "another team's job reads exactly like an unknown one");
  assert.equal(leaks(inspect.text), false);

  const cancel = await call("job_cancel", { jobId: foreign });
  assert.equal(cancel.data.code, "not_found");
  assert.equal(broker.calls.filter((c) => c.path.endsWith("/cancel")).length, 0, "no cancel reaches the broker");
  assert.equal(broker.jobs.get(foreign)!.state, "queued");
  await broker.close();

  const replaying = await stubBroker({ foreignReplay: true });
  replaying.put(foreign, "other-team");
  const second = await connect(replaying.url);
  const replay = await second.call("job_submit", submitArgs());
  assert.equal(replay.data.code, "job_conflict", "a 200 carrying another team's record is refused");
  assert.equal(leaks(replay.text), false);
  await replaying.close();
});

test("inspect pages the result text, lists artifacts as metadata only and caps messages", async () => {
  const broker = await stubBroker();
  const { call } = await connect(broker.url);
  const text = "x".repeat(2 * RESULT_PAGE_CHARS) + "y".repeat(8000);
  broker.put("kb-b-t_1-a1", TEAM, { state: "done", detail: { outcome: "succeeded" }, result: { text, artifacts: [{ name: "r.md", bytes: 3, sha256: "a".repeat(64), content: "BYTES" }] } });
  const p1 = await call("job_inspect", { jobId: "kb-b-t_1-a1" });
  assert.equal(p1.data.result.text.length, RESULT_PAGE_CHARS);
  assert.deepEqual([p1.data.result.totalChars, p1.data.result.truncated], [text.length, true]);
  assert.deepEqual(p1.data.result.artifacts, [{ name: "r.md", bytes: 3, sha256: "a".repeat(64) }]);
  assert.equal(p1.text.includes("BYTES"), false);
  const p3 = await call("job_inspect", { jobId: "kb-b-t_1-a1", resultOffset: 2 * RESULT_PAGE_CHARS });
  assert.deepEqual([p3.data.result.text, p3.data.result.truncated], ["y".repeat(8000), false]);

  broker.put("kb-b-t_2-a1", TEAM, { state: "failed", detail: { reason: "error", message: "e".repeat(10_000) } });
  const failed = await call("job_inspect", { jobId: "kb-b-t_2-a1" });
  assert.equal(failed.data.detail.message.length, MESSAGE_CHARS);
  assert.equal("result" in failed.data, false, "no result before a worker reports one");
  await broker.close();
});

test("cancel works before a job starts, is idempotent, and refuses a running job", async () => {
  const broker = await stubBroker();
  const { call } = await connect(broker.url);
  broker.put("kb-b-t_1-a1", TEAM);
  broker.put("kb-b-t_2-a1", TEAM, { state: "running" });
  assert.deepEqual((await call("job_cancel", { jobId: "kb-b-t_1-a1" })).data, { jobId: "kb-b-t_1-a1", state: "cancelled" });
  assert.equal((await call("job_cancel", { jobId: "kb-b-t_1-a1" })).data.state, "cancelled");
  const running = await call("job_cancel", { jobId: "kb-b-t_2-a1" });
  assert.deepEqual([running.data.code, running.data.state], ["not_cancellable", "running"]);
  await broker.close();
});

test("the broker token goes only to the broker and never into output; broker faults map to codes", async () => {
  const broker = await stubBroker({ token: BROKER_TOKEN });
  const good = await connect(broker.url, BROKER_TOKEN);
  await good.call("job_submit", submitArgs());
  await good.call("job_inspect", { jobId: "kb-social-media-t_3fa9c01e-a1" });
  assert.ok(broker.calls.every((c) => c.auth === `Bearer ${BROKER_TOKEN}`));
  assert.equal(good.outputs.some((o) => o.includes(BROKER_TOKEN)), false);
  const wrong = await connect(broker.url, "wrong");
  assert.equal((await wrong.call("job_inspect", { jobId: "kb-b-t_1-a1" })).data.code, "broker_auth_failed");
  await broker.close();

  const down = await stubBroker({ status: 503 });
  assert.equal((await (await connect(down.url)).call("job_inspect", { jobId: "kb-b-t_1-a1" })).data.code, "broker_unavailable");
  await down.close();

  // A redirect is never followed, so the token cannot be carried to another address.
  const target = await stubBroker();
  const redirect = http.createServer((_, res) => res.writeHead(302, { location: `${target.url}/plantworks/v1/jobs/x` }).end());
  await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
  const via = await connect(`http://127.0.0.1:${(redirect.address() as { port: number }).port}`, BROKER_TOKEN);
  assert.equal((await via.call("job_inspect", { jobId: "kb-b-t_1-a1" })).data.code, "broker_unavailable");
  assert.equal(target.calls.length, 0);
  redirect.close();
  await target.close();
});

test("over HTTP every request needs the bearer token", async () => {
  const broker = await stubBroker();
  await assert.rejects(serveHttp({ brokerUrl: broker.url, team: TEAM, host: "127.0.0.1", port: 0, token: " " }), /PLANTWORKS_MCP_TOKEN/);
  const server = await serveHttp({ brokerUrl: broker.url, team: TEAM, host: "127.0.0.1", port: 0, token: "mcp-token" });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const post = (auth?: string) => fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(init),
  });
  assert.equal((await post()).status, 401);
  assert.equal((await post("Bearer wrong")).status, 401);

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer mcp-token" } } }));
  const r = await client.callTool({ name: "job_submit", arguments: submitArgs() });
  assert.equal((r.structuredContent as { created: boolean }).created, true);
  await client.close();
  await server.close();
  await broker.close();
});

test("`plantworks pw mcp serve` over stdio needs a team and serves the three tools", async () => {
  assert.throws(() => kitOptions({}), /PLANTWORKS_TEAM/);
  assert.equal(kitOptions({ PLANTWORKS_TEAM: TEAM }).brokerUrl, "http://127.0.0.1:7534");
  const broker = await stubBroker();
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bin, "pw", "mcp", "serve"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PLANTWORKS_TEAM: TEAM, PLANTWORKS_BROKER_URL: broker.url },
    stderr: "ignore",
  }));
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["job_cancel", "job_inspect", "job_submit"]);
  const r = await client.callTool({ name: "job_submit", arguments: submitArgs() });
  assert.equal((r.structuredContent as { jobId: string }).jobId, "kb-social-media-t_3fa9c01e-a1");
  await client.close();
  await broker.close();
});

test("the kit calls only the three jobs routes, never an approval decision URL", async () => {
  const broker = await stubBroker();
  const { call } = await connect(broker.url);
  broker.put("kb-b-t_1-a1", TEAM, { state: "held", detail: { decisionUrl: `${broker.url}/plantworks/v1/approvals/x` } });
  await call("job_submit", submitArgs());
  const held = await call("job_inspect", { jobId: "kb-b-t_1-a1" });
  assert.equal(held.data.note, HELD_NOTE, "a held job says approval is outside the kit");
  await call("job_cancel", { jobId: "kb-b-t_1-a1" });
  await call("job_cancel", { jobId: "kb-social-media-t_3fa9c01e-a1" });
  const routes = broker.calls.map((c) => `${c.method} ${c.path.replace(/^\/jobs\/[^/]+/, "/jobs/{id}")}`);
  assert.deepEqual([...new Set(routes)].sort(), ["GET /jobs/{id}", "POST /jobs", "POST /jobs/{id}/cancel"]);
  await broker.close();
});
