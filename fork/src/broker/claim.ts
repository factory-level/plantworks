// SPDX-License-Identifier: Apache-2.0
// PW-18: queue classes and claim-next with late binding. A submitted job lives only in the broker.
// The upstream queue item is created, addressed to the claiming seat and claimed for it only when
// that seat asks for work, so a job is never bound to a seat that isn't ready for it.
//
// One claim, in order:
// 1. reserve: the oldest unreserved queued job of (team, class), held for this seat, with a qitem
//    id chosen up front. The job stays `queued` and nothing is emitted.
// 2. Create the qitem with that id, then claim it for the seat. The daemon delivers (wakes the
//    seat) when it creates the qitem, so from that point Pi may be working.
// 3. confirmClaim: queued -> claimed, only if this seat still holds the reservation with this qitem.
//
// Fail-closed (PW-19): a reservation is released only on evidence that no qitem was delivered,
// namely the daemon refusing the create outright. Any other failure (a timeout, a 5xx, a failed
// claim after the create, a crash) leaves the reservation in place. It stays counted against the
// slot cap and the job can't be claimed again until reconciliation (PW-21) settles it from
// verified evidence. Nothing here closes a qitem as if that stopped Pi.
import { randomBytes } from "node:crypto";
import { API, jobRecord, type BrokerRoutes } from "./server.ts";
import { capFor, inFlight, parseSlotCaps, type SlotCaps } from "./slots.ts";
import { RESERVATION_LEASE_MS, type JobRow, type Store } from "./store.ts";
import type { JobEnvelope } from "../contract/job.ts";

/** A seat session as OpenRig names it, for example `dev-worker@team`. */
export const SEAT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export interface QueueObservation {
  qitemId: string;
  state: string;
  destinationSession: string;
  closureReason?: string | null;
  closureTarget?: string | null;
  closingTransition?: { state: string; closureReason: string | null; closureTarget: string | null; actorSession: string; transitionId: number };
  transitions: { transitionId: number; state: string; closureReason: string | null; closureTarget: string | null; actorSession: string; identityProvenance: string | null }[];
}

/** The daemon answered and refused the request: for `create`, proof that no qitem was persisted. */
export class DaemonRefused extends Error {}

/** The daemon answered 404 for a qitem id: it has no qitem with that id. */
export class QitemNotFound extends Error {}

/** The two daemon queue calls claim-next makes. */
export interface DaemonQueue {
  create(item: { qitemId: string; source: string; destination: string; body: string; summary: string; tags: string[] }): Promise<void>;
  claim(qitemId: string, seat: string): Promise<void>;
  inspect(qitemId: string): Promise<QueueObservation>;
}

