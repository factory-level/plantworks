// SPDX-License-Identifier: Apache-2.0
// claim-next against a fake daemon queue (and, once, a stub daemon over HTTP). No real daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { DaemonRefused, claimNextRoutes, daemonQueue, newQitemId, type DaemonQueue, type QueueObservation } from "./claim.ts";
import { createReconciler } from "./reconcile.ts";
import { API, createBroker, loadTeams, type Emit } from "./server.ts";
import { openStore } from "./store.ts";
import { parseSlotCaps, type SlotCaps } from "./slots.ts";

// Two no-approval classes, so class routing and the default class are both visible.
const definition = {
  team: "social-media",
  trains: 1,
  perTrain: { orchestrators: 1, workers: { quick: 1, deep: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" },
  defaultClass: "quick",
  classes: {
    quick: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 2 },
    deep: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 32768, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1024, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 3600, maxAttempts: 1 },
  },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
};
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 2 } };

type Call = [string, ...unknown[]];
function fakeDaemon(hooks: { create?: () => void | Promise<void>; claim?: () => void | Promise<void>; inspect?: (id: string) => QueueObservation | Promise<QueueObservation> } = {}) {
  const calls: Call[] = [];
  const daemon: DaemonQueue = {
    async create(i) { calls.push(["create", i.qitemId, i.destination, i.source]); await hooks.create?.(); },
    async claim(q, seat) { calls.push(["claim", q, seat]); await hooks.claim?.(); },
    async inspect(q) { if (!hooks.inspect) throw new Error("qitem unavailable"); return hooks.inspect(q); },
  };
  return { daemon, calls };
}

// PW-18 tests aren't about the PW-19 cap, so they get a roomy one; slots.test.ts covers the cap.
function setup(daemon: DaemonQueue, now: () => Date = () => new Date(), token?: string, slotCaps: SlotCaps = { fallback: 100, byKey: {} }) {
  const dir = mkdtempSync(join(tmpdir(), "pw-claim-"));
  assert.ok("files" in emitTeam(definition, dir, platform));
  const store = openStore(":memory:", now);
  const events: [string, string][] = [];
  const emit: Emit = (row, state) => events.push([row.job_id, state]);
  let n = 0;
  const routes = [claimNextRoutes({ daemon, brokerSession: "plantworks-broker", slotCaps, newQitemId: () => `qitem-test-${++n}`, log: () => {} })];
  const app = createBroker({ store, teams: loadTeams(dir, platform), emit, routes, token });
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const submit = (card: string, extra: Record<string, unknown> = {}) => call("/jobs", { jobId: `kb-social-media-${card}-a1`, team: "social-media", task: { prompt: `do ${card}` }, ...extra });
  const claim = (seat: string, cls?: string) => call("/claim-next", { team: "social-media", seat, ...(cls ? { class: cls } : {}) });
  return { store, events, call, submit, claim };
}

test("late binding: submit never touches the daemon; a claim creates the qitem for that seat and claims it", async () => {
  const d = fakeDaemon();
  const t = setup(d.daemon);
  assert.equal((await t.claim("dev-a@team")).status, 204, "nothing queued");
  await t.submit("t_1");
  await t.submit("t_2");
  assert.deepEqual(d.calls, [], "submitting binds nothing upstream");

  const first = await t.claim("dev-a@team");
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.deepEqual([body.job.jobId, body.job.state, body.qitemId, body.seat, body.envelope.task.prompt], ["kb-social-media-t_1-a1", "claimed", "qitem-test-2", "dev-a@team", "do t_1"]);
  // The id is minted before the reservation that stores it, so the empty claim above used qitem-test-1.
  assert.deepEqual(d.calls, [["create", "qitem-test-2", "dev-a@team", "plantworks-broker"], ["claim", "qitem-test-2", "dev-a@team"]]);
  const row = t.store.get("kb-social-media-t_1-a1")!;
  assert.deepEqual([row.claimed_by, row.qitem_id, row.reserved_by], ["dev-a@team", "qitem-test-2", null]);

  assert.equal((await (await t.claim("dev-b@team")).json()).job.jobId, "kb-social-media-t_2-a1", "oldest first");
  assert.equal((await t.claim("dev-c@team")).status, 204);
  assert.deepEqual(t.events, [["kb-social-media-t_1-a1", "queued"], ["kb-social-media-t_2-a1", "queued"], ["kb-social-media-t_1-a1", "claimed"], ["kb-social-media-t_2-a1", "claimed"]]);
});

