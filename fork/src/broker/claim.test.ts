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
import { claimNextRoutes, daemonQueue, newQitemId, type DaemonQueue } from "./claim.ts";
import { API, createBroker, loadTeams, type Emit } from "./server.ts";
import { openStore, RESERVATION_LEASE_MS } from "./store.ts";

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
function fakeDaemon(hooks: { create?: () => void | Promise<void>; claim?: () => void | Promise<void> } = {}) {
  const calls: Call[] = [];
  const daemon: DaemonQueue = {
    async create(i) { calls.push(["create", i.qitemId, i.destination, i.source]); await hooks.create?.(); },
    async claim(q, seat) { calls.push(["claim", q, seat]); await hooks.claim?.(); },
    async close(q, actor) { calls.push(["close", q, actor]); },
  };
  return { daemon, calls };
}

function setup(daemon: DaemonQueue, now: () => Date = () => new Date(), token?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pw-claim-"));
  assert.ok("files" in emitTeam(definition, dir, platform));
  const store = openStore(":memory:", now);
  const events: [string, string][] = [];
  const emit: Emit = (row, state) => events.push([row.job_id, state]);
  let n = 0;
  const routes = [claimNextRoutes({ daemon, brokerSession: "plantworks-broker", newQitemId: () => `qitem-test-${++n}`, log: () => {} })];
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

test("a daemon failure releases the reservation, closes the qitem, publishes nothing and answers 503", async () => {
  let fail = true;
  const d = fakeDaemon({ claim: () => { if (fail) throw new Error("daemon down"); } });
  const t = setup(d.daemon);
  await t.submit("t_1");
  const r = await t.claim("dev-a@team");
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "daemon_unavailable");
  const row = t.store.get("kb-social-media-t_1-a1")!;
  assert.deepEqual([row.state, row.reserved_by], ["queued", null]);
  assert.deepEqual(d.calls.at(-1), ["close", "qitem-test-1", "plantworks-broker"]);
  assert.deepEqual(t.events.map((e) => e[1]), ["queued"]);
  fail = false;
  assert.equal((await t.claim("dev-a@team")).status, 200, "claimable again at once");
});

test("a crashed claim's expired lease passes to the next seat, whose claim closes the orphan qitem", async () => {
  let clock = new Date("2026-10-24T12:00:00Z");
  const d = fakeDaemon();
  const t = setup(d.daemon, () => clock);
  await t.submit("t_1");
  // A broker that reserved for seat A and died before confirming.
  assert.ok(t.store.reserve("social-media", "quick", "dev-a@team", "qitem-orphan"));
  assert.equal((await t.claim("dev-b@team")).status, 204, "the lease still holds");
  clock = new Date(clock.getTime() + RESERVATION_LEASE_MS + 1);
  const r = await t.claim("dev-b@team");
  assert.equal(r.status, 200);
  assert.deepEqual(d.calls[0], ["close", "qitem-orphan", "plantworks-broker"]);
  assert.equal(t.store.get("kb-social-media-t_1-a1")!.claimed_by, "dev-b@team");
});

