// SPDX-License-Identifier: Apache-2.0
// PW-18: queue classes and claim-next with late binding. A submitted job lives only in the broker.
// The upstream queue item is created, addressed to the claiming seat and claimed for it only when
// that seat asks for work, so a job is never bound to a seat that isn't ready for it.
//
// One claim, in order:
// 1. reserve: the oldest queued job of (team, class), held for this seat under a lease, with a
//    qitem id chosen up front. The job stays `queued` and nothing is emitted.
// 2. If the reservation took over an expired lease, close the old holder's qitem (a crash orphan).
// 3. Create the qitem with that id (a retried create with the same id is idempotent upstream),
//    then claim it for the seat.
// 4. confirmClaim: queued -> claimed, only if this seat still holds the reservation with this
//    qitem. Lost (taken over, cancelled meanwhile): close our qitem; nothing was published.
import { randomBytes } from "node:crypto";
import { API, jobRecord, type BrokerRoutes } from "./server.ts";
import { RESERVATION_LEASE_MS } from "./store.ts";
import type { JobEnvelope } from "../contract/job.ts";

/** A seat session as OpenRig names it, for example `dev-worker@team`. */
export const SEAT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

/** The three daemon queue calls claim-next makes. */
export interface DaemonQueue {
  create(item: { qitemId: string; source: string; destination: string; body: string; summary: string; tags: string[] }): Promise<void>;
  claim(qitemId: string, seat: string): Promise<void>;
  close(qitemId: string, actor: string, note: string): Promise<void>;
}

/**
 * The upstream daemon's queue API (/api/queue). The broker acts for seats, so it names them in the
 * request body, which the daemon records as a claimed identity (`claimed:v1`); it never sends
 * X-OpenRig-Session, which would assert a seat's transport identity.
 */
export function daemonQueue(opts: { url: string; token?: string; fetch?: typeof fetch; timeoutMs?: number }): DaemonQueue {
  const f = opts.fetch ?? fetch;
  const call = async (path: string, body: unknown) => {
    const res = await f(`${opts.url.replace(/\/+$/, "")}/api/queue${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`daemon ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
  return {
    create: (i) => call("/create", { qitemId: i.qitemId, sourceSession: i.source, destinationSession: i.destination, body: i.body, summary: i.summary, tags: i.tags }),
    claim: (qitemId, seat) => call(`/${encodeURIComponent(qitemId)}/claim`, { destinationSession: seat }),
    close: (qitemId, actor, note) => call(`/${encodeURIComponent(qitemId)}/update`, { actorSession: actor, state: "done", closureReason: "canceled", transitionNote: note }),
  };
}

/** The daemon's own qitem id format. */
export function newQitemId(now = new Date()): string {
  return `qitem-${now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;
}

export interface ClaimNextOptions {
  daemon: DaemonQueue;
  /** The session the broker creates qitems as (PLANTWORKS_BROKER_SESSION). */
  brokerSession: string;
  leaseMs?: number;
  newQitemId?: () => string;
  log?: (line: string) => void;
}

/** POST /plantworks/v1/claim-next {team, class?, seat}: 200 with the claimed job, or 204 when nothing is claimable. */
export function claimNextRoutes(opts: ClaimNextOptions): BrokerRoutes {
  const log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const mint = opts.newQitemId ?? (() => newQitemId());
  // Closing is cleanup: a failure is logged and never fails the claim it runs inside.
  const closeQuietly = async (qitemId: string, note: string) => {
    try { await opts.daemon.close(qitemId, opts.brokerSession, note); } catch (e) { log(`plantworks broker: could not close ${qitemId}: ${(e as Error).message}`); }
  };

  return (app, { store, teams, emit }) => {
    app.post(`${API}/claim-next`, async (c) => {
      const body = await c.req.json().catch(() => null) as { team?: unknown; class?: unknown; seat?: unknown } | null;
      if (!body || typeof body.team !== "string" || typeof body.seat !== "string" || !SEAT.test(body.seat) || (body.class !== undefined && typeof body.class !== "string")) {
        return c.json({ error: "invalid_claim", message: "send {team, seat, class?}; seat is an OpenRig session name" }, 400);
      }
      const spec = teams.get(body.team);
      if (!spec) return c.json({ error: "unknown_team", message: `no team spec for ${body.team}` }, 400);
      const cls = body.class ?? spec.defaultClass;
      if (!spec.classes[cls]) return c.json({ error: "unknown_class", message: `team ${body.team} has no class ${cls}` }, 400);
      const seat = body.seat;

      const qitemId = mint();
      const reserved = store.reserve(body.team, cls, seat, qitemId, opts.leaseMs ?? RESERVATION_LEASE_MS);
      if (!reserved) return c.body(null, 204);
      const { job } = reserved;
      if (reserved.previousQitemId) await closeQuietly(reserved.previousQitemId, `plantworks: the reservation on ${job.job_id} expired and passed to ${seat}`);

      const envelope = JSON.parse(job.envelope) as JobEnvelope;
      try {
        await opts.daemon.create({
          qitemId,
          source: opts.brokerSession,
          destination: seat,
          body: `Plantworks job ${job.job_id} (team ${job.team}, class ${cls})\n\n${envelope.task.prompt}`,
          summary: envelope.task.title ?? `Plantworks job ${job.job_id}`,
          tags: ["plantworks", `plantworks-job:${job.job_id}`, `plantworks-team:${job.team}`, `plantworks-class:${cls}`],
        });
        await opts.daemon.claim(qitemId, seat);
      } catch (e) {
        store.release(job.job_id, seat, qitemId);
        await closeQuietly(qitemId, `plantworks: claim of ${job.job_id} failed`);
        return c.json({ error: "daemon_unavailable", message: `could not hand ${job.job_id} to ${seat}: ${(e as Error).message}` }, 503);
      }

      const confirmed = store.confirmClaim(job.job_id, seat, qitemId);
      if (confirmed === "lost") {
        await closeQuietly(qitemId, `plantworks: ${seat} lost the reservation on ${job.job_id}`);
        return c.json({ error: "reservation_lost", message: `${job.job_id} was taken over or cancelled while it was being handed to ${seat}; ask again` }, 409);
      }
      emit(confirmed.row, "claimed", confirmed.detail);
      return c.json({ job: jobRecord(confirmed.row), qitemId, seat, envelope });
    });
  };
}
