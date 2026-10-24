// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { DeliveryError, createEmitter, jobStateEvent } from "./job-state.ts";

const job = { jobId: "kb-board1-card9-a2", team: "social-media" };
const noSleep = async () => {};

/** Local stub consumer: answers each request with the next status in `statuses`, then 204. */
async function stub(statuses: number[] = []) {
  const received: { headers: IncomingMessage["headers"]; body: any }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(statuses.shift() ?? 204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
  return { url, received, close: () => new Promise((r) => server.close(r)) };
}

test("builds a CloudEvents job.state event deduplicated on jobId + state", () => {
  const e = jobStateEvent(job, "done", { outcome: "succeeded", closure: "handoff-sre" }, new Date("2026-10-24T00:00:00Z"));
  assert.deepEqual(e, {
    specversion: "1.0",
    type: "plantworks.job.state",
    source: "/plantworks/teams/social-media",
    id: "kb-board1-card9-a2:done",
    subject: "kb-board1-card9-a2",
    time: "2026-10-24T00:00:00.000Z",
    datacontenttype: "application/json",
    data: { jobId: "kb-board1-card9-a2", team: "social-media", attempt: 2, state: "done", outcome: "succeeded", closure: "handoff-sre" },
  });
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

test("retries 5xx and 429 with capped backoff until delivered", async () => {
  const s = await stub([503, 429, 500]);
  const delays: number[] = [];
  const emitter = createEmitter({ url: s.url, baseDelayMs: 100, maxDelayMs: 300, sleep: async (ms) => { delays.push(ms); } });
  await emitter.emit(jobStateEvent(job, "running"));
  assert.equal(s.received.length, 4);
  assert.deepEqual(delays, [100, 200, 300]);
  await s.close();
});

test("a permanent 4xx is not retried, and later events still go out", async () => {
  const s = await stub([400]);
  const emitter = createEmitter({ url: s.url, sleep: noSleep });
  const first = emitter.emit(jobStateEvent(job, "queued"));
  const second = emitter.emit(jobStateEvent(job, "claimed"));
  await assert.rejects(first, (e: unknown) => e instanceof DeliveryError && e.attempts === 1 && /HTTP 400, not retried/.test(e.message));
  await second;
  assert.deepEqual(s.received.map((r) => r.body.data.state), ["queued", "claimed"]);
  await s.close();
});

test("gives up after maxAttempts when the consumer is unreachable", async () => {
  const s = await stub();
  await s.close();
  const emitter = createEmitter({ url: s.url, maxAttempts: 3, sleep: noSleep });
  await assert.rejects(emitter.emit(jobStateEvent(job, "failed", { reason: "error" })), (e: unknown) => e instanceof DeliveryError && e.attempts === 3);
});

test("refuses a non-http callback url", () => {
  assert.throws(() => createEmitter({ url: "file:///etc/passwd" }), /http\(s\)/);
});
