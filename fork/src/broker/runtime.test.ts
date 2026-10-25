// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { claimNextRoutes, type DaemonQueue } from "./claim.ts";
import { runtimeRoutes } from "./runtime.ts";
import { API, createBroker, loadTeams, startBroker, type Send } from "./server.ts";
import { openStore } from "./store.ts";
import { parseSlotCaps } from "./slots.ts";
import { sealedEnv } from "../test-support/sealed-env.ts";

const cls = (approval: string, extra = {}) => ({ slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval, timeoutSeconds: 900, maxAttempts: 1, ...extra });
const definition = {
  team: "social-media",
  trains: 1,
  perTrain: { orchestrators: 1, workers: { quick: 5, review: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" },
  defaultClass: "quick",
  classes: { quick: cls("never", { slots: 5 }), review: cls("always", { slots: 1, approvalTtlSeconds: 60 }) },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
};
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 6 } };
const slotCaps = parseSlotCaps("5");
const daemon: DaemonQueue = { async create() {}, async claim() {}, async inspect() { throw new Error("unused"); } };
const id = (n: number) => `kb-social-media-t_0000000${n}-a1`;
const send: Send = () => {};

/**
 * One job in every live state:
 * - 1: queued and unreserved;
 * - 2: queued under seat-b's ambiguous reservation (the qitem may have been delivered);
 * - 3: claimed by seat-c;
 * - 4: running on seat-d;
 * - 5: done (not live);
 * - 6: held for approval.
 */
function world(token?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pw-runtime-"));
  assert.ok("files" in emitTeam(definition, dir, platform));
  const teams = loadTeams(dir, platform);
  const store = openStore(":memory:");
  const insert = (n: number, c = "quick") => store.insert({ jobId: id(n), team: "social-media", task: { prompt: `job ${n}` } } as any, c, c === "review" ? "held" : "queued", c === "review" ? 60 : undefined);
  const claim = (n: number, seat: string) => { store.reserve("social-media", "quick", seat, `q-${n}`); return store.confirmClaim(id(n), seat, `q-${n}`); };
  // reserve() takes the oldest unreserved queued job, so each job is inserted just before it is claimed.
  insert(5); claim(5, "seat-e"); store.transition(id(5), "running"); store.transition(id(5), "done", { outcome: "succeeded" });
  insert(4); claim(4, "seat-d"); store.transition(id(4), "running");
  insert(3); claim(3, "seat-c");
  insert(2); store.reserve("social-media", "quick", "seat-b", "q-2");
  insert(1);
  insert(6, "review");
  const app = createBroker({ store, teams, send, token, publicUrl: "http://broker.test", routes: [claimNextRoutes({ daemon, slotCaps, brokerSession: "plantworks-broker", log: () => {} }), runtimeRoutes({ slotCaps })] });
  const call = (method: string, path: string, body?: unknown, auth = token) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, teams, call };
}

test("stats: active is queued + claimed + running; reserved and held are visible; slots match the cap's count", async () => {
  const w = world("t0k");
  assert.deepEqual([w.store.get(id(1))!.reserved_by, w.store.get(id(2))!.reserved_by], [null, "seat-b"]);
  const res = await w.call("GET", `${API}/stats`);
  assert.equal(res.status, 200);
  const live = { active: 4, held: 1, queued: 2, reserved: 1, claimed: 1, running: 1 };
  assert.deepEqual(await res.json(), {
    active: 4,
    teams: { "social-media": { ...live, classes: { quick: { active: 4, held: 0, queued: 2, reserved: 1, claimed: 1, running: 1 }, review: { active: 0, held: 1, queued: 0, reserved: 0, claimed: 0, running: 0 } } } },
    slots: { "social-media": { inFlight: 3, cap: 5 } },
    drainingSeats: [],
  });
  assert.equal((await w.call("GET", `${API}/stats`, undefined, "")).status, 401, "stats stays behind the broker bearer");
});

test("healthz answers without the bearer, says nothing about jobs, and fails when the store is unreadable", async () => {
  const w = world("t0k");
  const ok = await w.call("GET", "/healthz", undefined, "");
  assert.deepEqual([ok.status, await ok.json()], [200, { status: "ok" }]);
  w.store.close();
  const down = await w.call("GET", "/healthz", undefined, "");
  assert.deepEqual([down.status, await down.json()], [503, { status: "unavailable" }]);
});

