// SPDX-License-Identifier: Apache-2.0
// PW-10 consumer contract: the broker's durable job-state outbox (#70) against a front-door-shaped
// consumer that deduplicates on the event id and applies each job's transitions in order. Real
// broker over HTTP on 127.0.0.1, a disposable SQLite file, no daemon.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { API, loadTeams, startBroker } from "../broker/server.ts";
import { openStore } from "../broker/store.ts";
import { frontDoor } from "./fixtures/front-door.ts";

const open = new Set<() => Promise<unknown>>();
afterEach(async () => {
  const closing = [...open];
  open.clear();
  for (const close of closing) await close();
});

const cls = { slots: 2, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 };
const definition = (team: string, secretRef?: string) => ({
  team, trains: 1, perTrain: { orchestrators: 1, workers: { quick: 2 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: team }, defaultClass: "quick", classes: { quick: cls },
  events: { callbackDefault: `\${${team.toUpperCase().replace(/-/g, "_")}_CALLBACK}`, approvalConsumer: "frontdoor", ...(secretRef ? { auth: { secretRef } } : {}) },
});
const jobId = (team: string, card: string) => `kb-${team}-${card}-a1`;

/** Team specs under a temp dir, and one broker file shared across restarts. */
function world(defs: ReturnType<typeof definition>[]) {
  const dir = mkdtempSync(join(tmpdir(), "pw-fd-teams-"));
  const platform = { ...PHASE_0_1, slotCaps: Object.fromEntries(defs.map((d) => [d.team, 2])) };
  for (const d of defs) assert.ok("files" in emitTeam(d, dir, platform));
  const db = join(mkdtempSync(join(tmpdir(), "pw-fd-db-")), "broker.sqlite");
  /** One broker process: the real HTTP server, its outbox and its 1 s replay pump. */
  const boot = async (env: Record<string, string>) => {
    const store = openStore(db);
    let broker: Awaited<ReturnType<typeof startBroker>>;
    try {
      broker = await startBroker({ store, teams: loadTeams(dir, platform), env, host: "127.0.0.1", port: 0, log: () => {} });
    } catch (e) {
      store.close(); // a refused start (for example a missing credential) must not leak the file handle
      throw e;
    }
    const stop = async () => { await broker.close(); store.close(); };
    open.add(stop);
    const submit = (team: string, card: string) => fetch(`${broker.url}${API}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: jobId(team, card), team, task: { prompt: `do ${card}` } }) });
    /** The worker side of a lifecycle, straight on the store; the outbox delivers from the history. */
    const run = (id: string, team: string, seat: string, end: "done" | "failed") => {
      store.reserve(team, "quick", seat, `q-${seat}`);
      assert.notEqual(store.confirmClaim(id, seat, `q-${seat}`), "lost");
      store.transition(id, "running");
      if (end === "done") store.transition(id, "done", { outcome: "succeeded" }, { result: JSON.stringify({ text: "ok", artifacts: [] }) });
      else store.transition(id, "failed", { reason: "error", message: "model error" });
    };
    return { store, submit, run, stop: async () => { open.delete(stop); await stop(); } };
  };
  return { boot };
}

async function until(what: string, ok: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a front door applies each job's lifecycle in order from the events alone, with the bearer from events.auth.secretRef", async () => {
  const fd = await frontDoor({ token: "fd-token" });
  open.add(fd.close);
  const w = world([definition("social-media", "FRONTDOOR")]);
  const b = await w.boot({ SOCIAL_MEDIA_CALLBACK: fd.url, PLANTWORKS_CALLBACK_TOKEN_FRONTDOOR: "fd-token" });
  const [one, two] = [jobId("social-media", "t_one"), jobId("social-media", "t_two")];
  assert.equal((await b.submit("social-media", "t_one")).status, 201);
  assert.equal((await b.submit("social-media", "t_two")).status, 201);
  b.run(one, "social-media", "seat-a", "done");
  b.run(two, "social-media", "seat-b", "failed");
  await until("both lifecycles", () => fd.applied.length === 8);

  assert.deepEqual(fd.timeline(one), ["queued", "claimed", "running", "done"]);
  assert.deepEqual(fd.timeline(two), ["queued", "claimed", "running", "failed"]);
  assert.deepEqual(fd.rejected, [], "every delivery carried the configured bearer and was well formed");
  // What a card mapping needs is on the event itself: the state and that state's detail.
  assert.deepEqual(fd.applied.find((a) => a.jobId === one && a.state === "done")!.detail, { outcome: "succeeded" });
  assert.deepEqual(fd.applied.find((a) => a.jobId === two && a.state === "failed")!.detail, { reason: "error", message: "model error" });
  // Ids are <jobId>:<transition row id>: increasing per job, and not dense per job (the jobs interleave).
  const seqs = fd.applied.filter((a) => a.jobId === one).map((a) => a.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!));
  assert.ok(seqs.some((s, i) => i > 0 && s - seqs[i - 1]! > 1), `gaps are normal: ${seqs}`);
  const history = b.store.transitions({ jobId: one }).map((t) => `${one}:${t.id}`);
  assert.deepEqual(fd.received.filter((e) => e.subject === one).map((e) => e.id), history, "one event per persisted transition, same ids");
});

test("a consumer that is down for a while (503) loses nothing and applies nothing twice", async () => {
  const fd = await frontDoor({ fail: (n) => (n <= 3 ? 503 : undefined) });
  open.add(fd.close);
  const w = world([definition("social-media")]);
  const b = await w.boot({ SOCIAL_MEDIA_CALLBACK: fd.url });
  const id = jobId("social-media", "t_down");
  await b.submit("social-media", "t_down");
  b.run(id, "social-media", "seat-a", "done");
  await until("the lifecycle after the outage", () => fd.applied.length === 4);
  assert.deepEqual(fd.timeline(id), ["queued", "claimed", "running", "done"]);
  assert.equal(fd.rejected.filter((r) => r.status === 503).length, 3);
  assert.equal(new Set(fd.applied.map((a) => a.seq)).size, 4);
});

test("lost acknowledgements and a broker restart redeliver the same ids, and the front door applies each transition once", async () => {
  // Every first delivery of the claimed and done events is handled but its ack is lost.
  const handled = new Map<string, number>();
  const fd = await frontDoor({ dropAck: (_n, e) => ["claimed", "done"].includes(e.data.state) && (handled.set(e.id, (handled.get(e.id) ?? 0) + 1), handled.get(e.id) === 1) });
  open.add(fd.close);
  const w = world([definition("social-media")]);
  const env = { SOCIAL_MEDIA_CALLBACK: fd.url };
  let b = await w.boot(env);
  const id = jobId("social-media", "t_ack");
  await b.submit("social-media", "t_ack");
  b.run(id, "social-media", "seat-a", "done");
  await until("redelivery of the lost acks", () => fd.received.length === 6 && fd.applied.length === 4);
  const ids = fd.received.map((e) => e.id);
  assert.equal(new Set(ids).size, 4, `4 distinct ids, 2 of them delivered twice: ${ids}`);

  // Restart on the same file: the cursor is durable, so nothing already acknowledged comes again.
  await b.stop();
  b = await w.boot(env);
  await b.submit("social-media", "t_after");
  await until("the next job's first event", () => fd.applied.length === 5);
  assert.equal(fd.received.filter((e) => e.subject === id).length, 6, "no replay of acknowledged events after the restart");
  assert.deepEqual(fd.timeline(id), ["queued", "claimed", "running", "done"]);
});

// Note: broker.close() does not stop a delivery cycle already retrying (outbox.ts); the stopped
// broker's cycle backs off until its attempts run out (about a minute), which keeps this file's
// process alive that long after the tests pass. Reported to the outbox owner; not changed here.
test("a restart while the consumer is down replays the pending events with their original ids", async () => {
  let down = true;
  const fd = await frontDoor({ fail: () => (down ? 503 : undefined) });
  open.add(fd.close);
  const w = world([definition("social-media")]);
  const env = { SOCIAL_MEDIA_CALLBACK: fd.url };
  let b = await w.boot(env);
  const id = jobId("social-media", "t_replay");
  await b.submit("social-media", "t_replay");
  b.run(id, "social-media", "seat-a", "done");
  await until("a refused first delivery", () => fd.rejected.length >= 1);
  const firstId = fd.received[0].id;
  await b.stop();
  down = false;
  b = await w.boot(env);
  await until("the replayed lifecycle", () => fd.applied.length === 4);
  assert.equal(fd.applied[0]!.jobId, id);
  assert.equal(`${id}:${fd.applied[0]!.seq}`, firstId, "the replay keeps the id it was first sent with");
  assert.deepEqual(fd.timeline(id), ["queued", "claimed", "running", "done"]);
});

test("isolation and auth: a team whose callback refuses the bearer (401) parks and moves on, and never holds up another team", async () => {
  const strict = await frontDoor({ token: "right" });
  const healthy = await frontDoor();
  open.add(strict.close);
  open.add(healthy.close);
  const w = world([definition("support", "SUPPORT"), definition("social-media")]);
  const b = await w.boot({ SUPPORT_CALLBACK: strict.url, PLANTWORKS_CALLBACK_TOKEN_SUPPORT: "wrong", SOCIAL_MEDIA_CALLBACK: healthy.url });
  await b.submit("support", "t_s1");
  await b.submit("social-media", "t_m1");
  b.run(jobId("support", "t_s1"), "support", "seat-s", "done");
  b.run(jobId("social-media", "t_m1"), "social-media", "seat-m", "done");
  await until("the healthy team's lifecycle", () => healthy.applied.length === 4);
  // The outbox classes a 401 as permanent (only 408, 429 and 5xx are retried): each event is parked once.
  await until("every support event refused", () => strict.rejected.length === 4);
  assert.ok(strict.rejected.every((r) => r.status === 401));
  assert.equal(strict.applied.length, 0, "nothing reaches the front door without the right credential");
  const parked = b.store.db.prepare("SELECT COUNT(*) AS n FROM event_outbox_failures WHERE team = 'support' AND parked = 1").get() as { n: number };
  assert.equal(parked.n, 4);
});

test("an events.auth reference with no operator credential stops the broker before it sends anything", async () => {
  const fd = await frontDoor();
  open.add(fd.close);
  const w = world([definition("social-media", "FRONTDOOR")]);
  await assert.rejects(w.boot({ SOCIAL_MEDIA_CALLBACK: fd.url }), /configured callback credential is unavailable/);
  assert.equal(fd.received.length + fd.rejected.length, 0, "no unauthenticated delivery");
});