test("queue classes: a seat claims only its class, and no class means the team's default", async () => {
  const t = setup(fakeDaemon().daemon);
  await t.submit("t_deep", { class: "deep" });
  await t.submit("t_quick");
  assert.equal((await (await t.claim("dev-a@team", "deep")).json()).job.jobId, "kb-social-media-t_deep-a1");
  assert.equal((await t.claim("dev-b@team", "deep")).status, 204, "the quick job isn't a deep job");
  assert.equal((await (await t.claim("dev-b@team")).json()).job.class, "quick");
});

const DAY = 24 * 3600 * 1000;
const reservationOf = (t: ReturnType<typeof setup>, card: string) => {
  const r = t.store.get(`kb-social-media-${card}-a1`)!;
  return [r.state, r.reserved_by, r.reserved_qitem_id];
};

test("a daemon that refuses the create (4xx) delivered nothing, so the job is released and claimable again", async () => {
  let refuse = true;
  const t = setup(fakeDaemon({ create: () => { if (refuse) throw new DaemonRefused("daemon /create returned 400"); } }).daemon);
  await t.submit("t_1");
  const r = await t.claim("dev-a@team");
  assert.deepEqual([r.status, (await r.json()).error], [503, "daemon_refused"]);
  assert.deepEqual(reservationOf(t, "t_1"), ["queued", null, null]);
  refuse = false;
  assert.equal((await t.claim("dev-b@team")).status, 200);
  assert.deepEqual(t.events.map((e) => e[1]), ["queued", "claimed"]);
});

test("fail-closed: an ambiguous handoff keeps the reservation, counted and unclaimable, with its qitem id stored", async () => {
  // Each failure after the daemon may have persisted (and so delivered) the qitem.
  const cases: [string, () => ReturnType<typeof fakeDaemon>][] = [
    ["create timed out", () => fakeDaemon({ create: () => { throw new Error("The operation was aborted due to timeout"); } })],
    ["create 5xx", () => fakeDaemon({ create: () => { throw new Error("daemon /create returned 500"); } })],
    ["claim failed after create", () => fakeDaemon({ claim: () => { throw new Error("daemon /claim returned 409"); } })],
  ];
  for (const [name, make] of cases) {
    let clock = new Date("2026-10-24T12:00:00Z");
    const d = make();
    const t = setup(d.daemon, () => clock, undefined, parseSlotCaps(undefined));
    await t.submit("t_1");
    await t.submit("t_2");
    const r = await t.claim("dev-a@team");
    const body = await r.json();
    assert.deepEqual([r.status, body.error, body.jobId, body.qitemId], [503, "handoff_unconfirmed", "kb-social-media-t_1-a1", "qitem-test-1"], name);
    assert.deepEqual(reservationOf(t, "t_1"), ["queued", "dev-a@team", "qitem-test-1"], `${name}: kept with its qitem id`);
    // A day later the reservation still holds its slot (cap 1), and no seat can take the job.
    clock = new Date(clock.getTime() + DAY);
    assert.equal((await t.claim("dev-b@team")).status, 429, `${name}: still counted`);
    assert.deepEqual(reservationOf(t, "t_1"), ["queued", "dev-a@team", "qitem-test-1"], `${name}: the exact qitem id survives, unchanged`);
    assert.throws(() => t.store.transition("kb-social-media-t_1-a1", "cancelled", { reason: "front-door" }), /is reserved for a seat/, `${name}: no side transition frees it`);
    const roomy = setup(make().daemon, () => clock);
    await roomy.submit("t_1");
    await roomy.claim("dev-a@team");
    clock = new Date(clock.getTime() + DAY);
    const other = await roomy.claim("dev-b@team");
    assert.equal(other.status, 204, `${name}: never handed to a second seat`);
    assert.deepEqual(t.events.map((e) => e[1]), ["queued", "queued"], `${name}: nothing published`);
    assert.deepEqual(d.calls.filter((c) => c[0] === "create").length, 1, `${name}: no second qitem`);
  }
});

