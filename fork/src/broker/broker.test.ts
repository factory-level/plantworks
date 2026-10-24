// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { stubConsumer } from "../job/fixtures/stubs.ts";
import { API, createBroker, expand, jobRecord, loadTeams, startBroker, type BrokerRoutes, type Emit } from "./server.ts";
import { openStore } from "./store.ts";

// The ADR 0204 sample team: `quick` needs no approval, `long` is per-job (refused until PW-23).
const definition = (team = "social-media") => ({
  team,
  trains: 1,
  perTrain: { orchestrators: 1, workers: { quick: 1, long: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: team },
  defaultClass: "quick",
  classes: {
    quick: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 2 },
    long: { slots: 0, model: "qwen3.5:9b", context: { maxContextTokens: 32768, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1024, deadlineSeconds: 60 }, approval: "per-job", timeoutSeconds: 3600, maxAttempts: 1 },
  },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
});
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 1 } };

function teamsDir(defs = [definition()]) {
  const dir = mkdtempSync(join(tmpdir(), "pw-teams-"));
  for (const d of defs) assert.ok("files" in emitTeam(d, dir, { ...platform, slotCaps: { [d.team]: 1 } }));
  return dir;
}

const envelope = (over: Record<string, unknown> = {}) => ({ jobId: "kb-social-media-t_3fa9c01e-a1", team: "social-media", task: { prompt: "Say hi" }, ...over });

function setup(opts: { token?: string; routes?: BrokerRoutes[] } = {}) {
  const store = openStore(":memory:");
  const events: [string, string, Record<string, unknown>][] = [];
  const emit: Emit = (row, state, detail = {}) => events.push([row.job_id, state, detail]);
  const app = createBroker({ store, teams: loadTeams(teamsDir(), platform), emit, ...opts });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`${API}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { store, events, app, call };
}

test("submit is idempotent on jobId: 201 new, 200 the same envelope, 409 job_conflict a different one", async () => {
  const t = setup();
  const first = await t.call("POST", "/jobs", envelope());
  assert.equal(first.status, 201);
  const rec = await first.json();
  assert.deepEqual({ ...rec, createdAt: 0, updatedAt: 0 }, { jobId: envelope().jobId, team: "social-media", class: "quick", state: "queued", detail: {}, createdAt: 0, updatedAt: 0, result: null });
  // Same envelope, other key order: the existing job, nothing new emitted.
  const again = await t.call("POST", "/jobs", { task: { prompt: "Say hi" }, team: "social-media", jobId: envelope().jobId });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), rec);
  const clash = await t.call("POST", "/jobs", envelope({ task: { prompt: "Say bye" } }));
  assert.equal(clash.status, 409);
  assert.equal((await clash.json()).error, "job_conflict");
  assert.deepEqual(t.events, [[envelope().jobId, "queued", {}]]);
  assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM jobs").get().n, 1);
});

test("submit refuses what the team spec does not allow, before storing anything", async () => {
  const t = setup();
  const cases: [unknown, string][] = [
    ["{not json", "invalid_envelope"],
    [envelope({ jobId: "nope" }), "invalid_envelope"],
    [envelope({ team: "other-team", jobId: "kb-x-t_00000000-a1" }), "unknown_team"],
    [envelope({ class: "huge" }), "unknown_class"],
    [envelope({ timeoutSeconds: 901 }), "timeout_over_ceiling"],
    [envelope({ class: "long" }), "approval_unsupported"],
  ];
  for (const [body, error] of cases) {
    const res = await t.call("POST", "/jobs", body);
    assert.equal(res.status, 400, error);
    assert.equal((await res.json()).error, error);
  }
  assert.equal(t.store.db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0);
  assert.equal(t.events.length, 0);
});

test("inspect and cancel: queued -> cancelled once, cancelled again is 200, a claimed job is 409", async () => {
  const t = setup();
  assert.equal((await t.call("GET", "/jobs/kb-social-media-t_3fa9c01e-a1")).status, 404);
  await t.call("POST", "/jobs", envelope());
  assert.equal((await (await t.call("GET", `/jobs/${envelope().jobId}`)).json()).state, "queued");

  const cancel = await t.call("POST", `/jobs/${envelope().jobId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.deepEqual([(await cancel.json()).state, t.events.at(-1)], ["cancelled", [envelope().jobId, "cancelled", { reason: "front-door" }]]);
  const again = await t.call("POST", `/jobs/${envelope().jobId}/cancel`);
  assert.equal(again.status, 200);
  assert.equal(t.events.length, 2, "an idempotent cancel emits nothing");

  const claimed = envelope({ jobId: "kb-social-media-t_3fa9c01e-a2" });
  await t.call("POST", "/jobs", claimed);
  t.store.transition(claimed.jobId, "claimed", {}, { claimed_by: "pw-seat-1" });
  const refused = await t.call("POST", `/jobs/${claimed.jobId}/cancel`);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "not_cancellable");
  assert.equal((await t.call("POST", "/jobs/kb-social-media-t_00000000-a1/cancel")).status, 404);
});

