// SPDX-License-Identifier: Apache-2.0
// PW-33, local simulation: one team scaled from 1 to 3 trains under a fixed slot cap. The broker runs
// in process with a fake daemon queue; each seat is a real `pw worker run` process; a stand-in Pi
// seat makes the job's one model call through that seat's governor to a loopback stub endpoint.
// Every child environment is built from scratch, in temp homes. The GitOps/factory-server run is gated.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emitTeam } from "../team/command.ts";
import { fleetFor } from "../team/render.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { claimNextRoutes, type DaemonQueue } from "./claim.ts";
import { runtimeRoutes } from "./runtime.ts";
import { API, loadTeams, startBroker } from "./server.ts";
import { parseSlotCaps } from "./slots.ts";
import { openStore } from "./store.ts";

const CAP = 2;
const JOBS = 30;
const platform = { ...PHASE_0_1, slotCaps: { t: CAP } };
const definition = (trains: number) => ({
  team: "t", trains, perTrain: { orchestrators: 1, workers: { long: 2 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "t" }, defaultClass: "long",
  classes: { long: { slots: CAP, model: "qwen3.5:9b", context: { maxContextTokens: 8192, thinkingTokens: 0 }, perCall: { maxOutputTokens: 700, deadlineSeconds: 5 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
});

test("trains 1 -> 3 under a fixed slot cap: in-flight stays at the cap, idle seats cost nothing, drain while scaling loses or duplicates nothing", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pw33-trains-"));
  const children: ChildProcess[] = [];
  t.after(() => { for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });

  // Sentinels a leaked environment would reach. Children never see them: their env is built from scratch.
  const sentinelHits: string[] = [];
  const sentinel = createServer((q, r) => { sentinelHits.push(`${q.method} ${q.url}`); r.writeHead(503).end(); });
  await listen(sentinel);
  t.after(() => sentinel.close());
  const sentinelDb = join(root, "sentinel", "openrig.sqlite");
  const saved = { url: process.env.OPENRIG_URL, db: process.env.OPENRIG_DB };
  process.env.OPENRIG_URL = `http://127.0.0.1:${port(sentinel)}`;
  process.env.OPENRIG_DB = sentinelDb;
  t.after(() => { for (const [k, v] of [["OPENRIG_URL", saved.url], ["OPENRIG_DB", saved.db]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  // The stub endpoint: every completion is held briefly and the peak concurrency is recorded.
  let calls = 0, live = 0, peakCalls = 0;
  const model = createServer((req, res) => {
    req.resume().on("end", () => {
      if (req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "qwen3.5:9b" }] }));
      calls++; live++; peakCalls = Math.max(peakCalls, live);
      setTimeout(() => {
        live--;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `c${calls}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
      }, 60);
    });
  });
  await listen(model);
  t.after(() => { model.closeAllConnections(); model.close(); });

  // 1 train: the team definition is the only input. Re-emitting it is the scale-out (GitOps renders the same files).
  const teamsDir = join(root, "teams");
  const emitted = (trains: number) => {
    const r = emitTeam(definition(trains), teamsDir, platform);
    assert.ok("files" in r, JSON.stringify(r));
    return { spec: JSON.parse(readFileSync(join(teamsDir, "t", "team.json"), "utf8")), profile: readFileSync(join(teamsDir, "t", "hermes-profile", "config.yaml"), "utf8") };
  };
  const one = emitted(1);
  const fleet1 = fleetFor(one.spec).classes.long!;
  assert.equal(fleet1.workersMax, 2);
  const platformFile = join(root, "platform.json");
  writeFileSync(platformFile, JSON.stringify(platform));

  // The broker, in process, with a fake daemon queue that records every handoff.
  const handoffs: { qitem: string; seat: string }[] = [];
  const daemon: DaemonQueue = {
    async create() {},
    async claim(qitem, seat) { handoffs.push({ qitem, seat }); },
    async inspect() { throw new Error("not used"); },
  };
  const store = openStore(join(root, "broker.sqlite"));
  const caps = parseSlotCaps(`t=${CAP}`);
  let n = 0;
  const broker = await startBroker({
    store, teams: loadTeams(teamsDir, platform), host: "127.0.0.1", port: 0, send: () => {}, env: {},
    routes: [claimNextRoutes({ daemon, brokerSession: "plantworks-broker", slotCaps: caps, newQitemId: () => `qitem-sim-${++n}`, log: () => {} }), runtimeRoutes({ slotCaps: caps })],
  });
  t.after(async () => { await broker.close(); store.close(); });
  const submit = (from: number, to: number) => { for (let i = from; i <= to; i++) store.insert({ jobId: `kb-t-card${String(i).padStart(2, "0")}-a1`, team: "t", task: { prompt: `job ${i}` } } as never, "long", "queued"); };
  submit(1, 20); // the last 10 arrive after the drain, while the drained worker is still polling

  // Stats, sampled throughout: the scaler's only input.
  const samples: { inFlight: number; cap: number; active: number }[] = [];
  const statsNow = async () => (await (await fetch(`${broker.url}${API}/stats`)).json()) as { active: number; slots: Record<string, { inFlight: number; cap: number }>; drainingSeats: string[] };
  let sampling = true;
  const sampler = (async () => { while (sampling) { const s = await statsNow(); samples.push({ ...s.slots.t!, active: s.active }); await pause(15); } })();

  // A seat: a `pw worker run` process, environment built from scratch.
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const envFor = (seat: string) => {
    const home = join(root, "homes", seat);
    mkdirSync(home, { recursive: true });
    return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, OPENRIG_HOME: home, TMPDIR: tmpdir(), PLANTWORKS_TEAMS_DIR: teamsDir, PLANTWORKS_PLATFORM_FILE: platformFile, PLANTWORKS_LLM_URL: `http://127.0.0.1:${port(model)}/v1`, PLANTWORKS_BROKER_URL: broker.url };
  };
  const governors = new Map<string, string>();
  const workers = new Map<string, ChildProcess>();
  const startWorker = async (seat: string) => {
    const env = envFor(seat);
    assert.deepEqual(Object.keys(env).filter((k) => /^(OPENRIG_(URL|DB|PORT|HOST)|RIGGED_|TMUX)/.test(k)), [], "containment");
    const child = spawn(process.execPath, [bin, "pw", "worker", "run", "--team", "t", "--seat", seat, "--poll-ms", "250", "--governor-port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    workers.set(seat, child);
    let err = "";
    child.stderr!.setEncoding("utf8").on("data", (s) => (err += s));
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout!.setEncoding("utf8").on("data", (s: string) => { const m = / governed at (\S+);/.exec(s); if (m) resolve(m[1]!); });
      child.once("exit", (code) => reject(new Error(`${seat} exited ${code}: ${err}`)));
    });
    governors.set(seat, url);
  };

  // The stand-in Pi seat: for each claimed job, one model call through the claiming seat's governor, then done.
  // A job in `slow` is held running until released, so a drain can land mid-job.
  const slow = new Map<string, () => void>();
  const ran = new Map<string, number>();
  const runs: Promise<void>[] = [];
  const seatErrors: string[] = [];
  let seating = true;
  let drainTarget: string | undefined;
  const seatDriver = (async () => {
    while (seating) {
      for (const row of store.db.prepare("SELECT job_id, claimed_by FROM jobs WHERE state = 'claimed'").all() as { job_id: string; claimed_by: string }[]) {
        if (!governors.has(row.claimed_by)) continue; // the seat's governor URL isn't parsed yet: the job waits, as a Pi seat would
        ran.set(row.job_id, (ran.get(row.job_id) ?? 0) + 1);
        store.transition(row.job_id, "running");
        runs.push((async () => {
          const res = await fetch(`${governors.get(row.claimed_by)}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.5:9b", messages: [{ role: "user", content: row.job_id }] }) });
          assert.equal(res.status, 200, row.job_id);
          await res.arrayBuffer();
          if (slow.size === 0 && drainTarget === undefined && handoffs.length > 4) await new Promise<void>((r) => slow.set(row.job_id, r));
          store.transition(row.job_id, "done", { outcome: "succeeded" }, { result: JSON.stringify({ text: "ok", artifacts: [] }) });
        })().catch((e: Error) => { seatErrors.push(`${row.job_id}: ${e.message}`); }));
      }
      await pause(10);
    }
  })();

  // Train 1: two seats.
  for (const seat of fleet1.seats) await startWorker(seat);
  await until(() => handoffs.length >= 4, "train 1 takes work");

  // Scale out to 3 trains: re-emit; workers.max and the Hermes profile follow; the cap does not.
  const three = emitted(3);
  const fleet3 = fleetFor(three.spec).classes.long!;
  assert.equal(fleet3.workersMax, 6);
  assert.match(one.profile, /max_in_progress_per_profile: 1\b/);
  assert.match(three.profile, /max_in_progress_per_profile: 3\b/);
  assert.equal(loadTeams(teamsDir, platform).get("t")!.classes.long!.slots, CAP, "trains raise seats, not slots");
  for (const seat of fleet3.seats.filter((s) => !workers.has(s))) await startWorker(seat);

  // Drain a seat mid-job while the new seats join: its job finishes, it takes no more, nothing is lost or duplicated.
  await until(() => slow.size === 1, "a job is held mid-run");
  const [heldJob, release] = [...slow][0]!;
  drainTarget = store.get(heldJob)!.claimed_by!;
  const drain = spawn(process.execPath, [bin, "pw", "worker", "drain", "--seat", drainTarget, "--timeout-s", "60", "--poll-ms", "50"], { env: envFor(`${drainTarget}-drain`), stdio: ["ignore", "ignore", "pipe"] });
  children.push(drain);
  await until(async () => (await statsNow()).drainingSeats.includes(drainTarget!), "the seat is draining");
  const handoffsAtDrain = handoffs.length;
  await pause(600);
  assert.equal(drain.exitCode, null, "the drain waits for the held job");
  release();
  const [drainCode] = await once(drain, "exit") as [number | null];
  assert.equal(drainCode, 0);
  assert.equal(store.get(heldJob)!.state, "done");
  // New work arrives while the drained worker is still polling (the window before the platform removes the pod).
  submit(21, JOBS);
  await pause(1500);
  workers.get(drainTarget)!.kill("SIGTERM"); // the pod's preStop finished: the platform removes it
  await once(workers.get(drainTarget)!, "exit");

  await until(() => (store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'done'").get() as { n: number }).n === JOBS, "all jobs done");
  assert.deepEqual(handoffs.slice(handoffsAtDrain).filter((h) => h.seat === drainTarget), [], "a draining seat is handed no new job");

  // Idle: empty queues, the five remaining seats still polling. No model calls, no slots, active 0 for the scaler.
  const callsWhenEmpty = calls;
  await pause(1500);
  const idle = await statsNow();
  sampling = false; seating = false;
  await Promise.all([sampler, seatDriver, ...runs]);
  assert.deepEqual(seatErrors, []);
  assert.equal(calls, callsWhenEmpty, "idle seats make no model calls");
  assert.deepEqual([idle.active, idle.slots.t!.inFlight], [0, 0], "empty queues: the scaler sees 0 active and 0 in flight, so it may scale workers to 0");
  for (const [seat, w] of workers) if (seat !== drainTarget) { w.kill("SIGTERM"); await once(w, "exit"); }
  assert.deepEqual(store.liveCounts(), [], "scaled to 0: nothing queued, reserved, claimed or running");
  assert.deepEqual([...workers.keys()].flatMap((seat) => store.seatInFlight(seat)), [], "no seat holds anything");

  // The cap held throughout, at the broker and at the endpoint.
  assert.ok(samples.length > 50, `stats were sampled (${samples.length})`);
  assert.ok(samples.every((s) => s.inFlight <= CAP && s.cap === CAP), `in flight never above ${CAP}: max ${Math.max(...samples.map((s) => s.inFlight))}`);
  assert.ok(samples.some((s) => s.inFlight === CAP), "the cap was reached, so it was tested");
  assert.ok(peakCalls <= CAP, `endpoint concurrency ${peakCalls} <= ${CAP}`);
  // Exactly once: one handoff, one run and one model call per job.
  assert.equal(handoffs.length, JOBS);
  assert.equal(new Set(handoffs.map((h) => h.qitem)).size, JOBS);
  assert.deepEqual([...ran.values()].filter((v) => v !== 1), [], "no job ran twice");
  assert.equal(ran.size, JOBS);
  assert.equal(calls, JOBS);
  assert.ok(new Set(handoffs.map((h) => h.seat)).size > 2, "seats from the added trains took work");

  t.diagnostic(`samples=${samples.length} maxInFlight=${Math.max(...samples.map((s) => s.inFlight))} cap=${CAP} peakEndpointCalls=${peakCalls} calls=${calls} handoffs=${handoffs.length} seatsUsed=${new Set(handoffs.map((h) => h.seat)).size}/${fleet3.workersMax} drained=${drainTarget} heldJob=${heldJob}`);
  assert.deepEqual(sentinelHits, [], "the sentinel daemon URL was never contacted");
  assert.throws(() => readFileSync(sentinelDb), "the sentinel database was never created");
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = (s: { address(): unknown }) => (s.address() as { port: number }).port;
const listen = (s: ReturnType<typeof createServer>) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await pause(20);
  }
}