/**
 * The upstream daemon's queue API (/api/queue). The broker acts for seats, so it names them in the
 * request body, which the daemon records as a claimed identity (`claimed:v1`); it never sends
 * X-OpenRig-Session, which would assert a seat's transport identity.
 *
 * A 4xx answer throws DaemonRefused, except 409, which means a qitem with that id exists.
 * Everything else (409, 5xx, a timeout, a dropped connection) throws a plain Error: the outcome
 * is unknown.
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
    if (res.ok) return;
    const message = `daemon ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 409 ? new DaemonRefused(message) : new Error(message);
  };
  /** `item`: this is the qitem itself, so a 404 means the daemon has no such qitem. */
  const read = async (path: string, item = false) => {
    const res = await f(`${opts.url.replace(/\/+$/, "")}/api/queue${path}`, { headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) {
      const message = `daemon ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`;
      throw item && res.status === 404 ? new QitemNotFound(message) : new Error(message);
    }
    return res.json();
  };
  return {
    create: (i) => call("/create", { qitemId: i.qitemId, sourceSession: i.source, destinationSession: i.destination, body: i.body, summary: i.summary, tags: i.tags }),
    claim: (qitemId, seat) => call(`/${encodeURIComponent(qitemId)}/claim`, { destinationSession: seat }),
    async inspect(qitemId) {
      const id = encodeURIComponent(qitemId);
      // The item first: a 404 there is the daemon saying it has no such qitem.
      const item = await read(`/${id}`, true);
      const transitions = await read(`/${id}/transitions`);
      return { ...(item as object), transitions } as QueueObservation;
    },
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
  /** PW-19 slot caps by slotBudgetKey. Default: 1 in flight per key. */
  slotCaps?: SlotCaps;
  newQitemId?: () => string;
  log?: (line: string) => void;
}

/**
 * POST /plantworks/v1/claim-next {team, class?, seat}: 200 with the claimed job, 204 when nothing is
 * claimable, 429 when the team's slot budget key is at its cap (PW-19).
 */
export function claimNextRoutes(opts: ClaimNextOptions): BrokerRoutes {
  const log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const mint = opts.newQitemId ?? (() => newQitemId());
  const caps = opts.slotCaps ?? parseSlotCaps(undefined);

  return (app, { store, teams, emit }) => {
    app.post(`${API}/claim-next`, async (c) => {
      const body = await c.req.json().catch(() => null) as { team?: unknown; class?: unknown; seat?: unknown } | null;
      if (!body || typeof body.team !== "string" || typeof body.seat !== "string" || !SEAT.test(body.seat) || (body.class !== undefined && typeof body.class !== "string")) {
        return c.json({ error: "invalid_claim", message: "send {team, seat, class?}; seat is an OpenRig session name" }, 400);
      }
      const team = body.team;
      const spec = teams.get(team);
      if (!spec) return c.json({ error: "unknown_team", message: `no team spec for ${team}` }, 400);
      const cls = body.class ?? spec.defaultClass;
      if (!spec.classes[cls]) return c.json({ error: "unknown_class", message: `team ${team} has no class ${cls}` }, 400);
      const seat = body.seat;

      const qitemId = mint();
      // Count and reserve in one immediate transaction: a concurrent claim (or another broker on the
      // same file) can't read the same count and also reserve.
      const key = spec.endpoint.slotBudgetKey;
      const cap = capFor(caps, key);
      const reserved = store.db.transaction(() => {
        // PW-22: a draining seat gets no new work. Checked in the same transaction as the reserve.
        if (store.isDraining(seat)) return { draining: true } as const;
        const used = inFlight(store, teams, key);
        return used >= cap ? { capped: used } : store.reserve(team, cls, seat, qitemId);
      }).immediate();
      if (reserved && "draining" in reserved) {
        return c.json({ error: "seat_draining", message: `${seat} is draining and takes no new work; DELETE ${API}/seats/${seat}/drain resumes it`, seat }, 409);
      }
      if (reserved && "capped" in reserved) {
        return c.json({ error: "slot_cap_reached", message: `slot budget ${key} has ${reserved.capped} of ${cap} jobs in flight; ask again later`, slotBudgetKey: key, cap, inFlight: reserved.capped }, 429);
      }
      if (!reserved) return c.body(null, 204);
      const job = reserved;
      const envelope = JSON.parse(job.envelope) as JobEnvelope;

      try {
        await opts.daemon.create(qitemFor(job, opts.brokerSession));
      } catch (e) {
        if (e instanceof DaemonRefused) {
          // The daemon refused the create, so no qitem exists and nothing was delivered: safe to release.
          store.release(job.job_id, seat, qitemId);
          return c.json({ error: "daemon_refused", message: `the daemon refused to create the qitem for ${job.job_id}: ${e.message}` }, 503);
        }
        return held(e as Error);
      }
      try {
        await opts.daemon.claim(qitemId, seat);
      } catch (e) {
        return held(e as Error);
      }

      const confirmed = store.confirmClaim(job.job_id, seat, qitemId);
      if (confirmed === "lost") {
        // Only a bug gets here: a reservation is never taken over, and cancel refuses a reserved job.
        log(`plantworks broker: ${seat} lost the reservation on ${job.job_id} after creating ${qitemId}; left for reconciliation`);
        return c.json({ error: "reservation_lost", message: `${job.job_id} is no longer reserved for ${seat}`, jobId: job.job_id, qitemId }, 409);
      }
      emit(confirmed.row, "claimed", confirmed.detail);
      return c.json({ job: jobRecord(confirmed.row), qitemId, seat, envelope });

      /** The qitem may exist and may have been delivered: keep the reservation, counted and unclaimable. */
      function held(e: Error) {
        log(`plantworks broker: handoff of ${job.job_id} to ${seat} as ${qitemId} is unconfirmed (${e.message}); reservation held for reconciliation`);
        return c.json({ error: "handoff_unconfirmed", message: `the handoff of ${job.job_id} to ${seat} is unconfirmed: ${e.message}. The job stays reserved and counted until reconciliation settles it`, jobId: job.job_id, qitemId, seat }, 503);
      }
    });
  };
}

/** The qitem claim-next creates for a reserved job: the same id, seat and body on every attempt. */
function qitemFor(job: JobRow, brokerSession: string) {
  const envelope = JSON.parse(job.envelope) as JobEnvelope;
  return {
    qitemId: job.reserved_qitem_id!,
    source: brokerSession,
    destination: job.reserved_by!,
    body: `Plantworks job ${job.job_id} (team ${job.team}, class ${job.class})\n\n${envelope.task.prompt}`,
    summary: envelope.task.title ?? `Plantworks job ${job.job_id}`,
    tags: ["plantworks", `plantworks-job:${job.job_id}`, `plantworks-team:${job.team}`, `plantworks-class:${job.class}`],
  };
}

/**
 * W3-A: finishes a claim-next handoff that a broker crash or failed call left between reserve and
 * confirmClaim. It does this by retrying the same steps with the same qitem id for the same seat.
 * Only a reservation older than RESERVATION_LEASE_MS is touched, so a claim-next still in flight
 * is never raced. Then:
 * - the daemon has no qitem with that id (404): create it. A retried create is idempotent upstream,
 *   so a create that did land answers as the same qitem. If the daemon refuses (4xx), nothing was
 *   delivered and the reservation is released, the same rule claim-next applies;
 * - the qitem is still pending and addressed to the reserving seat: claim it for that seat;
 * - any other answer, or no answer: change nothing.
 * Nothing here releases on age, moves the job to another seat, or closes a qitem. The caller then
 * settles the broker side (confirmClaim) from what the daemon shows.
 */
export async function recoverHandoff(store: Store, daemon: DaemonQueue, brokerSession: string, row: JobRow, now = Date.now()): Promise<"recovered" | "released" | "untouched"> {
  if (row.state !== "queued" || !row.reserved_by || !row.reserved_qitem_id || !row.reserved_at) return "untouched";
  if (now - Date.parse(row.reserved_at) < RESERVATION_LEASE_MS) return "untouched";
  const item = await daemon.inspect(row.reserved_qitem_id).catch((e) => {
    if (e instanceof QitemNotFound) return null;
    throw e;
  });
  // Only this seat's own pending qitem is claimed; anything else is left to reconciliation's rules.
  if (item && (item.state !== "pending" || item.destinationSession !== row.reserved_by)) return "untouched";
  if (!item) {
    try {
      await daemon.create(qitemFor(row, brokerSession));
    } catch (e) {
      if (!(e instanceof DaemonRefused)) throw e;
      store.release(row.job_id, row.reserved_by, row.reserved_qitem_id);
      return "released";
    }
  }
  await daemon.claim(row.reserved_qitem_id, row.reserved_by);
  return "recovered";
}