test("with a token, every API route needs the bearer, including routes other cards add", async () => {
  const extra: BrokerRoutes = (app, ctx) => app.get(`${API}/teams`, (c) => c.json([...ctx.teams.keys()]));
  const t = setup({ token: "s3cret", routes: [extra] });
  for (const auth of [undefined, "Bearer wrong", "s3cret"]) {
    const res = await t.call("GET", "/teams", undefined, auth ? { authorization: auth } : {});
    assert.equal(res.status, 401, String(auth));
    assert.equal((await res.json()).error, "unauthorized");
  }
  const ok = await t.call("GET", "/teams", undefined, { authorization: "Bearer s3cret" });
  assert.deepEqual(await ok.json(), ["social-media"]);
  assert.equal((await t.call("POST", "/jobs", envelope(), { authorization: "Bearer s3cret" })).status, 201);
});

test("the record has exactly the published schema's fields", () => {
  const schema = JSON.parse(readFileSync(new URL("../../schema/job-record.schema.json", import.meta.url), "utf8"));
  const store = openStore(":memory:");
  const { row } = store.insert(envelope() as any, "quick", "queued");
  assert.deepEqual(Object.keys(jobRecord(row)).sort(), [...schema.required].sort());
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
});

test("store: transitions are checked and atomic; reservations take the oldest job and expire", () => {
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const store = openStore(":memory:", () => new Date(clock));
  for (const n of [1, 2]) store.insert(envelope({ jobId: `kb-social-media-t_0000000${n}-a1` }) as any, "quick", "queued");
  assert.throws(() => store.transition("kb-social-media-t_00000001-a1", "done", { outcome: "succeeded" }), /illegal job transition queued -> done/);
  assert.throws(() => store.transition("kb-social-media-t_00000001-a1", "claimed", {}, { state: "done" } as any), /cannot set state/);
  assert.equal(store.get("kb-social-media-t_00000001-a1")!.state, "queued");

  const a = store.reserve("social-media", "quick", "seat-a", "q-1", 1000)!;
  assert.deepEqual([a.job.job_id, a.job.state, a.job.reserved_by, a.job.reserved_qitem_id, a.previousQitemId], ["kb-social-media-t_00000001-a1", "queued", "seat-a", "q-1", null]);
  assert.equal(store.reserve("social-media", "quick", "seat-b", "q-2", 1000)!.job.job_id, "kb-social-media-t_00000002-a1", "a reserved job is skipped");
  assert.equal(store.reserve("social-media", "quick", "seat-c", "q-3", 1000), undefined);
  clock += 1000;
  const takeover = store.reserve("social-media", "quick", "seat-c", "q-3", 1000)!;
  assert.deepEqual([takeover.job.job_id, takeover.previousQitemId], ["kb-social-media-t_00000001-a1", "q-1"], "an expired lease is taken over, naming the orphan qitem");

  store.release("kb-social-media-t_00000001-a1", "seat-a");
  assert.equal(store.get("kb-social-media-t_00000001-a1")!.reserved_by, "seat-c", "only the holder can release");
  // Seat A's late confirm loses to seat C's takeover; C's confirm wins.
  assert.equal(store.confirmClaim("kb-social-media-t_00000001-a1", "seat-a", "q-1"), "lost");
  assert.equal(store.confirmClaim("kb-social-media-t_00000001-a1", "seat-c", "q-other"), "lost", "the qitem must match too");
  const won = store.confirmClaim("kb-social-media-t_00000001-a1", "seat-c", "q-3");
  assert.notEqual(won, "lost");
  const claimed = (won as { row: any }).row;
  assert.deepEqual([claimed.state, claimed.claimed_by, claimed.qitem_id, claimed.reserved_by, claimed.reserved_qitem_id], ["claimed", "seat-c", "q-3", null, null]);
  assert.equal(claimed.claimed_at, new Date(clock).toISOString());
  assert.equal(store.confirmClaim("kb-social-media-t_00000001-a1", "seat-c", "q-3"), "lost", "a claimed job cannot be confirmed twice");

  // A job cancelled while reserved: the holder's confirm is lost.
  store.reserve("social-media", "quick", "seat-d", "q-4", 1000);
  store.transition("kb-social-media-t_00000002-a1", "cancelled", { reason: "front-door" });
  assert.equal(store.confirmClaim("kb-social-media-t_00000002-a1", "seat-d", "q-4"), "lost");
});

