// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { DeliveryError, createEmitter, jobStateEvent } from "./job-state.ts";

const job = { jobId: "kb-board1-card9-a2", team: "social-media" };
const noSleep = async () => {};

type Reply = number | { status: number; headers?: Record<string, string> } | "hang";

/** Local stub consumer: answers each request with the next reply in `replies`, then 204. */
async function stub(replies: Reply[] = []) {
  const received: { url: string; headers: IncomingMessage["headers"]; body: any }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      received.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) });
      const reply = replies.shift() ?? 204;
      if (reply === "hang") return;
      const { status, headers } = typeof reply === "number" ? { status: reply, headers: {} } : reply;
      res.writeHead(status, headers).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
  return { url, received, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test("uses the persisted transition id so a repeated state cannot reuse its CloudEvent id", () => {
  const e = jobStateEvent({ ...job, transitionSeq: 17, qitemId: "qitem-1", seat: "dev-a@team", summary: "work" }, "done", { outcome: "succeeded", closure: "handoff-sre" }, new Date("2026-10-24T00:00:00Z"));
  assert.deepEqual(e, {
    specversion: "1.0",
    type: "plantworks.job.state",
    source: "/plantworks/teams/social-media",
    id: "kb-board1-card9-a2:17",
    subject: "kb-board1-card9-a2",
    time: "2026-10-24T00:00:00.000Z",
    datacontenttype: "application/json",
    data: { jobId: "kb-board1-card9-a2", team: "social-media", attempt: 2, state: "done", qitemId: "qitem-1", seat: "dev-a@team", summary: "work", outcome: "succeeded", closure: "handoff-sre" },
  });
  assert.deepEqual(
    [jobStateEvent({ ...job, transitionSeq: 17 }, "running").id, jobStateEvent({ ...job, transitionSeq: 21 }, "running").id],
    [`${job.jobId}:17`, `${job.jobId}:21`],
  );
  assert.throws(() => jobStateEvent({ jobId: "nope", team: "t" }, "queued"), /invalid jobId/);
});

test("posts events in order as application/cloudevents+json", async () => {
  const s = await stub();
  const emitter = createEmitter({ url: s.url, sleep: noSleep });
  await Promise.all(["queued", "claimed", "running"].map((st) => emitter.emit(jobStateEvent(job, st as any))));
  assert.deepEqual(s.received.map((r) => r.body.data.state), ["queued", "claimed", "running"]);
  assert.equal(s.received[0]!.headers["content-type"], "application/cloudevents+json");
  await s.close();
});

test("retries 5xx, 429 and 408 with capped backoff until delivered", async () => {
  const s = await stub([503, 429, 500, 408]);
  const delays: number[] = [];
  const emitter = createEmitter({ url: s.url, baseDelayMs: 100, maxDelayMs: 300, sleep: async (ms) => { delays.push(ms); } });
  await emitter.emit(jobStateEvent(job, "running"));
  assert.equal(s.received.length, 5);
  assert.deepEqual(delays, [100, 200, 300, 300]);
  await s.close();
});

test("a permanent 4xx is not retried, and later events still go out", async () => {
  const s = await stub([400]);
  const errors: DeliveryError[] = [];
  const emitter = createEmitter({ url: s.url, sleep: noSleep, onDeliveryError: (e) => errors.push(e) });
  const first = emitter.emit(jobStateEvent(job, "queued"));
  const second = emitter.emit(jobStateEvent(job, "claimed"));
  await assert.rejects(first, (e: unknown) => e instanceof DeliveryError && e.attempts === 1 && /HTTP 400, not retried/.test(e.message));
  await second;
  assert.deepEqual(s.received.map((r) => r.body.data.state), ["queued", "claimed"]);
  assert.deepEqual(errors.map((e) => e.event.id), ["kb-board1-card9-a2:queued"]);
  await s.close();
});

test("gives up after maxAttempts when the consumer is unreachable", async () => {
  const s = await stub();
  await s.close();
  const emitter = createEmitter({ url: s.url, maxAttempts: 3, sleep: noSleep, onDeliveryError: () => {} });
  await assert.rejects(emitter.emit(jobStateEvent(job, "failed", { reason: "error" })), (e: unknown) => e instanceof DeliveryError && e.attempts === 3);
});

test("honours Retry-After, capped at maxDelayMs", async () => {
  const s = await stub([{ status: 429, headers: { "retry-after": "2" } }, { status: 503, headers: { "retry-after": "120" } }]);
  const delays: number[] = [];
  const emitter = createEmitter({ url: s.url, maxDelayMs: 30_000, sleep: async (ms) => { delays.push(ms); } });
  await emitter.emit(jobStateEvent(job, "running"));
  assert.deepEqual(delays, [2000, 30_000]);
  await s.close();
});

test("a redirect is a permanent failure and is not followed", async () => {
  const target = await stub();
  const s = await stub([{ status: 307, headers: { location: target.url } }]);
  const emitter = createEmitter({ url: s.url, sleep: noSleep, onDeliveryError: () => {} });
  await assert.rejects(emitter.emit(jobStateEvent(job, "queued")), /HTTP 307, not retried/);
  assert.equal(target.received.length, 0);
  await Promise.all([s.close(), target.close()]);
});

test("a hung consumer times out and counts as a retryable attempt", async () => {
  const s = await stub(["hang", "hang"]);
  const emitter = createEmitter({ url: s.url, maxAttempts: 2, requestTimeoutMs: 100, sleep: noSleep, onDeliveryError: () => {} });
  await assert.rejects(emitter.emit(jobStateEvent(job, "queued")), (e: unknown) => e instanceof DeliveryError && e.attempts === 2);
  assert.equal(s.received.length, 2);
  await s.close();
});

test("failures reach onDeliveryError even when emit() is not awaited", async () => {
  const s = await stub([404]);
  const errors: string[] = [];
  const emitter = createEmitter({ url: s.url, sleep: noSleep, onDeliveryError: (e) => errors.push(e.event.id) });
  emitter.emit(jobStateEvent(job, "queued")).catch(() => {});
  await emitter.emit(jobStateEvent(job, "claimed"));
  assert.deepEqual(errors, ["kb-board1-card9-a2:queued"]);
  await s.close();
});

test("a throwing onDeliveryError does not stall later events", async () => {
  const s = await stub([400]);
  const emitter = createEmitter({ url: s.url, sleep: noSleep, onDeliveryError: () => { throw new Error("hook"); } });
  emitter.emit(jobStateEvent(job, "queued")).catch(() => {});
  await emitter.emit(jobStateEvent(job, "claimed"));
  assert.equal(s.received.length, 2);
  await s.close();
});

test("refuses a non-http callback url", () => {
  assert.throws(() => createEmitter({ url: "file:///etc/passwd" }), /http\(s\)/);
});
