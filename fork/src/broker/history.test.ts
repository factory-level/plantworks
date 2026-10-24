// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";

const id = (n: number) => `kb-social-media-t_${n}-a1`;
const job = (n: number) => ({ jobId: id(n), team: "social-media", task: { prompt: `job ${n}` } }) as any;
const shape = (rows: ReturnType<ReturnType<typeof openStore>["transitions"]>) =>
  rows.map((r) => [r.job_id, r.from_state, r.to_state, JSON.parse(r.detail), JSON.parse(r.columns)]);

test("history: every state a job enters is persisted with its detail and columns, survives a restart, and pages by id", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pw-history-")), "broker.sqlite");
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const now = () => new Date((clock += 1000));
  let store = openStore(file, now);

  store.insert(job(1), "quick", "queued");
  assert.equal(store.insert(job(1), "quick", "queued").created, false);
  store.reserve("social-media", "quick", "seat-a", "q-1");
  const claimed = store.confirmClaim(id(1), "seat-a", "q-1");
  assert.notEqual(claimed, "lost");
  store.transition(id(1), "running");
  store.transition(id(1), "done", { outcome: "succeeded" }, { result: '{"text":"ok"}' });
  store.insert(job(2), "review", "held", 60);
  store.transition(id(2), "cancelled", { reason: "denied" }, { approval_decision: "denied" });

  // An illegal transition throws and records nothing; so does a reservation and its release.
  assert.throws(() => store.transition(id(1), "running"));
  store.insert(job(3), "quick", "queued");
  store.reserve("social-media", "quick", "seat-b", "q-3");
  store.release(id(3), "seat-b", "q-3");
  store.close();

  store = openStore(file, now);
  const all = store.transitions();
  assert.deepEqual(shape(all), [
    [id(1), null, "queued", {}, {}],
    [id(1), "queued", "claimed", {}, { claimed_by: "seat-a", claimed_at: "2026-10-24T12:00:04.000Z", qitem_id: "q-1" }],
    [id(1), "claimed", "running", {}, {}],
    [id(1), "running", "done", { outcome: "succeeded" }, { result: '{"text":"ok"}' }],
    [id(2), null, "held", {}, {}],
    [id(2), "held", "cancelled", { reason: "denied" }, { approval_decision: "denied" }],
    [id(3), null, "queued", {}, {}],
  ]);
  assert.ok(all.every((r, i) => i === 0 || r.id > all[i - 1]!.id), "ids are monotonic");
  assert.equal(all[3]!.at, store.get(id(1))!.updated_at, "written with the state change itself");
  assert.deepEqual(shape(store.transitions({ jobId: id(2) })), shape(all.slice(4, 6)));
  assert.deepEqual(store.transitions({ afterId: all[2]!.id, limit: 2 }).map((r) => r.id), [all[3]!.id, all[4]!.id]);
  store.close();
});

test("history: a transition that fails inside its transaction leaves no history row", () => {
  const store = openStore(":memory:");
  store.insert(job(1), "quick", "queued");
  store.reserve("social-media", "quick", "seat-a", "q-1");
  assert.throws(() => store.transition(id(1), "cancelled", { reason: "front-door" }), /reserved/);
  assert.deepEqual(store.transitions().map((r) => r.to_state), ["queued"]);
});