test("team specs: an invalid spec, a misplaced one or an unset placeholder stops the broker", () => {
  const bad = teamsDir();
  const file = join(bad, "social-media", "team.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), defaultClass: "missing" }));
  assert.throws(() => loadTeams(bad, platform), /invalid team specs:\n.*social-media\/team.json/);
  assert.throws(() => loadTeams(teamsDir(), PHASE_0_1), /slot/i, "validated against the platform");
  const misplaced = teamsDir([definition("news")]);
  renameSync(join(misplaced, "news"), join(misplaced, "sports"));
  assert.throws(() => loadTeams(misplaced, { ...platform, slotCaps: { news: 1 } }), /team is news, but the directory is sports/);
  assert.throws(() => loadTeams(mkdtempSync(join(tmpdir(), "pw-empty-"))), /no team specs/);

  assert.equal(expand("${A}/events", { A: "http://127.0.0.1:1" }), "http://127.0.0.1:1/events");
  assert.throws(() => expand("${PLANTWORKS_FRONTDOOR_CALLBACK}", {}), /PLANTWORKS_FRONTDOOR_CALLBACK is not set/);
  const store = openStore(":memory:");
  assert.throws(() => createBroker({ store, teams: loadTeams(teamsDir(), platform), env: {} }), /not set/);
  assert.throws(() => startBroker({ store, teams: loadTeams(teamsDir(), platform), host: "0.0.0.0", port: 0, env: {} }), /refusing to bind the broker on 0.0.0.0/);
});

// End to end through the real binary: serve, submit over HTTP, the queued event reaches the
// team's callback, the job survives a restart in the broker's own SQLite file.
test("plantworks pw broker serve: submit over HTTP, the event is delivered, and jobs persist", async () => {
  const consumer = await stubConsumer();
  const home = mkdtempSync(join(tmpdir(), "pw-broker-"));
  const platformFile = join(home, "platform.json");
  writeFileSync(platformFile, JSON.stringify(platform));
  const env = { ...process.env, OPENRIG_HOME: home, PLANTWORKS_TEAMS_DIR: teamsDir(), PLANTWORKS_FRONTDOOR_CALLBACK: consumer.url, PLANTWORKS_BROKER_TOKEN: "t0k" };
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const serve = async () => {
    const child = spawn(process.execPath, [bin, "pw", "broker", "serve", "--platform", platformFile, "--port", "0"], { env });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => { out += d; const m = /listening on (\S+)/.exec(out); if (m) resolve(m[1]!); });
      child.on("exit", (code) => reject(new Error(`broker exited ${code}`)));
    });
    return { url, stop: () => new Promise<void>((r) => { child.once("exit", () => r()); child.kill("SIGTERM"); }) };
  };
  const post = (url: string, body: unknown) => fetch(`${url}${API}/jobs`, { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json" }, body: JSON.stringify(body) });

  let b = await serve();
  assert.equal((await post(b.url, envelope())).status, 201);
  for (let i = 0; i < 50 && !consumer.events.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(consumer.states(), ["queued"]);
  assert.equal(consumer.events[0].id, `${envelope().jobId}:queued`);
  await b.stop();
  assert.ok(existsSync(join(home, "plantworks", "broker.sqlite")), "its own file under the home, not the daemon's db");

  b = await serve();
  assert.equal((await post(b.url, envelope())).status, 200, "the restarted broker still knows the job");
  await b.stop();
  await consumer.close();
});
