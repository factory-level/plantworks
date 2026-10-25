// SPDX-License-Identifier: Apache-2.0
// PW-34 contract tests, the handoff out (fork/docs/design/sre-handoff.md §3, items 1–5 and 7). In process,
// temp dirs and :memory: stores only; nothing reaches a daemon, Slack or an SRE agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { frontDoor } from "../events/fixtures/front-door.ts";
import { DeliveryError, type CloudEvent } from "../events/job-state.ts";
import { createJobStateOutbox, eventsForTransition, transitionColumns } from "../events/outbox.ts";
import { buildSpec, validateSpec, PHASE_0_1, type TeamSpec } from "../team/spec.ts";
import type { QueueObservation } from "./claim.ts";
import { HANDOFF_FILE, readHandoffFile, resolveHandoff } from "./handoff.ts";
import { createReconciler, seatOutcome } from "./reconcile.ts";
import { validateReport } from "./server.ts";
import { openStore, type Store, type TransitionRow } from "./store.ts";

const SEAT = "long-01@t";
const JOB = "kb-t-card1-a1";
const sre = { agents: { "platform-sre": { slackApp: "${PLANTWORKS_SRE_SLACK_PLATFORM}" } } };
const valid = { targetAgent: "platform-sre", summary: "disk pressure on the build host", suggestedAction: "expand the volume", evidence: [{ kind: "log", uri: "https://logs.invalid/1" }] };

/** A qitem closed done by `actor`, its closing transition being the latest. */
function closed(reason: string, target: string | null, over: { actor?: string; identity?: string; reopened?: boolean } = {}): QueueObservation {
  const closing = { transitionId: 7, state: "done", closureReason: reason, closureTarget: target, actorSession: over.actor ?? SEAT };
  const transitions = [{ transitionId: 6, state: "in-progress", closureReason: null, closureTarget: null, actorSession: SEAT, identityProvenance: "transport:v1" }, { ...closing, identityProvenance: over.identity ?? "transport:v1" }];
  if (over.reopened) transitions.push({ transitionId: 8, state: "in-progress", closureReason: null, closureTarget: null, actorSession: SEAT, identityProvenance: "transport:v1" });
  return { qitemId: "qitem-1", state: over.reopened ? "in-progress" : "done", destinationSession: SEAT, closureReason: reason, closureTarget: target, closingTransition: closing, transitions } as QueueObservation;
}

