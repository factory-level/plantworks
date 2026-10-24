// SPDX-License-Identifier: Apache-2.0
// A front-door-shaped consumer of plantworks.job.state, for contract tests (PW-10). It does what
// the events README asks of a consumer, and nothing it doesn't:
// - accepts only structured CloudEvents of type plantworks.job.state, with the configured bearer;
// - deduplicates on the event id, <jobId>:<transitionSeq>;
// - applies an event only when its transitionSeq is above the last one it applied for that job,
//   so a replay or a stale redelivery is a no-op, and gaps (seqs are not dense) are expected.
// How the front door turns a state into a card action is not modelled: that mapping belongs to the
// front door and has no reachable source (D11). Each applied event keeps what a mapping would need.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Applied { jobId: string; seq: number; state: string; detail: Record<string, unknown> }

/**
 * `fail(n, event)` answers the n-th delivery (from 1) with that status before handling it.
 * `dropAck(n, event)` handles it, then answers 503 as if the acknowledgement were lost, so the
 * same event is delivered again.
 */
export async function frontDoor(opts: { token?: string; fail?: (n: number, body: any) => number | undefined; dropAck?: (n: number, body: any) => boolean } = {}) {
  const received: any[] = [];
  const seen = new Set<string>();
  const last = new Map<string, number>();
  const applied: Applied[] = [];
  const rejected: { status: number; why: string }[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const refuse = (status: number, why: string) => { rejected.push({ status, why }); res.writeHead(status).end(); };
      if (req.method !== "POST" || req.headers["content-type"] !== "application/cloudevents+json") return refuse(415, "not a structured CloudEvent");
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return refuse(401, "bad or missing bearer");
      const event = JSON.parse(raw);
      received.push(event);
      const failWith = opts.fail?.(++n, event);
      if (failWith) return refuse(failWith, "planned failure");
      const m = /^(.+):([1-9][0-9]*)$/.exec(event.id ?? "");
      if (event.specversion !== "1.0" || event.type !== "plantworks.job.state" || !m || m[1] !== event.subject || event.data?.jobId !== event.subject) return refuse(400, `malformed event ${event.id}`);
      const lostAck = opts.dropAck?.(n, event) ?? false;
      res.writeHead(lostAck ? 503 : 204).end();
      if (seen.has(event.id)) return; // a redelivery: already handled
      seen.add(event.id);
      const seq = Number(m[2]);
      if (seq <= (last.get(event.subject) ?? 0)) return; // older than what this job already shows
      last.set(event.subject, seq);
      const { jobId, state, team: _t, attempt: _a, qitemId: _q, seat: _s, summary: _m, artifacts: _r, evidence: _e, usage: _u, ...detail } = event.data;
      applied.push({ jobId, seq, state, detail });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
    received, applied, rejected,
    /** Per job, the states in the order the front door applied them. */
    timeline: (jobId: string) => applied.filter((a) => a.jobId === jobId).map((a) => a.state),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
