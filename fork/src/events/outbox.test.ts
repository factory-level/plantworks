// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../broker/store.ts";
import { DeliveryError } from "./job-state.ts";
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
    await new Promise((resolve) => setTimeout(resolve, 1100));
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

test("a permanent failure is parked and cannot block another team's cursor", async () => {
  const store = openStore(":memory:");
  try {
    store.insert({ jobId: "kb-a-card1-a1", team: "a", task: { prompt: "a" } }, "quick", "queued");
    store.insert({ jobId: "kb-b-card1-a1", team: "b", task: { prompt: "b" } }, "quick", "queued");
    const attempts = new Map<string, number>();
    const delivered: string[] = [];
    const logs: string[] = [];
    const outbox = createJobStateOutbox(store, async (team, event) => {
      attempts.set(team, (attempts.get(team) ?? 0) + 1);
      if (team === "a") throw new DeliveryError("HTTP 400, not retried", event, 1, true);
      delivered.push(event.id);
    }, (line) => logs.push(line));

    await outbox.pump();
    assert.deepEqual(delivered, ["kb-b-card1-a1:2"]);
    assert.deepEqual(delivered, ["kb-b-card1-a1:2"]);
    assert.equal(attempts.get("a"), 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /event parked after permanent delivery failure: kb-a-card1-a1:1/);
    const parked = store.db.prepare("SELECT attempts, parked FROM event_outbox_failures WHERE team = 'a'").get() as { attempts: number; parked: number };
    assert.deepEqual(parked, { attempts: 1, parked: 1 });
  } finally {
    store.close();
  }
});

test("transient failures stay replayable, back off, and log once until recovery", async () => {
  const store = openStore(":memory:");
  try {
    store.insert({ jobId: "kb-a-card1-a1", team: "a", task: { prompt: "a" } }, "quick", "queued");
    let recovered = false;
    let calls = 0;
    const logs: string[] = [];
    const outbox = createJobStateOutbox(store, async (_team, event) => {
      calls++;
      if (!recovered) throw new DeliveryError("HTTP 503 after 8 attempts", event, 8);
    }, (line) => logs.push(line));

    await outbox.pump();
    const failure = store.db.prepare("SELECT attempts, parked, next_attempt_at, logged FROM event_outbox_failures WHERE team = 'a'").get() as { attempts: number; parked: number; next_attempt_at: number; logged: number };
    assert.equal(failure.attempts, 1);
    assert.equal(failure.parked, 0);
    assert.ok(failure.next_attempt_at > Date.now());
    assert.equal(failure.logged, 1);
    await outbox.pump();
    assert.equal(calls, 1, "the scheduled backoff suppresses an early retry");
    assert.equal(logs.length, 1);

    recovered = true;
    store.db.prepare("UPDATE event_outbox_failures SET next_attempt_at = 0 WHERE team = 'a'").run();
    await outbox.pump();
    assert.equal(calls, 2);
    assert.equal(store.db.prepare("SELECT 1 FROM event_outbox_failures WHERE team = 'a'").get(), undefined);
    assert.equal((store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = 'a'").get() as { delivered_through: number }).delivered_through, 1);
  } finally {
    store.close();
  }
});

test("a slow team does not delay another team's delivery", async () => {
  const store = openStore(":memory:");
  try {
    store.insert({ jobId: "kb-a-card1-a1", team: "a", task: { prompt: "a" } }, "quick", "queued");
    store.insert({ jobId: "kb-b-card1-a1", team: "b", task: { prompt: "b" } }, "quick", "queued");
    let releaseA!: () => void;
    let markB!: () => void;
    const bStarted = new Promise<void>((resolve) => { markB = resolve; });
    const outbox = createJobStateOutbox(store, async (team, event) => {
      if (team === "a") {
        await new Promise<void>((resolve) => { releaseA = resolve; });
        throw new DeliveryError("HTTP 503 after 8 attempts", event, 8);
      }
      markB();
    }, () => {});

    const pumping = outbox.pump();
    await bStarted;
    assert.equal((store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = 'b'").get() as { delivered_through: number }).delivered_through, 2);
    releaseA();
    await pumping;
  } finally {
    store.close();
  }
});

test("a newly active team starts draining while another team's pump is still running", async () => {
  const store = openStore(":memory:");
  try {
    store.insert({ jobId: "kb-a-card1-a1", team: "a", task: { prompt: "a" } }, "quick", "queued");
    let releaseA!: () => void;
    let markAStarted!: () => void;
    let markBDelivered!: () => void;
    const aStarted = new Promise<void>((resolve) => { markAStarted = resolve; });
    const bDelivered = new Promise<void>((resolve) => { markBDelivered = resolve; });
    const outbox = createJobStateOutbox(store, async (team, event) => {
      if (team === "a") {
        markAStarted();
        await new Promise<void>((resolve) => { releaseA = resolve; });
        throw new DeliveryError("HTTP 503 after 8 attempts", event, 8);
      }
      markBDelivered();
    }, () => {});

    const slowPump = outbox.pump();
    await aStarted;
    store.insert({ jobId: "kb-b-card1-a1", team: "b", task: { prompt: "b" } }, "quick", "queued");
    const newTeamPump = outbox.pump();
    await bDelivered;
    assert.equal((store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = 'b'").get() as { delivered_through: number }).delivered_through, 2);
    releaseA();
    await Promise.all([slowPump, newTeamPump]);
  } finally {
    store.close();
  }
});
