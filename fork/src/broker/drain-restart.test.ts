// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { claimNextRoutes, type DaemonQueue } from "./claim.ts";
import { runtimeRoutes } from "./runtime.ts";
import { API, startBroker, loadTeams, type BrokerRoutes } from "./server.ts";
import { openStore } from "./store.ts";
import { parseSlotCaps } from "./slots.ts";

const seat = "worker-0@t";
const first = "kb-t-card1-a1";
const second = "kb-t-card2-a1";
const definition = {
  team: "t", trains: 1, perTrain: { orchestrators: 1, workers: { small: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "t" }, defaultClass: "small",
  classes: { small: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 8192, thinkingTokens: 0 }, perCall: { maxOutputTokens: 700, deadlineSeconds: 1 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
};

test("broker restart preserves drain; worker restart resumes the seat without skipping held work", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pw-drain-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const teams = join(dir, "teams");
  assert.ok("files" in emitTeam(definition, teams, { ...PHASE_0_1, slotCaps: { t: 1 } }));
  const home = join(dir, "home");
  const platform = join(home, "platform.json");
  const teamsDir = join(home, "teams");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(home, { recursive: true }));
  assert.ok("files" in emitTeam(definition, teamsDir, { ...PHASE_0_1, slotCaps: { t: 1 } }));
  writeFileSync(platform, JSON.stringify({ ...PHASE_0_1, slotCaps: { t: 1 } }));

  const daemonCalls: string[] = [];
  const claimAttempts: string[] = [];
  const heldJobLookups: string[] = [];
  const daemon: DaemonQueue = {
    async create(i) { daemonCalls.push(`create:${i.qitemId}:${i.destination}`); },
    async claim(qitem, destination) { daemonCalls.push(`claim:${qitem}:${destination}`); },
    async inspect() { throw new Error("not used by this test"); },
  };
  const db = join(dir, "broker.sqlite");
  let store = openStore(db);
  store.insert({ jobId: first, team: "t", task: { prompt: "first" } }, "small", "queued");
  assert.ok(store.reserve("t", "small", seat, "qitem-first"));
  store.confirmClaim(first, seat, "qitem-first");
  store.transition(first, "running");
  store.insert({ jobId: second, team: "t", task: { prompt: "second" } }, "small", "queued");

  const caps = parseSlotCaps(undefined);
  const observeClaims: BrokerRoutes = (app) => app.use(`${API}/claim-next`, async (_c, next) => {
    claimAttempts.push(store.get(first)?.state ?? "missing");
    await next();
  });
  const routes = [observeClaims, claimNextRoutes({ daemon, brokerSession: "plantworks-broker", slotCaps: caps, newQitemId: () => "qitem-second", log: () => {} }), runtimeRoutes({ slotCaps: caps })];
  const options = { store, teams: loadTeams(teams, { ...PHASE_0_1, slotCaps: { t: 1 } }), routes, host: "127.0.0.1", port: 0, send: () => {}, env: {} };
  let broker = await startBroker(options);
  t.after(async () => { await broker.close(); store.close(); });
  const proxy = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method === "GET" && path === `${API}/jobs/${encodeURIComponent(first)}`) heldJobLookups.push(path);
    try {
      const response = await fetch(`${broker.url}${path}`, {
        method: req.method,
        headers: {
          ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        ...(chunks.length ? { body: Buffer.concat(chunks), duplex: "half" } : {}),
      });
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(502).end(String(error));
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const port = () => new URL(broker.url).port;
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const workerEnv = { ...process.env, OPENRIG_HOME: home, PLANTWORKS_TEAMS_DIR: teamsDir, PLANTWORKS_PLATFORM_FILE: platform, PLANTWORKS_LLM_URL: "http://127.0.0.1:9/v1", PLANTWORKS_GOVERNOR_PORT: "0", PLANTWORKS_BROKER_URL: broker.url };
  const drain = spawn(process.execPath, [bin, "pw", "worker", "drain", "--seat", seat, "--timeout-s", "0", "--poll-ms", "50"], { env: workerEnv, stdio: ["ignore", "pipe", "pipe"] });
  let drainErr = "";
  drain.stderr.setEncoding("utf8").on("data", (s) => drainErr += s);
  const [drainCode] = await once(drain, "exit") as [number | null];
  assert.equal(drainCode, 3, drainErr);
  assert.match(drainErr, /timeout does not prove execution stopped/);
  assert.deepEqual(store.seatInFlight(seat).map((j) => j.job_id), [first]);
  assert.equal(store.get(first)!.state, "running");
  assert.equal(store.get(first)!.qitem_id, "qitem-first");

  await broker.close();
  store.close();
  store = openStore(db);
  assert.equal(store.isDraining(seat), true, "the drain flag survives broker restart");
  assert.deepEqual(store.seatInFlight(seat).map((j) => j.job_id), [first]);
  assert.equal(store.get(first)!.qitem_id, "qitem-first", "the original qitem id survives broker restart");
  broker = await startBroker({ ...options, store });

  const worker = spawn(process.execPath, [bin, "pw", "worker", "run", "--team", "t", "--seat", seat, "--poll-ms", "250", "--governor-port", "0"], { env: { ...workerEnv, PLANTWORKS_BROKER_URL: proxyUrl }, stdio: ["ignore", "ignore", "pipe"] });
  let workerErr = "";
  worker.stderr.setEncoding("utf8").on("data", (s) => workerErr += s);
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  await until(() => { if (worker.exitCode !== null) throw new Error(`worker exited ${worker.exitCode}: ${workerErr}`); return !store.isDraining(seat); });
  await until(() => heldJobLookups.length >= 1);
  assert.equal(store.get(second)!.state, "queued", "restart resumes the seat but waits for its existing work");
  assert.deepEqual(claimAttempts, [], "the worker must wait before even requesting another claim");
  assert.deepEqual(daemonCalls, []);

  worker.kill("SIGKILL");
  await once(worker, "exit");
  await broker.close();
  store.close();
  store = openStore(db);
  broker = await startBroker({ ...options, store });
  const lookupsBeforeRestart = heldJobLookups.length;
  const restarted = spawn(process.execPath, [bin, "pw", "worker", "run", "--team", "t", "--seat", seat, "--poll-ms", "250", "--governor-port", "0"], { env: { ...workerEnv, PLANTWORKS_BROKER_URL: proxyUrl }, stdio: "ignore" });
  t.after(() => { if (restarted.exitCode === null) restarted.kill("SIGKILL"); });
  await until(() => heldJobLookups.length > lookupsBeforeRestart);
  assert.equal(store.get(second)!.state, "queued", "worker death and broker restart do not skip unresolved work");
  assert.deepEqual(claimAttempts, [], "the restarted worker still waits before requesting another claim");
  assert.deepEqual(daemonCalls, []);

  store.transition(first, "done", { outcome: "succeeded" }, { result: JSON.stringify({ text: null, artifacts: [] }) });
  await until(() => daemonCalls.length === 2);
  assert.deepEqual(claimAttempts, ["done"], "only one next claim is made, after the original job completes");
  assert.deepEqual(daemonCalls, ["create:qitem-second:worker-0@t", "claim:qitem-second:worker-0@t"]);
  assert.equal(store.get(first)!.state, "done");
  assert.deepEqual([store.get(second)!.state, store.get(second)!.claimed_by], ["claimed", seat]);
  restarted.kill("SIGTERM");
  await once(restarted, "exit");
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for worker/broker state");
    await pause(20);
  }
}