function runningJob(store: Store, jobId = JOB) {
  store.insert({ jobId, team: "t", task: { prompt: "p" } } as never, "long", "queued");
  store.reserve("t", "long", SEAT, `q-${jobId}`);
  store.confirmClaim(jobId, SEAT, `q-${jobId}`);
  store.transition(jobId, "running");
}
const lastTransition = (store: Store, jobId = JOB) => store.db.prepare("SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId) as TransitionRow;
const eventsOf = (store: Store, jobId = JOB) => { const t = lastTransition(store, jobId); return eventsForTransition(store.get(jobId)!, t, transitionColumns(store, t)); };

test("1. reconcile: only the seat's own escalation/handoff-sre closure ends the job, done with closure handoff-sre", async () => {
  assert.equal(seatOutcome(closed("escalation", "handoff-sre")), "handoff-sre");
  for (const [why, item] of [
    ["another target", closed("escalation", "pager")],
    ["a non-destination closer", closed("escalation", "handoff-sre", { actor: "someone-else@t" })],
    ["an administrative closure", closed("escalation", "handoff-sre", { identity: "admin" })],
    ["a reopen since", closed("escalation", "handoff-sre", { reopened: true })],
  ] as const) assert.equal(seatOutcome(item), null, why);

  const store = openStore(":memory:");
  try {
    runningJob(store);
    let item = closed("escalation", "handoff-sre", { actor: "someone-else@t" });
    const daemon = { create: async () => {}, claim: async () => {}, inspect: async () => item };
    const emitted: string[] = [];
    const reconcile = createReconciler(store, daemon as never, (r, s) => emitted.push(s), () => {}, 16, undefined, 0, new Map([["t", { sre } as TeamSpec]]));
    await reconcile();
    assert.equal(store.get(JOB)!.state, "running", "a foreign closure proves nothing");
    item = { ...closed("escalation", "handoff-sre"), qitemId: `q-${JOB}` };
    await reconcile();
    assert.equal(store.get(JOB)!.state, "done");
    assert.deepEqual(JSON.parse(lastTransition(store).detail), { outcome: "rejected-by-checks", closure: "handoff-sre" }, "no report yet (W4-A): never success by default");
    assert.deepEqual(JSON.parse(store.get(JOB)!.result!).handoff, { unavailable: "missing" });
    assert.deepEqual(emitted, ["done"]);
  } finally { store.close(); }
});

test("2. artifact: a valid one naming a mapped agent is carried; every failure is unavailable, rejected-by-checks, with no targetAgent", () => {
  const ok = resolveHandoff({ artifact: { ...valid, outcome: "succeeded" } }, { sre });
  assert.deepEqual(ok, { outcome: "succeeded", data: { ...valid, outcome: "succeeded", slackApp: "PLANTWORKS_SRE_SLACK_PLATFORM" } }, "the reference's name, never a value");
  assert.equal(resolveHandoff({ artifact: valid }, { sre }).outcome, "rejected-by-checks", "a missing outcome never claims success");
  const cases: [string, Parameters<typeof resolveHandoff>[0], Parameters<typeof resolveHandoff>[1], string][] = [
    ["no report", undefined, { sre }, "missing"],
    ["report timed out", { unavailable: "timeout" }, { sre }, "timeout"],
    ["unknown field", { artifact: { ...valid, routeTo: "x" } }, { sre }, "invalid: unknown field routeTo"],
    ["empty summary", { artifact: { ...valid, summary: "" } }, { sre }, "invalid: summary must be 1..2000 characters"],
    ["long action", { artifact: { ...valid, suggestedAction: "x".repeat(1001) } }, { sre }, "invalid: suggestedAction must be 1..1000 characters"],
    ["21 evidence items", { artifact: { ...valid, evidence: Array(21).fill(valid.evidence[0]) } }, { sre }, "invalid: evidence must be a list of at most 20"],
    ["bad outcome", { artifact: { ...valid, outcome: "partial" } }, { sre }, "invalid: outcome must be succeeded or rejected-by-checks"],
    ["unmapped agent", { artifact: { ...valid, targetAgent: "db-sre" } }, { sre }, "unknown-target: db-sre"],
    ["a spec without sre", { artifact: valid }, {}, "unknown-target: platform-sre"],
  ];
  for (const [why, report, spec, unavailable] of cases) {
    const r = resolveHandoff(report, spec);
    assert.deepEqual(r, { outcome: "rejected-by-checks", data: { unavailable } }, why);
    assert.equal("targetAgent" in r.data, false, `${why}: never a guessed or default agent`);
  }
});

test("3. team spec: sre.agents validates; a literal, a second reference or a bad name is rejected", () => {
  const base = { team: "t", trains: 1, perTrain: { orchestrators: 1, workers: { long: 1 } }, endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "t" }, defaultClass: "long",
    classes: { long: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 8192, thinkingTokens: 0 }, perCall: { maxOutputTokens: 700, deadlineSeconds: 5 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
    events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" } };
  const platform = { ...PHASE_0_1, slotCaps: { t: 1 } };
  const errors = (s: unknown) => validateSpec(buildSpec({ ...base, sre: s }), platform);
  assert.deepEqual(validateSpec(buildSpec(base), platform), [], "sre is optional");
  assert.deepEqual(errors(sre), []);
  for (const [why, s, msg] of [
    ["a literal app", { agents: { "platform-sre": { slackApp: "A0123SLACKAPP" } } }, /slackApp must be exactly one operator reference/],
    ["two references", { agents: { "platform-sre": { slackApp: "${PLANTWORKS_SRE_SLACK_A}${PLANTWORKS_SRE_SLACK_B}" } } }, /slackApp must be exactly one/],
    ["another variable family", { agents: { "platform-sre": { slackApp: "${PLANTWORKS_LLM_API_KEY}" } } }, /slackApp must be exactly one/],
    ["a bad agent name", { agents: { Platform_SRE: { slackApp: "${PLANTWORKS_SRE_SLACK_PLATFORM}" } } }, /must be a DNS-safe name/],
    ["an unknown field", { agents: {}, pager: true }, /unknown field sre\.pager/],
  ] as const) assert.match(errors(s).join("\n"), msg, why);
});

test("4. event: id <jobId>:<transitionId>:handoff.requested, after its job.state, byte-identical on redelivery", async () => {
  const store = openStore(":memory:");
  try {
    runningJob(store);
    const resolved = resolveHandoff({ artifact: valid }, { sre });
    store.transition(JOB, "done", { outcome: resolved.outcome, closure: "handoff-sre" }, { result: JSON.stringify({ text: null, artifacts: [], handoff: resolved.data }) });
    const t = lastTransition(store);
    const [state, handoff] = eventsOf(store);
    assert.equal(state!.type, "plantworks.job.state");
    assert.equal(state!.data.state, "done");
    assert.equal("handoff" in state!.data, false, "the job.state carries no handoff content");
    assert.equal(handoff!.type, "plantworks.handoff.requested");
    assert.equal(handoff!.id, `${JOB}:${t.id}:handoff.requested`);
    assert.equal(handoff!.subject, JOB);
    assert.equal(handoff!.source, "/plantworks/teams/t");
    assert.deepEqual(handoff!.data, { jobId: JOB, team: "t", attempt: 1, qitemId: `q-${JOB}`, seat: SEAT, ...valid, outcome: "rejected-by-checks", slackApp: "PLANTWORKS_SRE_SLACK_PLATFORM" });
    assert.equal(JSON.stringify(eventsOf(store)), JSON.stringify([state, handoff]), "derived from the persisted row: identical on redelivery");
    // A done without the closure carries one event, as before.
    runningJob(store, "kb-t-card2-a1");
    store.transition("kb-t-card2-a1", "done", { outcome: "succeeded" });
    assert.deepEqual(eventsOf(store, "kb-t-card2-a1").map((e) => e.type), ["plantworks.job.state"]);
  } finally { store.close(); }
});

test("4. outbox pair: a transient failure of the handoff keeps the cursor, backs off once, survives a restart and redelivers both unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pw34-outbox-"));
  const path = join(dir, "broker.sqlite");
  let store = openStore(path);
  try {
    runningJob(store);
    store.transition(JOB, "done", { outcome: "rejected-by-checks", closure: "handoff-sre" }, { result: JSON.stringify({ text: null, artifacts: [], handoff: { unavailable: "missing" } }) });
    const doneId = lastTransition(store).id;
    const seen: CloudEvent[] = [];
    const first = createJobStateOutbox(store, async (_t, e) => { seen.push(e); if (e.type === "plantworks.handoff.requested") throw new Error("connection reset"); }, () => {});
    await first.pump();
    const ids = seen.map((e) => e.id);
    assert.deepEqual(ids.slice(-2), [`${JOB}:${doneId}`, `${JOB}:${doneId}:handoff.requested`], "job.state first, then the handoff");
    const cursor = () => (store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = 't'").get() as { delivered_through: number }).delivered_through;
    assert.equal(cursor(), doneId - 1, "the cursor stays before the pair");
    assert.deepEqual(store.db.prepare("SELECT transition_id, attempts, parked FROM event_outbox_failures").all().map((r) => ({ ...r })), [{ transition_id: doneId, attempts: 1, parked: 0 }], "one failure row, for the transition");
    const before = seen.length;
    await first.pump();
    assert.equal(seen.length, before, "backing off: no redelivery yet");
    await first.stop();
    store.close();

    store = openStore(path); // the broker restarts mid-retry
    await new Promise((r) => setTimeout(r, 1100));
    const again: CloudEvent[] = [];
    const second = createJobStateOutbox(store, async (_t, e) => { again.push(e); }, () => {});
    await second.pump();
    assert.deepEqual(again.map((e) => e.id), [`${JOB}:${doneId}`, `${JOB}:${doneId}:handoff.requested`], "both again, from job.state");
    assert.equal(JSON.stringify(again), JSON.stringify(seen.slice(-2)), "unchanged ids and bodies");
    assert.equal(cursor(), doneId);
    await second.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("4. outbox pair: a permanent failure of either parks the transition with the cursor in one step, and the next transition delivers", async () => {
  for (const failing of ["plantworks.job.state", "plantworks.handoff.requested"]) {
    const store = openStore(":memory:");
    try {
      runningJob(store);
      store.transition(JOB, "done", { outcome: "rejected-by-checks", closure: "handoff-sre" }, { result: JSON.stringify({ text: null, artifacts: [], handoff: { unavailable: "missing" } }) });
      const doneId = lastTransition(store).id;
      store.insert({ jobId: "kb-t-card2-a1", team: "t", task: { prompt: "next" } } as never, "long", "queued");
      const delivered: string[] = [];
      const logs: string[] = [];
      const outbox = createJobStateOutbox(store, async (_t, e) => {
        if (e.type === failing && e.subject === JOB && e.id.startsWith(`${JOB}:${doneId}`)) throw new DeliveryError("HTTP 400, not retried", e, 1, true);
        delivered.push(e.id);
      }, (l) => logs.push(l));
      await outbox.pump();
      await outbox.pump();
      const failedId = failing === "plantworks.job.state" ? `${JOB}:${doneId}` : `${JOB}:${doneId}:handoff.requested`;
      assert.ok(logs.some((l) => l.includes(`parked after permanent delivery failure: ${failedId}`)), `${failing}: the log names the failing event: ${logs}`);
      assert.deepEqual({ ...store.db.prepare("SELECT parked FROM event_outbox_failures WHERE transition_id = ?").get(doneId) as object }, { parked: 1 });
      assert.ok(delivered.includes("kb-t-card2-a1:" + (doneId + 1)), `${failing}: the next transition delivers`);
      if (failing === "plantworks.handoff.requested") assert.ok(delivered.includes(`${JOB}:${doneId}`), "a job.state already delivered stays delivered");
      await outbox.stop();
    } finally { store.close(); }
  }
});

test("4. artifact read (worker side): each fail-closed case, and a valid file with its hash", () => {
  const root = mkdtempSync(join(tmpdir(), "pw34-ws-"));
  try {
    const ws = join(root, "ws");
    const file = join(ws, HANDOFF_FILE);
    mkdirSync(join(ws, ".plantworks"), { recursive: true });
    assert.deepEqual(readHandoffFile(undefined), { unavailable: "missing" }, "no workspace");
    assert.deepEqual(readHandoffFile(ws), { unavailable: "missing" }, "file absent");
    writeFileSync(file, JSON.stringify(valid));
    const ok = readHandoffFile(ws);
    assert.ok("artifact" in ok && ok.hash.length === 64);
    assert.deepEqual((ok as { artifact: unknown }).artifact, valid);
    assert.deepEqual(readHandoffFile(ws, (ok as { hash: string }).hash), { unavailable: "missing" }, "a file unchanged since take-up is stale");
    writeFileSync(file, "x".repeat(16 * 1024 + 1));
    assert.deepEqual(readHandoffFile(ws), { unavailable: "invalid: over 16 KiB" });
    writeFileSync(file, "{not json");
    assert.deepEqual(readHandoffFile(ws), { unavailable: "invalid: not UTF-8 JSON" });
    writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
    assert.deepEqual(readHandoffFile(ws), { unavailable: "invalid: not UTF-8 JSON" });
    rmSync(file);
    writeFileSync(join(root, "outside.json"), JSON.stringify(valid));
    symlinkSync(join(root, "outside.json"), file);
    assert.deepEqual(readHandoffFile(ws), { unavailable: "invalid: symlink" });
    rmSync(file);
    mkdirSync(file);
    assert.deepEqual(readHandoffFile(ws), { unavailable: "invalid: not a regular file" });
    // `.plantworks` itself linked out of the workspace.
    const ws2 = join(root, "ws2");
    mkdirSync(ws2);
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "handoff.json"), JSON.stringify(valid));
    symlinkSync(join(root, "elsewhere"), join(ws2, ".plantworks"));
    assert.deepEqual(readHandoffFile(ws2), { unavailable: "invalid: outside the workspace" });
    assert.ok(statSync(join(root, "outside.json")).isFile(), "nothing outside was touched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("5. front door: handoff-sre done blocks the card; handoff.requested is recorded once per id", async () => {
  const fd = await frontDoor();
  try {
    const store = openStore(":memory:");
    runningJob(store);
    const resolved = resolveHandoff({ artifact: valid }, { sre });
    store.transition(JOB, "done", { outcome: resolved.outcome, closure: "handoff-sre" }, { result: JSON.stringify({ text: null, artifacts: [], handoff: resolved.data }) });
    const post = async (_t: string, e: CloudEvent) => {
      const res = await fetch(fd.url, { method: "POST", headers: { "content-type": "application/cloudevents+json" }, body: JSON.stringify(e) });
      if (!res.ok) throw new DeliveryError(`HTTP ${res.status}`, e, 1, res.status < 500);
    };
    const outbox = createJobStateOutbox(store, post, () => {});
    await outbox.pump();
    for (const e of eventsOf(store)) await post("t", e); // a redelivery of the pair
    assert.deepEqual(fd.rejected, []);
    assert.equal(fd.cards(JOB).at(-1), "blocked");
    assert.equal(fd.handoffs.length, 1, "deduped on id");
    assert.equal(fd.handoffs[0].data.targetAgent, "platform-sre");
    await outbox.stop();
    store.close();
  } finally { await fd.close(); }
});

test("7. boundary: fork/src imports no Slack or Eve client, and the handoff code names no team", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } };
  walk(src);
  const offending = files.filter((f) => /\bfrom\s+["'][^"']*(slack|\beve\b)[^"']*["']|import\(\s*["'][^"']*(slack|\beve\b)/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(offending, []);
  for (const f of ["broker/handoff.ts", "broker/wake.ts", "broker/reconcile.ts", "broker/claim.ts", "broker/worker.ts"]) {
    assert.doesNotMatch(readFileSync(join(src, f), "utf8"), /["'](social-media|harness-hg|platform-sre)["']/, `${f} has no team-specific branch`);
  }
});

test("W4-A integration: through the report wait, the report's handoff decides the event; no handoff member is missing, the bound is timeout", async () => {
  const spec = new Map([["t", { sre } as TeamSpec]]);
  const report = (handoff?: unknown) => ({ usage: null, artifacts: { branch: null, skipped: "no workspace", observedBy: "worker" }, ...(handoff ? { handoff } : {}) }) as never;
  // Through the reconciler: the seat's escalation/handoff-sre closure opens the wait; the stored report finishes it.
  const store = openStore(":memory:");
  try {
    runningJob(store);
    const item = { ...closed("escalation", "handoff-sre"), qitemId: `q-${JOB}` };
    const daemon = { create: async () => {}, claim: async () => {}, inspect: async () => item };
    const reconcile = createReconciler(store, daemon as never, () => {}, () => {}, 16, undefined, 30_000, spec);
    await reconcile();
    assert.equal(store.get(JOB)!.state, "running", "the closure opens the report wait");
    assert.equal(store.storeReport(JOB, { seat: SEAT, qitemId: `q-${JOB}`, closingTransitionId: 7 }, report({ artifact: { ...valid, outcome: "succeeded" } })), "stored");
    await reconcile();
    assert.deepEqual(JSON.parse(lastTransition(store).detail), { outcome: "succeeded", closure: "handoff-sre" }, "the artifact's outcome");
    const [, handoff] = eventsOf(store);
    assert.equal(handoff!.data.targetAgent, "platform-sre");
    assert.equal(handoff!.data.slackApp, "PLANTWORKS_SRE_SLACK_PLATFORM");
    assert.equal(JSON.parse(store.get(JOB)!.result!).reportProvenance, "worker-asserted");
  } finally { store.close(); }

  // At the store: a report without a handoff member, an invalid one, and the bound.
  for (const [why, r, expect] of [
    ["no handoff member", report(), "missing"],
    ["the worker says unavailable", report({ unavailable: "invalid: symlink" }), "invalid: symlink"],
    ["an invalid artifact", report({ artifact: { targetAgent: "platform-sre" } }), "invalid: summary must be 1..2000 characters"],
    ["the wait runs out", undefined, "timeout"],
  ] as const) {
    let clock = 0;
    const s = openStore(":memory:", () => new Date(clock));
    try {
      runningJob(s);
      assert.equal(s.settleReport(JOB, "handoff-sre", 7, 30_000, { sre }), null, `${why}: the wait opens`);
      if (r) assert.equal(s.storeReport(JOB, { seat: SEAT, qitemId: `q-${JOB}`, closingTransitionId: 7 }, r), "stored");
      else clock = 30_000;
      const settled = s.settleReport(JOB, "handoff-sre", 7, 30_000, { sre });
      assert.deepEqual(settled?.detail, { outcome: "rejected-by-checks", closure: "handoff-sre" }, why);
      assert.deepEqual(JSON.parse(s.get(JOB)!.result!).handoff, { unavailable: expect }, why);
    } finally { s.close(); }
  }
  // A non-handoff closure is unchanged by the extra argument.
  const plain = openStore(":memory:");
  try {
    runningJob(plain);
    plain.settleReport(JOB, "succeeded", 7, 30_000, undefined);
    plain.storeReport(JOB, { seat: SEAT, qitemId: `q-${JOB}`, closingTransitionId: 7 }, report());
    assert.deepEqual(plain.settleReport(JOB, "succeeded", 7, 30_000, undefined)?.detail, { outcome: "succeeded" });
    assert.equal("handoff" in JSON.parse(plain.get(JOB)!.result!), false);
  } finally { plain.close(); }
});

test("W4-A integration: the report route accepts an optional handoff of {artifact} or {unavailable} only", () => {
  const body = { seat: SEAT, qitemId: "q", closingTransitionId: 7, usage: null, artifacts: { branch: null, skipped: "no workspace", observedBy: "worker" } };
  assert.equal(validateReport(body, JOB).ok, true, "no handoff member");
  const ok = validateReport({ ...body, handoff: { artifact: valid } }, JOB);
  assert.ok(ok.ok && ok.report.handoff && "artifact" in ok.report.handoff, "the artifact is kept as sent, checked when the job finishes");
  assert.equal(validateReport({ ...body, handoff: { unavailable: "missing" } }, JOB).ok, true);
  for (const h of [null, [], "x", {}, { artifact: valid, unavailable: "missing" }, { unavailable: "" }, { unavailable: "x".repeat(513) }, { other: 1 }]) {
    const v = validateReport({ ...body, handoff: h }, JOB);
    assert.ok(!v.ok && v.errors.some((e) => /^handoff must be/.test(e)), JSON.stringify(h));
  }
});