test("drain stops new work for the seat only, keeps what it holds, and resumes on DELETE", async () => {
  const w = world();
  const drain = await w.call("POST", `${API}/seats/seat-b/drain`);
  assert.deepEqual(await drain.json(), { seat: "seat-b", draining: true, inFlight: [id(2)] }, "an ambiguous reservation of any age is still in flight");

  const refused = await w.call("POST", `${API}/claim-next`, { team: "social-media", seat: "seat-b" });
  assert.deepEqual([refused.status, (await refused.json()).error], [409, "seat_draining"]);
  assert.equal(w.store.get(id(1))!.reserved_by, null, "the refused claim reserved nothing");
  assert.deepEqual((await (await w.call("GET", `${API}/stats`)).json()).drainingSeats, ["seat-b"]);

  const other = await w.call("POST", `${API}/claim-next`, { team: "social-media", seat: "seat-f" });
  assert.equal(other.status, 200, "other seats still claim");
  assert.equal((await other.json()).job.jobId, id(1));

  // Draining never touches the held work: job 2 stays queued under seat-b's reservation.
  assert.deepEqual([w.store.get(id(2))!.state, w.store.get(id(2))!.reserved_by], ["queued", "seat-b"]);
  const resumed = await w.call("DELETE", `${API}/seats/seat-b/drain`);
  assert.deepEqual(await resumed.json(), { seat: "seat-b", draining: false, inFlight: [id(2)] });
  assert.equal((await w.call("POST", `${API}/seats/bad%20seat/drain`)).status, 400);
});

test("plantworks pw worker drain: exit 3 while work is in flight, 4 when another worker resumes the seat mid-drain, 0 once it settles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-runtime-"));
  assert.ok("files" in emitTeam(definition, dir, platform));
  const store = openStore(":memory:");
  store.insert({ jobId: id(3), team: "social-media", task: { prompt: "job 3" } } as any, "quick", "queued");
  store.reserve("social-media", "quick", "seat-c", "q-3");
  store.confirmClaim(id(3), "seat-c", "q-3");
  const broker = await startBroker({ store, teams: loadTeams(dir, platform), send, token: "t0k", host: "127.0.0.1", port: 0, routes: [runtimeRoutes({ slotCaps })] });
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const env = sealedEnv({ OPENRIG_HOME: mkdtempSync(join(tmpdir(), "pw-home-")), PLANTWORKS_BROKER_URL: broker.url, PLANTWORKS_BROKER_TOKEN: "t0k" });
  const drain = (timeoutS = 1) => promisify(execFile)(process.execPath, [bin, "pw", "worker", "drain", "--seat", "seat-c", "--timeout-s", String(timeoutS), "--poll-ms", "100"], { env })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));
  try {
    const timedOut = await drain();
    assert.equal(timedOut.code, 3, timedOut.stderr);
    assert.match(timedOut.stderr, /in-flight work unresolved after 1s \(kb-social-media-t_00000003-a1\); the broker still reports the seat draining.*does not prove execution stopped/);
    assert.equal(store.get(id(3))!.state, "claimed", "a drain timeout fails, cancels and releases nothing");
    assert.equal(store.isDraining("seat-c"), true);

    // Another worker on the same seat name resumes it mid-drain: the drain must not claim success.
    store.setDraining("seat-c", false);
    const resumedMidway = drain(10);
    // Once this drain has set the flag, a `worker run` start on the same seat clears it (its startup DELETE).
    while (!store.isDraining("seat-c")) await new Promise((r) => setTimeout(r, 20));
    store.setDraining("seat-c", false);
    const voided = await resumedMidway;
    assert.equal(voided.code, 4, voided.stderr);
    assert.match(voided.stderr, /drain was ended by another worker resuming this seat .*in flight: kb-social-media-t_00000003-a1/);

    store.transition(id(3), "running");
    store.transition(id(3), "done", { outcome: "succeeded" });
    const drained = await drain();
    assert.equal(drained.code, 0, drained.stderr);
    assert.match(drained.stdout, /seat-c drained: no jobs in flight/);
  } finally {
    await broker.close();
  }
});