test("r2 regression: a handoff that outlives any lease is never replaced by a second qitem", async () => {
  let clock = new Date("2026-10-24T12:00:00Z");
  let finish!: () => void;
  const slow = new Promise<void>((r) => { finish = r; });
  const d = fakeDaemon({ create: async () => { if (d.calls.length === 1) await slow; } });
  const t = setup(d.daemon, () => clock, undefined, parseSlotCaps("social-media=2"));
  await t.submit("t_1");
  const first = t.claim("dev-a@team");
  await new Promise((r) => setImmediate(r));
  clock = new Date(clock.getTime() + DAY); // the create hangs far past any lease
  assert.equal((await t.claim("dev-b@team")).status, 204, "the job is still dev-a's handoff");
  assert.deepEqual(d.calls.map((c) => c[0]), ["create"], "no second create");
  finish();
  assert.equal((await first).status, 200);
  assert.equal(t.store.get("kb-social-media-t_1-a1")!.claimed_by, "dev-a@team");
});

test("a job being handed over can't be cancelled, since cancelling would free a slot Pi may be using", async () => {
  let t: ReturnType<typeof setup>;
  let cancel!: Response;
  const d = fakeDaemon({ claim: async () => { cancel = await t.call("/jobs/kb-social-media-t_1-a1/cancel", {}); } });
  t = setup(d.daemon);
  await t.submit("t_1");
  assert.equal((await t.claim("dev-a@team")).status, 200);
  assert.deepEqual([cancel.status, (await cancel.json()).error], [409, "not_cancellable"]);
  assert.deepEqual(t.events.map((e) => e[1]), ["queued", "claimed"]);
});

test("bad requests are refused before anything is reserved, and the broker token covers claim-next", async () => {
  const d = fakeDaemon();
  const t = setup(d.daemon);
  for (const [body, error] of [
    [{ team: "social-media" }, "invalid_claim"],
    [{ team: "social-media", seat: "../x" }, "invalid_claim"],
    [{ team: "other", seat: "dev-a@team" }, "unknown_team"],
    [{ team: "social-media", seat: "dev-a@team", class: "huge" }, "unknown_class"],
  ] as const) {
    const r = await t.call("/claim-next", body);
    assert.deepEqual([r.status, (await r.json()).error], [400, error]);
  }
  const locked = setup(d.daemon, undefined, "s3cret");
  assert.equal((await locked.claim("dev-a@team")).status, 401);
  assert.equal((await locked.call("/claim-next", { team: "social-media", seat: "dev-a@team" }, { authorization: "Bearer s3cret" })).status, 204);
  assert.deepEqual(d.calls, []);
});

