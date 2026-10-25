// SPDX-License-Identifier: Apache-2.0
// W4-A slice 2: the broker waits, bounded, for the worker's report after the seat closes a job
// (fork/docs/design/broker-report.md). A fake daemon queue and a file-backed store in a temp
// directory; no real daemon, no worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { claimNextRoutes, type DaemonQueue, type QueueObservation } from "./claim.ts";
import { reportWaitFromEnv } from "./command.ts";
import { createReconciler } from "./reconcile.ts";
import { API, createBroker, loadTeams, type Send } from "./server.ts";
import { openStore } from "./store.ts";
import { eventForTransition, transitionColumns } from "../events/outbox.ts";

const SEAT = "dev-a@team";
const JOB = "kb-social-media-t_1-a1";
const QITEM = "qitem-test-1";
const WAIT_MS = 30_000;
const definition = {
  team: "social-media", trains: 1, perTrain: { orchestrators: 1, workers: { quick: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" }, defaultClass: "quick",
  classes: { quick: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
};
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 1 } };

type Step = { transitionId: number; state: string; actorSession?: string };
/** The seat's qitem after `steps`: the latest done step by the seat, with transport identity, is its closure. */
function qitem(steps: Step[]): QueueObservation {
  const transitions = steps.map((s) => ({ transitionId: s.transitionId, state: s.state, closureReason: s.state === "done" ? "no-follow-on" : null, closureTarget: null, actorSession: s.actorSession ?? SEAT, identityProvenance: "transport:v1" }));
  const last = transitions.at(-1)!;
  return {
    qitemId: QITEM, state: last.state, destinationSession: SEAT, transitions,
    ...(last.state === "done" ? { closureReason: "no-follow-on", closureTarget: null, closingTransition: { ...last } } : {}),
  };
}

/** A broker with one claimed job, a controllable clock, and a store file that survives `restart()`. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pw-report-"));
  assert.ok("files" in emitTeam(definition, join(dir, "teams"), platform));
  const teams = loadTeams(join(dir, "teams"), platform);
  let clock = Date.parse("2026-10-25T03:00:00Z");
  let observation: QueueObservation = qitem([{ transitionId: 1, state: "in-progress" }]);
  let readable = true;
  const daemon: DaemonQueue = {
    async create() {}, async claim() {},
    async inspect() { if (!readable) throw new Error("daemon unavailable"); return observation; },
  };
  const events: { state: string; usage?: unknown; artifacts?: unknown }[] = [];
  const send: Send = () => {};
  const open = () => {
    const store = openStore(join(dir, "broker.sqlite"), () => new Date(clock));
    const routes = [claimNextRoutes({ daemon, brokerSession: "plantworks-broker", slotCaps: { fallback: 1, byKey: {} }, newQitemId: () => QITEM, log: () => {} })];
    const app = createBroker({ store, teams, send, routes, publicUrl: "http://broker.test" });
    // The event the outbox would send for the persisted transition.
    const emit = (row: { job_id: string }) => {
      const transition = store.transitions({ jobId: row.job_id }).at(-1)!;
      const { data } = eventForTransition(store.get(row.job_id)!, transition, transitionColumns(store, transition));
      events.push({ state: data.state, usage: data.usage, artifacts: data.artifacts });
    };
    return { store, app, reconcile: createReconciler(store, daemon, emit, () => {}, 16, undefined, WAIT_MS) };
  };
  let b = open();
  const req = (method: string, path: string, body?: unknown) =>
    b.app.request(`${API}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await req("POST", "/jobs", { jobId: JOB, team: "social-media", task: { prompt: "p" } })).status, 201);
  assert.equal((await req("POST", "/claim-next", { team: "social-media", seat: SEAT })).status, 200);
  await b.reconcile();
  assert.equal(b.store.get(JOB)!.state, "running");
  events.length = 0;
  return {
    get store() { return b.store; },
    reconcile: () => b.reconcile(),
    req,
    record: async () => (await req("GET", `/jobs/${JOB}`)).json(),
    report: (over: Record<string, unknown> = {}) => req("POST", `/jobs/${JOB}/report`, { ...REPORT, ...over }),
    events,
    advance: (ms: number) => { clock += ms; },
    see: (steps: Step[]) => { observation = qitem(steps); },
    readable: (v: boolean) => { readable = v; },
    restart: () => { b.store.close(); b = open(); },
    close: () => b.store.close(),
  };
}

const COMMIT = "a".repeat(40);
const REPORT = {
  seat: SEAT, qitemId: QITEM, closingTransitionId: 2, usage: { promptTokens: 1200, completionTokens: 340 },
  artifacts: { branch: `pw/${JOB}`, commit: COMMIT, files: [{ path: "src/a.ts", sha256: "b".repeat(64) }], observedBy: "worker" },
};
const CLOSED = [{ transitionId: 1, state: "in-progress" }, { transitionId: 2, state: "done" }];

test("the seat's closure opens the wait; the worker's report is stored once and rides the one done transition", async () => {
  const t = await setup();
  try {
    assert.equal((await t.report()).status, 409, "no report is wanted before the seat closes");
    t.see(CLOSED);
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running", "the closure alone doesn't finish the job while a report is wanted");
    assert.deepEqual(t.events, []);
    assert.deepEqual((await t.record()).reportWanted, { closingTransitionId: 2, qitemId: QITEM });

    const stored = await t.report();
    assert.equal(stored.status, 200);
    assert.equal((await stored.json()).reportWanted, undefined, "once stored, no longer wanted");
    const again = await t.report({ usage: { promptTokens: 1, completionTokens: 1 } });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, "report_exists", "first write wins, even for a different report");

    await t.reconcile();
    const done = await t.record();
    assert.deepEqual([done.state, done.detail], ["done", { outcome: "succeeded" }]);
    assert.deepEqual(done.result, {
      text: null, usage: { promptTokens: 1200, completionTokens: 340 },
      artifacts: [{ name: "src/a.ts", uri: `git:${COMMIT}:src/a.ts` }],
      snapshot: REPORT.artifacts, reportProvenance: "worker-asserted", report: "ok",
    });
    assert.deepEqual(t.events, [{ state: "done", usage: { promptTokens: 1200, completionTokens: 340 }, artifacts: [{ name: "src/a.ts", uri: `git:${COMMIT}:src/a.ts` }] }]);
    assert.deepEqual(t.store.transitions({ jobId: JOB }).map((r) => r.to_state), ["queued", "claimed", "running", "done"], "one done transition");

    const late = await t.report();
    assert.deepEqual([late.status, (await late.json()).error], [409, "job_settled"]);
    await t.reconcile();
    assert.equal(t.events.length, 1, "nothing more is emitted");
  } finally { t.close(); }
});

test("a worker that never reports doesn't block done: the bound finishes the job with unavailable(timeout)", async () => {
  const t = await setup();
  try {
    t.see(CLOSED);
    await t.reconcile();
    t.advance(WAIT_MS - 1);
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running");
    t.advance(1);
    await t.reconcile();
    const done = await t.record();
    assert.equal(done.state, "done");
    assert.deepEqual(done.result, { text: null, usage: null, artifacts: [], report: "unavailable(timeout)" });
    assert.deepEqual(t.events, [{ state: "done", usage: undefined, artifacts: undefined }], "the event carries neither field");
  } finally { t.close(); }
});

test("a broker restart resumes the wait from the stored start, and keeps a stored report", async () => {
  const t = await setup();
  try {
    t.see(CLOSED);
    await t.reconcile();
    t.advance(25_000);
    t.restart();
    t.advance(5_000); // 30 s after the closure, 5 s after the restart
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "done", "the bound counts from the persisted report_wait_since, not from the restart");

    const u = await setup();
    try {
      u.see(CLOSED);
      await u.reconcile();
      assert.equal((await u.report()).status, 200);
      u.restart();
      assert.equal((await u.report()).status, 409, "a worker that reports again after either restart gets report_exists");
      await u.reconcile();
      assert.equal((await u.record()).result.report, "ok");
    } finally { u.close(); }
  } finally { t.close(); }
});

test("a reopen and re-close between two polls restarts the wait under the new closure and drops the old report", async () => {
  const t = await setup();
  try {
    t.see(CLOSED);
    await t.reconcile();
    assert.equal((await t.report()).status, 200, "a report for closure 2");
    // The qitem was reopened (3) and closed again (4) by the seat; the reconciler never saw it open.
    t.see([...CLOSED, { transitionId: 3, state: "in-progress" }, { transitionId: 4, state: "done" }]);
    t.advance(20_000);
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running", "the report for closure 2 is not used for closure 4");
    assert.deepEqual((await t.record()).reportWanted, { closingTransitionId: 4, qitemId: QITEM });
    const stale = await t.report();
    assert.deepEqual([stale.status, (await stale.json()).error], [409, "report_stale"]);
    t.advance(WAIT_MS - 1); // past the first wait's bound, short of the second's
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running", "the wait restarted at the re-close");
    assert.equal((await t.report({ closingTransitionId: 4, usage: null, usageStatus: "unavailable(worker restarted)" })).status, 200);
    await t.reconcile();
    const done = await t.record();
    assert.deepEqual([done.state, done.result.usage, done.result.usageStatus], ["done", null, "unavailable(worker restarted)"]);
  } finally { t.close(); }
});

test("a reopen the reconciler sees clears the wait and any report; the job just stays running", async () => {
  const t = await setup();
  try {
    t.see(CLOSED);
    await t.reconcile();
    assert.equal((await t.report()).status, 200);
    t.see([...CLOSED, { transitionId: 3, state: "in-progress" }]);
    await t.reconcile();
    const row = t.store.get(JOB)!;
    assert.deepEqual([row.state, row.report, row.report_wait_since, row.report_closing_id], ["running", null, null, null]);
    assert.equal((await t.record()).reportWanted, undefined);
    const r = await t.report();
    assert.deepEqual([r.status, (await r.json()).error], [409, "report_not_wanted"]);
    t.advance(10 * WAIT_MS);
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running", "no closure, no done, however long");
  } finally { t.close(); }
});

test("done authority stays with the seat: a report can't finish a job, and unreadable evidence keeps it running past the bound", async () => {
  const t = await setup();
  try {
    t.see(CLOSED);
    await t.reconcile();
    assert.equal((await t.report()).status, 200);
    t.readable(false);
    t.advance(10 * WAIT_MS);
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running", "with the daemon unreadable nothing changes, report or not");
    // The closure turns out to be someone else's (an administrative close): proves nothing.
    t.readable(true);
    t.see([{ transitionId: 1, state: "in-progress" }, { transitionId: 2, state: "done", actorSession: "admin@team" }]);
    await t.reconcile();
    assert.equal(t.store.get(JOB)!.state, "running");
    assert.equal(t.store.get(JOB)!.report, null, "that report belonged to a closure that no longer proves anything");
  } finally { t.close(); }
});

test("the report route checks the fence and the shape", async () => {
  const t = await setup();
  try {
    t.see(CLOSED);
    await t.reconcile();
    const error = async (res: Response) => [res.status, (await res.json()).error];
    assert.deepEqual(await error(await t.report({ seat: "dev-b@team" })), [409, "report_fence"]);
    assert.deepEqual(await error(await t.report({ qitemId: "qitem-other" })), [409, "report_fence"]);
    assert.deepEqual(await error(await t.req("POST", "/jobs/kb-social-media-t_9-a1/report", REPORT)), [404, "not_found"]);
    const bad = (artifacts: unknown, over: Record<string, unknown> = {}) => t.report({ artifacts, ...over });
    for (const [why, res] of [
      ["another job's branch", await bad({ ...REPORT.artifacts, branch: "pw/other" })],
      ["a short commit id", await bad({ ...REPORT.artifacts, commit: "abc" })],
      ["no observedBy", await bad({ branch: null, skipped: "no workspace" })],
      ["too many files", await bad({ ...REPORT.artifacts, files: Array.from({ length: 257 }, (_, i) => ({ path: `f${i}`, sha256: "b".repeat(64) })) })],
      ["a path over 2 KB", await bad({ ...REPORT.artifacts, files: [{ path: "p".repeat(2049), sha256: "b".repeat(64) }] })],
      ["usageStatus with usage", await t.report({ usageStatus: "unavailable(worker restarted)" })],
      ["an unknown field", await t.report({ extra: 1 })],
      ["a negative count", await t.report({ usage: { promptTokens: -1, completionTokens: 0 } })],
    ] as const) assert.deepEqual(await error(res), [400, "invalid_report"], why);
    assert.equal((await t.report({ artifacts: { branch: null, skipped: "no workspace", observedBy: "worker" } })).status, 200, "a skipped snapshot is a valid report");
    await t.reconcile();
    const done = await t.record();
    assert.deepEqual([done.result.artifacts, done.result.snapshot.skipped], [[], "no workspace"]);
  } finally { t.close(); }
});

test("PLANTWORKS_REPORT_WAIT_S: 30 s by default, 0 for no report, under 10 s refused", () => {
  assert.equal(reportWaitFromEnv(undefined), 30_000);
  assert.equal(reportWaitFromEnv(" "), 30_000);
  assert.equal(reportWaitFromEnv("0"), 0);
  assert.equal(reportWaitFromEnv("10"), 10_000);
  for (const v of ["5", "9.9", "-1", "soon"]) assert.throws(() => reportWaitFromEnv(v), /0 \(no report\) or at least 10 seconds/, v);
});
