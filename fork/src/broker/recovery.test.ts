// SPDX-License-Identifier: Apache-2.0
// W3-A: a broker crash (or failed call) between qitem create and claim, recovered by retrying the
// same qitem id for the same seat. A stateful fake daemon; no real daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { DaemonRefused, QitemNotFound, claimNextRoutes, daemonQueue, type DaemonQueue, type QueueObservation } from "./claim.ts";
import { createReconciler } from "./reconcile.ts";
import { API, createBroker, loadTeams } from "./server.ts";
import { openStore, RESERVATION_LEASE_MS } from "./store.ts";
import { parseSlotCaps } from "./slots.ts";

const cls = { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 };
const definition = {
  team: "social-media", trains: 1, perTrain: { orchestrators: 1, workers: { quick: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" }, defaultClass: "quick", classes: { quick: cls },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
};
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 1 } };
const JOB = "kb-social-media-t_1-a1";
const SEAT = "dev-a@team";

/** A daemon queue with real state: create is idempotent per id, claim moves pending to in-progress. */
function statefulDaemon() {
  const items = new Map<string, QueueObservation>();
  const calls: string[] = [];
  const fail: { create?: Error; claim?: Error; inspect?: Error } = {};
  const daemon: DaemonQueue = {
    async create(i) {
      calls.push(`create ${i.qitemId} ${i.destination}`);
      if (fail.create) throw fail.create;
      if (!items.has(i.qitemId)) items.set(i.qitemId, { qitemId: i.qitemId, state: "pending", destinationSession: i.destination, transitions: [] });
    },
    async claim(q, seat) {
      calls.push(`claim ${q} ${seat}`);
      if (fail.claim) throw fail.claim;
      const item = items.get(q)!;
      if (item.state !== "pending") throw new Error("daemon /claim returned 409: qitem_not_claimable");
      item.state = "in-progress";
    },
    async inspect(q) {
      if (fail.inspect) throw fail.inspect;
      const item = items.get(q);
      if (!item) throw new QitemNotFound(`daemon /${q} returned 404`);
      return structuredClone(item);
    },
  };
  return { daemon, items, calls, fail };
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "pw-recovery-"));
  assert.ok("files" in emitTeam(definition, dir, platform));
  const file = join(dir, "broker.sqlite");
  const teams = loadTeams(dir, platform);
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const d = statefulDaemon();
  const events: [string, string][] = [];
  /** One broker process: a store on the shared file, claim-next and a reconciler. */
  const boot = () => {
    const store = openStore(file, () => new Date(clock));
    const app = createBroker({ store, teams, send: () => {}, publicUrl: "http://broker.test", routes: [claimNextRoutes({ daemon: d.daemon, brokerSession: "plantworks-broker", slotCaps: parseSlotCaps(undefined), newQitemId: () => "qitem-test-1", log: () => {} })] });
    const call = (path: string, body: unknown) => app.request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const reconcile = createReconciler(store, d.daemon, (r, s) => events.push([r.job_id, s]), () => {}, 16, { brokerSession: "plantworks-broker", now: () => clock });
    return { store, call, reconcile };
  };
  return { ...d, events, boot, advance: (ms: number) => { clock += ms; } };
}

test("crash after create, before claim: after a restart and the lease, the same qitem is claimed for the same seat and the job is claimed once", async () => {
  const w = world();
  let b = w.boot();
  await b.call("/jobs", { jobId: JOB, team: "social-media", task: { prompt: "p" } });
  w.fail.claim = new Error("connection reset");
  assert.equal((await b.call("/claim-next", { team: "social-media", seat: SEAT })).status, 503, "the claim after the create failed: unconfirmed");
  delete w.fail.claim;
  b.store.close();

  b = w.boot(); // the broker restarts on the same file
  await b.reconcile();
  assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.reserved_by], ["queued", SEAT], "inside the lease a restarted broker changes nothing");
  assert.deepEqual(w.calls, [`create qitem-test-1 ${SEAT}`, `claim qitem-test-1 ${SEAT}`]);
  assert.equal(w.items.get("qitem-test-1")!.state, "pending");
  assert.equal((await b.call("/claim-next", { team: "social-media", seat: "dev-b@team" })).status, 429, "the reservation still holds the slot");

  w.advance(RESERVATION_LEASE_MS);
  await b.reconcile();
  assert.deepEqual(w.calls.slice(2), [`claim qitem-test-1 ${SEAT}`], "the claim is retried with the same id; nothing is created again");
  assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.claimed_by, b.store.get(JOB)!.qitem_id], ["running", SEAT, "qitem-test-1"]);
  assert.deepEqual(w.events.map(([, s]) => s), ["claimed", "running"]);
  await b.reconcile();
  assert.equal(w.calls.length, 3, "a settled handoff is not touched again");
  assert.equal(w.items.size, 1);
});