test("daemonQueue speaks the daemon's queue API, and only a non-409 4xx counts as a refusal", async () => {
  const seen: { url: string; auth?: string; session?: string; body: unknown }[] = [];
  let status = 201;
  const server = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    seen.push({ url: req.url!, auth: req.headers.authorization, session: req.headers["x-openrig-session"] as string | undefined, body: b ? JSON.parse(b) : null });
    const result = req.method === "GET" && req.url?.endsWith("/transitions") ? "[]" : req.method === "GET" ? JSON.stringify({ qitemId: "qitem-1", state: "done", destinationSession: "dev-a@team" }) : "{}";
    res.writeHead(status, { "content-type": "application/json" }).end(result);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const q = daemonQueue({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token: "daemon-token" });
    await q.create({ qitemId: "qitem-1", source: "plantworks-broker", destination: "dev-a@team", body: "b", summary: "s", tags: ["plantworks"] });
    await q.claim("qitem-1", "dev-a@team");
    const inspected = await q.inspect("qitem-1");
    assert.deepEqual([inspected.qitemId, inspected.destinationSession, inspected.transitions], ["qitem-1", "dev-a@team", []]);
    assert.deepEqual(seen.map((s) => [s.url, s.auth, s.session]), [
      ["/api/queue/create", "Bearer daemon-token", undefined],
      ["/api/queue/qitem-1/claim", "Bearer daemon-token", undefined],
      ["/api/queue/qitem-1", "Bearer daemon-token", undefined],
      ["/api/queue/qitem-1/transitions", "Bearer daemon-token", undefined],
    ]);
    assert.deepEqual(seen[0].body, { qitemId: "qitem-1", sourceSession: "plantworks-broker", destinationSession: "dev-a@team", body: "b", summary: "s", tags: ["plantworks"] });
    assert.deepEqual(seen[1].body, { destinationSession: "dev-a@team" });
    for (const [code, refused] of [[400, true], [404, true], [409, false], [500, false], [503, false]] as const) {
      status = code;
      await assert.rejects(q.create({ qitemId: "q", source: "s", destination: "d", body: "b", summary: "s", tags: [] }), (e: Error) => (e instanceof DaemonRefused) === refused, String(code));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  // A dropped connection is ambiguous too.
  await assert.rejects(daemonQueue({ url: "http://127.0.0.1:9", timeoutMs: 500 }).create({ qitemId: "q", source: "s", destination: "d", body: "b", summary: "s", tags: [] }), (e: Error) => !(e instanceof DaemonRefused));
  assert.match(newQitemId(new Date("2026-10-24T12:34:56Z")), /^qitem-20261024123456-[0-9a-f]{16}$/);
});

// PW-19: the slot cap, through claim-next.
test("the default cap is 1 in flight per slot budget key; a terminal job frees its slot", async () => {
  const t = setup(fakeDaemon().daemon, undefined, undefined, parseSlotCaps(undefined));
  await t.submit("t_1");
  await t.submit("t_2");
  assert.equal((await t.claim("dev-a@team")).status, 200);
  const capped = await t.claim("dev-b@team");
  assert.equal(capped.status, 429);
  assert.deepEqual(await capped.json(), { error: "slot_cap_reached", message: "slot budget social-media has 1 of 1 jobs in flight; ask again later", slotBudgetKey: "social-media", cap: 1, inFlight: 1 });
  t.store.transition("kb-social-media-t_1-a1", "running");
  assert.equal((await t.claim("dev-b@team")).status, 429, "running still holds the slot");
  t.store.transition("kb-social-media-t_1-a1", "done", { outcome: "succeeded" });
  assert.equal((await (await t.claim("dev-b@team")).json()).job.jobId, "kb-social-media-t_2-a1", "done freed it");
});

test("concurrent claims never exceed the cap, because a reservation holds its slot during the handoff", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const t = setup(fakeDaemon({ create: () => gate }).daemon, undefined, undefined, parseSlotCaps("social-media=2"));
  for (const card of ["t_1", "t_2", "t_3", "t_4"]) await t.submit(card);
  // Four seats ask at once; every handoff is held at the daemon, so all four overlap.
  const pending = ["a", "b", "c", "d"].map((s) => t.claim(`dev-${s}@team`));
  await new Promise((r) => setImmediate(r));
  open();
  const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 429, 429]);
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'claimed'").get().n, 2);
});

test("cap 0 stops claims for a key", async () => {
  const t = setup(fakeDaemon().daemon, undefined, undefined, parseSlotCaps("5,social-media=0"));
  await t.submit("t_1");
  assert.equal((await t.claim("dev-a@team")).status, 429);
});

test("two broker connections on one SQLite file: a side transition can't free another's reservation", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pw-2conn-")), "broker.sqlite");
  const a = openStore(file);
  const b = openStore(file);
  try {
    a.insert({ jobId: "kb-social-media-t_1-a1", team: "social-media", task: { prompt: "p" } }, "quick", "queued");
    const stale = a.get("kb-social-media-t_1-a1")!;
    assert.equal(stale.reserved_by, null, "A has seen the job unreserved");
    // B reserves after A's read; A's transition must still refuse.
    assert.ok(b.reserve("social-media", "quick", "dev-b@team", "qitem-b"));
    assert.throws(() => a.transition("kb-social-media-t_1-a1", "cancelled", { reason: "front-door" }), /is reserved for a seat/);
    assert.deepEqual([a.get("kb-social-media-t_1-a1")!.state, a.get("kb-social-media-t_1-a1")!.reserved_qitem_id], ["queued", "qitem-b"]);
    // Store transactions are IMMEDIATE: while A holds the write lock, B can't reserve or transition at all.
    b.db.pragma("busy_timeout = 0");
    a.db.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(() => b.release("kb-social-media-t_1-a1", "dev-b@team", "qitem-b"), /database is locked|SQLITE_BUSY/);
      assert.throws(() => b.confirmClaim("kb-social-media-t_1-a1", "dev-b@team", "qitem-b"), /database is locked|SQLITE_BUSY/);
    } finally {
      a.db.exec("COMMIT");
    }
    assert.notEqual(b.confirmClaim("kb-social-media-t_1-a1", "dev-b@team", "qitem-b"), "lost", "B, the holder, settles it");
  } finally {
    a.close();
    b.close();
  }
});

