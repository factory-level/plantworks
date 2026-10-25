// SPDX-License-Identifier: Apache-2.0
// PW-34 contract tests, the wake pause (fork/docs/design/sre-handoff.md §3 item 6). An in-process broker on
// :memory: with a fake daemon queue and an injected clock; nothing reaches a daemon or an SRE agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { claimNextRoutes, type DaemonQueue } from "./claim.ts";
import { runtimeRoutes } from "./runtime.ts";
import { API, loadTeams, startBroker } from "./server.ts";
import { parseSlotCaps } from "./slots.ts";
import { openStore, type Store } from "./store.ts";
import { createWakePause, WAKE_PAUSE_MS } from "./wake.ts";

const platform = { ...PHASE_0_1, slotCaps: { t: 2 } };
const definition = {
  team: "t", trains: 1, perTrain: { orchestrators: 1, workers: { long: 2 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "t" }, defaultClass: "long",
  classes: { long: { slots: 2, model: "qwen3.5:9b", context: { maxContextTokens: 8192, thinkingTokens: 0 }, perCall: { maxOutputTokens: 700, deadlineSeconds: 5 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
};

async function broker(t: { after: (fn: () => unknown) => void }, store?: Store) {
  const dir = mkdtempSync(join(tmpdir(), "pw34-wake-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok("files" in emitTeam(definition, dir, platform));
  let clock = 1_000_000;
  const logs: string[] = [];
  const dispatch = createWakePause({ now: () => clock, log: (l) => logs.push(l) });
  const db = store ?? openStore(":memory:");
  const handed: string[] = [];
  const daemon: DaemonQueue = { async create() {}, async claim(q) { handed.push(q); }, async inspect() { throw new Error("not used"); } };
  const caps = parseSlotCaps("t=2");
  let n = 0;
  const b = await startBroker({ store: db, teams: loadTeams(dir, platform), host: "127.0.0.1", port: 0, send: () => {}, env: {},
    routes: [claimNextRoutes({ daemon, brokerSession: "plantworks-broker", slotCaps: caps, dispatch, newQitemId: () => `qitem-w-${++n}`, log: () => {} }), runtimeRoutes({ slotCaps: caps, dispatch }), dispatch.routes] });
  t.after(async () => { await b.close(); if (!store) db.close(); });
  const post = (path: string, body: unknown) => fetch(`${b.url}${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const wake = (type: "requested" | "ready", wakeId: string, agent = "platform-sre") => post("/sre/wake", { specversion: "1.0", type: `sre.wake.${type}`, id: `${type}-${wakeId}`, source: "/harness-hg/sre", data: { wakeId, agent } });
  const claim = (seat = "long-01@t") => post("/claim-next", { team: "t", seat });
  const stats = async () => (await (await fetch(`${b.url}${API}/stats`)).json()) as { dispatch: { paused: boolean; wakes: { wakeId: string; agent: string; until: string }[] } };
  const submit = (card: string) => post("/jobs", { jobId: `kb-t-${card}-a1`, team: "t", task: { prompt: card } });
  return { db, url: b.url, wake, claim, stats, submit, post, handed, logs, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test("requested pauses claim-next (204 + Plantworks-Dispatch: paused) with work queued; ready resumes it", async (t) => {
  const b = await broker(t);
  assert.equal((await b.submit("c1")).status, 201);
  assert.equal((await b.wake("requested", "w1")).status, 202);
  const paused = await b.claim();
  assert.equal(paused.status, 204);
  assert.equal(paused.headers.get("plantworks-dispatch"), "paused");
  assert.equal(b.db.get("kb-t-c1-a1")!.state, "queued", "nothing was reserved");
  assert.deepEqual(b.handed, []);
  const s = await b.stats();
  assert.deepEqual(s.dispatch, { paused: true, wakes: [{ wakeId: "w1", agent: "platform-sre", until: new Date(b.now() + WAKE_PAUSE_MS).toISOString() }] });
  assert.equal((await b.wake("ready", "w1")).status, 202);
  const resumed = await b.claim();
  assert.equal(resumed.status, 200);
  assert.equal(resumed.headers.get("plantworks-dispatch"), null);
  assert.deepEqual((await b.stats()).dispatch, { paused: false, wakes: [] });
});

test("the 120 s bound resumes dispatch; a replayed requested never extends it or re-pauses", async (t) => {
  const b = await broker(t);
  await b.submit("c1");
  await b.wake("requested", "w1");
  b.tick(WAKE_PAUSE_MS - 1000);
  assert.equal((await b.wake("requested", "w1")).status, 202, "a replay is accepted");
  assert.equal((await b.stats()).dispatch.wakes[0]!.until, new Date(b.now() + 1000).toISOString(), "and does not extend the pause");
  assert.equal((await b.claim()).status, 204);
  b.tick(1000);
  assert.equal((await b.claim()).status, 200, "resumed at 120 s");
  assert.ok(b.logs.some((l) => /wake w1 \(platform-sre\) reached its 120s bound; dispatch resumes/.test(l)));
  await b.wake("requested", "w1");
  assert.equal((await b.stats()).dispatch.paused, false, "an expired id can't re-pause");
});

test("ready before requested is remembered: the late request does not pause", async (t) => {
  const b = await broker(t);
  await b.submit("c1");
  assert.equal((await b.wake("ready", "w2")).status, 202, "an unknown ready is accepted");
  await b.wake("requested", "w2");
  assert.equal((await b.stats()).dispatch.paused, false);
  assert.equal((await b.claim()).status, 200);
});

test("during a pause: a running job reconciles to done, and submit, cancel and stats work", async (t) => {
  const b = await broker(t);
  await b.submit("run");
  assert.equal((await b.claim()).status, 200);
  b.db.transition("kb-t-run-a1", "running");
  await b.wake("requested", "w3");
  assert.equal(b.db.get("kb-t-run-a1")!.state, "running", "never killed, unclaimed or released");
  b.db.transition("kb-t-run-a1", "done", { outcome: "succeeded" }, { result: JSON.stringify({ text: null, artifacts: [] }) });
  assert.equal(b.db.get("kb-t-run-a1")!.state, "done");
  assert.equal((await b.submit("later")).status, 201, "submit still queues work");
  assert.equal((await b.post("/jobs/kb-t-later-a1/cancel", {})).status, 200, "cancel works");
  assert.equal(b.db.get("kb-t-later-a1")!.state, "cancelled");
  assert.equal((await b.claim()).status, 204);
});

test("malformed wake events are refused; a broker restart clears the pause", async (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const b = await broker(t, store);
  for (const [why, body] of [
    ["not JSON", "{"],
    ["not a CloudEvent", { type: "sre.wake.requested", data: { wakeId: "w" } }],
    ["unknown type", { specversion: "1.0", type: "sre.waking", id: "1", source: "s", data: { wakeId: "w" } }],
    ["no wakeId", { specversion: "1.0", type: "sre.wake.requested", id: "1", source: "s", data: {} }],
    ["bad wakeId", { specversion: "1.0", type: "sre.wake.requested", id: "1", source: "s", data: { wakeId: "has space" } }],
    ["over 4 KiB", { specversion: "1.0", type: "sre.wake.requested", id: "1", source: "s", data: { wakeId: "w", agent: "x".repeat(5000) } }],
  ] as const) {
    const res = await b.post("/sre/wake", body);
    assert.equal(res.status, 400, why);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_wake", why);
  }
  assert.equal((await b.stats()).dispatch.paused, false, "a refused event pauses nothing");
  await b.wake("requested", "w4");
  assert.equal((await b.stats()).dispatch.paused, true);
  const restarted = await broker(t, store); // a new broker process on the same store: pause state is in memory
  await restarted.submit("c9");
  assert.equal((await restarted.claim()).status, 200);
});