test("crash between reserve and create: after the lease the qitem is created with the stored id for the reserving seat, once", async () => {
  const w = world();
  let b = w.boot();
  await b.call("/jobs", { jobId: JOB, team: "social-media", task: { prompt: "p" } });
  // The broker died after reserve() committed and before the create request left.
  b.store.reserve("social-media", "quick", SEAT, "qitem-stored-1");
  b.store.close();

  b = w.boot();
  w.advance(RESERVATION_LEASE_MS - 1);
  await b.reconcile();
  assert.deepEqual(w.calls, [], "a young reservation may still be mid-handoff: untouched");
  w.advance(1);
  w.fail.inspect = new Error("daemon unavailable");
  await b.reconcile();
  assert.deepEqual([w.calls, b.store.get(JOB)!.reserved_by], [[], SEAT], "no answer from the daemon is not evidence: nothing is created or released");
  delete w.fail.inspect;

  await b.reconcile();
  assert.deepEqual(w.calls, [`create qitem-stored-1 ${SEAT}`, `claim qitem-stored-1 ${SEAT}`]);
  assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.claimed_by], ["running", SEAT]);
  assert.equal(w.items.size, 1);
});

test("recovery that finds a refused create releases the job, as claim-next does; an unknown create failure keeps it", async () => {
  const w = world();
  const b = w.boot();
  await b.call("/jobs", { jobId: JOB, team: "social-media", task: { prompt: "p" } });
  b.store.reserve("social-media", "quick", SEAT, "qitem-stored-1");
  w.advance(RESERVATION_LEASE_MS);

  w.fail.create = new Error("daemon /create returned 502");
  await b.reconcile();
  assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.reserved_by], ["queued", SEAT], "a 5xx may have created it: held");
  w.fail.create = new DaemonRefused("daemon /create returned 400: unknown destination");
  await b.reconcile();
  assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.reserved_by], ["queued", null], "refused: nothing delivered, claimable again");
  assert.ok(!w.calls.some((c) => c.startsWith("claim")));
});

test("recovery never takes over: a claimed, running or other-seat qitem is left to the existing reconciliation rules", async () => {
  const w = world();
  const b = w.boot();
  await b.call("/jobs", { jobId: JOB, team: "social-media", task: { prompt: "p" } });
  b.store.reserve("social-media", "quick", SEAT, "qitem-stored-1");
  w.items.set("qitem-stored-1", { qitemId: "qitem-stored-1", state: "pending", destinationSession: "dev-other@team", transitions: [] });
  w.advance(10 * RESERVATION_LEASE_MS);
  await b.reconcile();
  assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.reserved_by], ["queued", SEAT], "still reserved for its seat, however old");
  assert.deepEqual(w.calls, [], "a qitem addressed to another seat is neither claimed nor recreated");
  for (const state of ["in-progress", "done", "handed-off"]) {
    w.items.set("qitem-stored-1", { qitemId: "qitem-stored-1", state, destinationSession: "dev-other@team", transitions: [] });
    await b.reconcile();
    assert.deepEqual([b.store.get(JOB)!.state, b.store.get(JOB)!.reserved_by, w.calls.length], ["queued", SEAT, 0], state);
  }
});

test("daemonQueue.inspect: a 404 for the qitem itself is QitemNotFound; any other failure, including a 404 on its transitions, is a plain Error", async () => {
  let status = 404;
  let transitionsStatus = 200;
  const server = createServer((req, res) => {
    const code = req.url!.endsWith("/transitions") ? transitionsStatus : status;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(req.url!.endsWith("/transitions") ? "[]" : JSON.stringify({ qitemId: "qitem-x", state: "pending", destinationSession: SEAT }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const q = daemonQueue({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  try {
    await assert.rejects(q.inspect("qitem-x"), QitemNotFound);
    status = 503;
    await assert.rejects(q.inspect("qitem-x"), (e: Error) => !(e instanceof QitemNotFound));
    // Only the qitem's own 404 proves absence: a 404 on its transitions is an unknown.
    status = 200;
    transitionsStatus = 404;
    await assert.rejects(q.inspect("qitem-x"), (e: Error) => !(e instanceof QitemNotFound));
  } finally {
    server.close();
  }
});
