// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../broker/store.ts";
import { createJobStateOutbox } from "./outbox.ts";

test("replays the first unacknowledged transition after broker restart with a stable event id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plantworks-outbox-"));
  const path = join(dir, "broker.sqlite");
  const envelope = { jobId: "kb-board1-card9-a1", team: "social-media", task: { prompt: "write" } };
  const store = openStore(path);
  try {
    store.insert({ ...envelope, task: { prompt: "🧪".repeat(1000) } }, "quick", "queued");
    store.reserve(envelope.team, "quick", "seat-a", "qitem-1");
    store.confirmClaim(envelope.jobId, "seat-a", "qitem-1");
    store.transition(envelope.jobId, "running");
    store.transition(envelope.jobId, "done", { outcome: "succeeded" });

    const firstAttempt: { state: string; id: string; event: import("./job-state.ts").CloudEvent }[] = [];
    const first = createJobStateOutbox(store, async (_team, event) => {
      firstAttempt.push({ state: event.data.state as string, id: event.id, event });
      if (event.data.state === "running") throw new Error("connection lost after request");
    }, () => {});
    await first.pump();
    assert.deepEqual(firstAttempt.map((event) => event.state), ["queued", "claimed", "running"]);
    assert.equal(firstAttempt[0]!.id, `${envelope.jobId}:1`);
    assert.equal(firstAttempt[1]!.id, `${envelope.jobId}:2`);
    assert.equal(firstAttempt[2]!.id, `${envelope.jobId}:3`);
    assert.equal(firstAttempt[0]!.event.data.qitemId, undefined, "a queued event predates its reservation");
    assert.equal(firstAttempt[1]!.event.data.qitemId, "qitem-1");
    assert.equal(firstAttempt[1]!.event.data.seat, "seat-a");
    assert.ok(Buffer.byteLength(firstAttempt[0]!.event.data.summary as string) <= 2048);
  } finally {
    store.db.close();
  }

  const restarted = openStore(path);
  try {
    const replayed: { state: unknown; id: string }[] = [];
    const outbox = createJobStateOutbox(restarted, async (_team, event) => {
      replayed.push({ state: event.data.state, id: event.id });
    }, () => {});
    await outbox.pump();
    assert.deepEqual(replayed.map((event) => event.state), ["running", "done"]);
    assert.equal(replayed[0]!.id, "kb-board1-card9-a1:3");
  } finally {
    restarted.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