test("a job cancelled while being handed over is lost: 409, our qitem closed, no claimed event", async () => {
  let t: ReturnType<typeof setup>;
  const d = fakeDaemon({ claim: async () => { await t.call("/jobs/kb-social-media-t_1-a1/cancel", {}); } });
  t = setup(d.daemon);
  await t.submit("t_1");
  const r = await t.claim("dev-a@team");
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "reservation_lost");
  assert.deepEqual(d.calls.at(-1), ["close", "qitem-test-1", "plantworks-broker"]);
  assert.equal(t.store.get("kb-social-media-t_1-a1")!.state, "cancelled");
  assert.deepEqual(t.events.map((e) => e[1]), ["queued", "cancelled"]);
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

test("daemonQueue speaks the daemon's queue API: seats named in the body, never as X-OpenRig-Session", async () => {
  const seen: { url: string; auth?: string; session?: string; body: unknown }[] = [];
  let status = 201;
  const server = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    seen.push({ url: req.url!, auth: req.headers.authorization, session: req.headers["x-openrig-session"] as string | undefined, body: JSON.parse(b) });
    res.writeHead(status, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const q = daemonQueue({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token: "daemon-token" });
    await q.create({ qitemId: "qitem-1", source: "plantworks-broker", destination: "dev-a@team", body: "b", summary: "s", tags: ["plantworks"] });
    await q.claim("qitem-1", "dev-a@team");
    await q.close("qitem-1", "plantworks-broker", "why");
    assert.deepEqual(seen.map((s) => [s.url, s.auth, s.session]), [
      ["/api/queue/create", "Bearer daemon-token", undefined],
      ["/api/queue/qitem-1/claim", "Bearer daemon-token", undefined],
      ["/api/queue/qitem-1/update", "Bearer daemon-token", undefined],
    ]);
    assert.deepEqual(seen[0].body, { qitemId: "qitem-1", sourceSession: "plantworks-broker", destinationSession: "dev-a@team", body: "b", summary: "s", tags: ["plantworks"] });
    assert.deepEqual(seen[1].body, { destinationSession: "dev-a@team" });
    assert.deepEqual(seen[2].body, { actorSession: "plantworks-broker", state: "done", closureReason: "canceled", transitionNote: "why" });
    status = 409;
    await assert.rejects(q.claim("qitem-1", "dev-b@team"), /daemon \/qitem-1\/claim returned 409/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.match(newQitemId(new Date("2026-10-24T12:34:56Z")), /^qitem-20261024123456-[0-9a-f]{16}$/);
});

test("a stale failure cleanup can't release the same seat's newer reservation (release is fenced by qitem)", async () => {
  // r2's repro on the store: seat S reserves as q1, the lease runs out, S reserves again as q2,
  // then q1's cleanup runs. q2 must survive.
  let clock = new Date("2026-10-24T12:00:00Z");
  const t = setup(fakeDaemon().daemon, () => clock);
  await t.submit("t_1");
  t.store.reserve("social-media", "quick", "dev-s@team", "q1");
  clock = new Date(clock.getTime() + RESERVATION_LEASE_MS + 1);
  t.store.reserve("social-media", "quick", "dev-s@team", "q2");
  t.store.release("kb-social-media-t_1-a1", "dev-s@team", "q1");
  assert.equal(t.store.get("kb-social-media-t_1-a1")!.reserved_qitem_id, "q2");

  // The same race through claim-next: request 1's daemon call outlives its lease, request 2 (same
  // seat) reserves the job, then request 1 fails and cleans up. Request 2 still completes the claim.
  const t2clock = { now: new Date("2026-10-24T12:00:00Z") };
  let release2!: () => void;
  const second = new Promise<void>((r) => { release2 = r; });
  let n = 0;
  let t2: ReturnType<typeof setup>;
  let req2: Promise<Response>;
  const d = fakeDaemon({
    create: async () => {
      if (++n === 1) {
        t2clock.now = new Date(t2clock.now.getTime() + RESERVATION_LEASE_MS + 1);
        req2 = t2.claim("dev-s@team");
        await new Promise((r) => setImmediate(r)); // let request 2 reserve
        throw new Error("daemon timed out");
      }
      await second;
    },
  });
  t2 = setup(d.daemon, () => t2clock.now);
  await t2.submit("t_1");
  assert.equal((await t2.claim("dev-s@team")).status, 503);
  assert.equal(t2.store.get("kb-social-media-t_1-a1")!.reserved_by, "dev-s@team", "request 2's reservation survived request 1's cleanup");
  assert.equal((await t2.claim("dev-other@team")).status, 204, "so no other seat can take the job mid-handoff");
  release2();
  const r2 = await req2!;
  assert.equal(r2.status, 200);
  assert.equal(t2.store.get("kb-social-media-t_1-a1")!.state, "claimed");
});
