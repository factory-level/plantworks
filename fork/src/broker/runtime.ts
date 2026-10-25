// SPDX-License-Identifier: Apache-2.0
// PW-22, the runtime contract (ADR 0204): what a platform needs to run the broker and its workers.
// - GET /healthz: liveness/readiness, unauthenticated, and says nothing about jobs.
// - GET /plantworks/v1/stats: queue depth for autoscaling (KEDA metrics-api), behind the bearer.
// - /plantworks/v1/seats/{seat}/drain: a worker's preStop hook stops new work for its seat and
//   waits for what the seat still holds. Drain never fails, cancels, releases or closes a job.
import type { Hono } from "hono";
import type { JobRow } from "./store.ts";
import type { BrokerContext, BrokerRoutes } from "./server.ts";
import { API } from "./server.ts";
import { capFor, inFlight, type SlotCaps } from "./slots.ts";

const SEAT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

type Counts = { active: number; held: number; queued: number; reserved: number; claimed: number; running: number };
const zero = (): Counts => ({ active: 0, held: 0, queued: 0, reserved: 0, claimed: 0, running: 0 });

/**
 * Live job counts. `active` = queued + claimed + running, the work a worker pool exists for (the
 * chart's KEDA target). `queued` includes `reserved` (queued jobs mid-handoff to a seat). `held`
 * jobs wait for an approval decision and are not active: no worker can take them.
 */
export function stats(ctx: BrokerContext, caps: SlotCaps, dispatch?: { view(): unknown }) {
  const teams: Record<string, Counts & { classes: Record<string, Counts> }> = {};
  for (const name of ctx.teams.keys()) teams[name] = { ...zero(), classes: {} };
  let active = 0;
  for (const r of ctx.store.liveCounts()) {
    const team = (teams[r.team] ??= { ...zero(), classes: {} });
    const cls = (team.classes[r.class] ??= zero());
    for (const c of [team, cls]) {
      c[r.state as "held" | "queued" | "claimed" | "running"] += r.n;
      if (r.state === "queued" && r.reserved) c.reserved += r.n;
      if (r.state !== "held") c.active += r.n;
    }
    if (r.state !== "held") active += r.n;
  }
  const slots: Record<string, { inFlight: number; cap: number }> = {};
  for (const spec of ctx.teams.values()) {
    const key = spec.endpoint.slotBudgetKey;
    slots[key] ??= { inFlight: inFlight(ctx.store, ctx.teams, key), cap: capFor(caps, key) };
  }
  return { active, teams, slots, drainingSeats: ctx.store.drainingSeats(), ...(dispatch ? { dispatch: dispatch.view() } : {}) };
}

const seatView = (ctx: BrokerContext, seat: string) => {
  const held: JobRow[] = ctx.store.seatInFlight(seat);
  return { seat, draining: ctx.store.isDraining(seat), inFlight: held.map((r) => r.job_id) };
};

/** The runtime routes. `slotCaps` must be the same caps claim-next enforces. */
export function runtimeRoutes(opts: { slotCaps: SlotCaps; dispatch?: { view(): unknown } }): BrokerRoutes {
  return (app: Hono, ctx: BrokerContext) => {
    app.get("/healthz", (c) => {
      try {
        ctx.store.db.prepare("SELECT 1").get();
        return c.json({ status: "ok" });
      } catch {
        return c.json({ status: "unavailable" }, 503);
      }
    });

    app.get(`${API}/stats`, (c) => c.json(stats(ctx, opts.slotCaps, opts.dispatch)));

    const bad = (seat: string) => (SEAT.test(seat) ? null : Response.json({ error: "invalid_seat", message: "seat is an OpenRig session name" }, { status: 400 }));
    app.get(`${API}/seats/:seat/drain`, (c) => bad(c.req.param("seat")) ?? c.json(seatView(ctx, c.req.param("seat"))));
    app.post(`${API}/seats/:seat/drain`, (c) => {
      const seat = c.req.param("seat");
      const invalid = bad(seat);
      if (invalid) return invalid;
      ctx.store.setDraining(seat, true);
      return c.json(seatView(ctx, seat));
    });
    app.delete(`${API}/seats/:seat/drain`, (c) => {
      const seat = c.req.param("seat");
      const invalid = bad(seat);
      if (invalid) return invalid;
      ctx.store.setDraining(seat, false);
      return c.json(seatView(ctx, seat));
    });
  };
}