test("reconciliation keeps a dead worker's slot through ambiguity and releases it only on authenticated no-follow-on completion", async () => {
  let observation: QueueObservation = { qitemId: "qitem-test-1", state: "in-progress", destinationSession: "dev-a@team", transitions: [] };
  let readable = true;
  const daemon = fakeDaemon({ inspect: () => { if (!readable) throw new Error("daemon unavailable"); return observation; } }).daemon;
  const t = setup(daemon, undefined, undefined, parseSlotCaps(undefined));
  await t.submit("t_1"); await t.submit("t_2");
  assert.equal((await t.claim("dev-a@team")).status, 200);
  const row = t.store.get("kb-social-media-t_1-a1")!;
  const reconcile = createReconciler(t.store, daemon, (r, s) => t.events.push([r.job_id, s]), () => {});
  await reconcile();
  assert.equal(t.store.get(row.job_id)!.state, "running", "active daemon work does not complete");
  assert.equal((await t.claim("dev-b@team")).status, 429);
  readable = false;
  await reconcile();
  assert.equal(t.store.get(row.job_id)!.state, "running", "unreadable completion evidence fails closed");
  assert.equal((await t.claim("dev-b@team")).status, 429);
  readable = true;

  for (const ambiguous of [
    { ...observation, state: "done", closureReason: "canceled", closingTransition: { transitionId: 1, state: "done", closureReason: "canceled", closureTarget: null, actorSession: "admin" }, transitions: [{ transitionId: 1, state: "done", closureReason: "canceled", closureTarget: null, actorSession: "admin", identityProvenance: "transport:v1" }] },
    { ...observation, state: "handed-off", closureReason: "no-follow-on" },
    { ...observation, qitemId: "different-qitem", state: "done", closureReason: "no-follow-on" },
    { ...observation, state: "done", closureReason: "no-follow-on", closingTransition: { transitionId: 2, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-b@team" }, transitions: [{ transitionId: 2, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-b@team", identityProvenance: "transport:v1" }] },
    { ...observation, state: "done", closureReason: "no-follow-on", closingTransition: { transitionId: 2, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team" }, transitions: [{ transitionId: 2, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team", identityProvenance: "claimed:v1" }] },
    { ...observation, state: "done", closureReason: "no-follow-on", closingTransition: { transitionId: 4, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team" }, transitions: [{ transitionId: 3, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team", identityProvenance: "transport:v1" }] },
    { ...observation, state: "done", closureReason: "no-follow-on", closingTransition: { transitionId: 5, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team" }, transitions: [
      { transitionId: 5, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team", identityProvenance: "transport:v1" },
      { transitionId: 6, state: "in-progress", closureReason: null, closureTarget: null, actorSession: "dev-a@team", identityProvenance: "transport:v1" },
    ] },
  ] as QueueObservation[]) {
    observation = ambiguous;
    await reconcile();
    assert.equal(t.store.get(row.job_id)!.state, "running");
    assert.equal((await t.claim("dev-b@team")).status, 429);
  }

  observation = { ...observation, qitemId: "qitem-test-1", state: "done", closureReason: "no-follow-on", closureTarget: null,
    closingTransition: { transitionId: 5, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team" },
    transitions: [{ transitionId: 5, state: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-a@team", identityProvenance: "transport:v1" }] };
  await reconcile();
  assert.equal(t.store.get(row.job_id)!.state, "done");
  assert.equal((await t.claim("dev-b@team")).status, 200, "only authenticated logical completion frees the slot");
});
