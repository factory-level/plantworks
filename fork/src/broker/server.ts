// SPDX-License-Identifier: Apache-2.0
// The broker's HTTP API (ADR 0204 "Job lifecycle"): idempotent submit, inspect and cancel, for one
// set of teams. Hono and its node server are what upstream's daemon already ships.
import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { isLoopbackBind } from "../../../packages/daemon/dist/middleware/auth-bearer-token.js";
import { canTransition, validateEnvelope, type JobEnvelope, type JobState } from "../contract/job.ts";
import { createEmitter, type CloudEvent } from "../events/job-state.ts";
import { createJobStateOutbox, eventForTransition, transitionColumns } from "../events/outbox.ts";
import { SWEEP_MS, decisionRoute, requestApproval, sweepApprovals } from "./approvals.ts";
import { PHASE_0_1, validateSpec, type Platform, type TeamSpec } from "../team/spec.ts";
import type { JobRow, Store } from "./store.ts";

export const API = "/plantworks/v1";
/** A largest-possible envelope (65,536-character prompt, 200-character title) is well under this. */
export const MAX_BODY_BYTES = 512 * 1024;

/** Loads <dir>/<team>/team.json for every team. Throws with every problem found: the broker refuses to start. */
export function loadTeams(dir: string, platform: Platform = PHASE_0_1): Map<string, TeamSpec> {
  const teams = new Map<string, TeamSpec>();
  const problems: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const file = join(dir, name, "team.json");
    let spec: unknown;
    try { spec = JSON.parse(readFileSync(file, "utf8")); } catch (e) { problems.push(`${file}: ${(e as Error).message}`); continue; }
    const errors = validateSpec(spec, platform);
    if (!errors.length && (spec as TeamSpec).team !== name) errors.push(`team is ${(spec as TeamSpec).team}, but the directory is ${name}`);
    if (errors.length) problems.push(`${file}: ${errors.join("; ")}`);
    else teams.set(name, spec as TeamSpec);
  }
  if (problems.length) throw new Error(`invalid team specs:\n  ${problems.join("\n  ")}`);
  if (!teams.size) throw new Error(`no team specs under ${dir} (expected <team>/team.json)`);
  return teams;
}

/** The job record the API returns (fork/schema/job-record.schema.json). */
export function jobRecord(row: JobRow) {
  return {
    jobId: row.job_id, team: row.team, class: row.class, state: row.state, detail: JSON.parse(row.detail),
    createdAt: row.created_at, updatedAt: row.updated_at, result: row.result === null ? null : JSON.parse(row.result),
  };
}

export type Emit = (row: Pick<JobRow, "job_id" | "team">, state: JobState, detail?: Record<string, unknown>) => void;
/** Posts any Plantworks CloudEvent to the team's callbackDefault. */
export type Send = (team: string, event: CloudEvent) => void;
export interface BrokerContext {
  store: Store;
  teams: Map<string, TeamSpec>;
  /** A plantworks.job.state event for a row. */
  emit: Emit;
  send: Send;
  /** The absolute URL a decision for this job is POSTed to. */
  decisionUrl: (jobId: string) => string;
}
/** Adds routes to the broker without editing this file (PW-18's claim-next, PW-23's decisions). */
export type BrokerRoutes = (app: Hono, ctx: BrokerContext) => void;

export interface BrokerOptions {
  store: Store;
  teams: Map<string, TeamSpec>;
  /** PLANTWORKS_BROKER_TOKEN. When set, every API request needs `Authorization: Bearer <token>`. */
  token?: string;
  routes?: BrokerRoutes[];
  /** Test hook; defaults to one PW-10 emitter per team, posting to its events.callbackDefault. */
  send?: Send;
  /** Internal hook used by startBroker to wake the durable job-state outbox. */
  emitJobState?: Emit;
  /** The broker's address as callers reach it, for decision URLs (PLANTWORKS_BROKER_PUBLIC_URL). startBroker defaults it to the listen address. */
  publicUrl?: string;
  /** Where `${NAME}` placeholders in a spec's callbackDefault are read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  onListen?: (ctx: BrokerContext) => () => void;
}

const fail = (status: 400 | 401 | 404 | 409 | 413, error: string, message: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, message, ...extra }, { status });

export function createBroker(opts: BrokerOptions): Hono & { sweepApprovals: () => number } {
  const { store, teams } = opts;
  const log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const send = opts.send ?? teamDelivery(teams, opts.env ?? process.env, log).send;
  const emit: Emit = opts.emitJobState ?? ((row, state) => {
    const job = store.get(row.job_id);
    const transition = store.db.prepare("SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(row.job_id) as import("./store.ts").TransitionRow | undefined;
    if (!job || !transition || transition.to_state !== state) throw new Error(`missing persisted ${state} transition for ${row.job_id}`);
    send(row.team, eventForTransition(job, transition, transitionColumns(store, transition)));
  });
  const decisionUrl = (jobId: string) => {
    if (!opts.publicUrl) throw new Error("no publicUrl for decision URLs");
    return `${opts.publicUrl.replace(/\/$/, "")}${API}/jobs/${encodeURIComponent(jobId)}/decision`;
  };
  const ctx: BrokerContext = { store, teams, emit, send, decisionUrl };
  const app = new Hono();

  if (opts.token) {
    const want = digest(opts.token);
    app.use(`${API}/*`, async (c, next) => {
      const got = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!got || !timingSafeEqual(digest(got), want)) return fail(401, "unauthorized", "send Authorization: Bearer <PLANTWORKS_BROKER_TOKEN>");
      await next();
    });
  }

  const tooLarge = () => fail(413, "too_large", `the body is over ${MAX_BODY_BYTES} bytes`);
  app.post(`${API}/jobs`, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }), async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch (e) {
      // bodyLimit cuts a body without Content-Length while it streams; that surfaces here.
      return (e as Error).name === "BodyLimitError" ? tooLarge() : fail(400, "invalid_envelope", "body is not JSON");
    }
    const v = validateEnvelope(body);
    if (!v.ok) return fail(400, "invalid_envelope", v.errors.join("; "), { errors: v.errors });
    const job = v.envelope;
    const existing = store.get(job.jobId);
    if (existing) return replay(existing, job);

    const spec = teams.get(job.team);
    if (!spec) return fail(400, "unknown_team", `no team spec for ${job.team}`);
    const cls = job.class ?? spec.defaultClass;
    const qc = spec.classes[cls];
    if (!qc) return fail(400, "unknown_class", `team ${job.team} has no class ${cls}`);
    if (job.timeoutSeconds !== undefined && job.timeoutSeconds > qc.timeoutSeconds) {
      return fail(400, "timeout_over_ceiling", `timeoutSeconds ${job.timeoutSeconds} exceeds the ${cls} ceiling of ${qc.timeoutSeconds}`);
    }
    // A class that needs approval (per-job or always) holds every job until it is decided.
    const held = qc.approval !== "never";
    const { row, created } = store.insert(job, cls, held ? "held" : "queued", held ? qc.approvalTtlSeconds : undefined);
    if (!created) return replay(row, job);
    emit(row, row.state);
    if (held) requestApproval(row, ctx);
    return c.json(jobRecord(row), 201);
  });

  app.get(`${API}/jobs/:jobId`, (c) => {
    const row = store.get(c.req.param("jobId"));
    return row ? c.json(jobRecord(row)) : fail(404, "not_found", `no job ${c.req.param("jobId")}`);
  });

  app.post(`${API}/jobs/:jobId/cancel`, (c) => {
    const row = store.get(c.req.param("jobId"));
    if (!row) return fail(404, "not_found", `no job ${c.req.param("jobId")}`);
    if (row.state === "cancelled") return c.json(jobRecord(row));
    // A reserved job is being handed to a seat, which may already have it (PW-19 fail-closed):
    // cancelling would free its slot while Pi may run.
    if (row.reserved_by) return fail(409, "not_cancellable", `job ${row.job_id} is being handed to ${row.reserved_by}; cancel it after the handoff settles`, { job: jobRecord(row) });
    if (!canTransition(row.state, "cancelled")) return fail(409, "not_cancellable", `a ${row.state} job cannot be cancelled`, { job: jobRecord(row) });
    let moved;
    try {
      moved = store.transition(row.job_id, "cancelled", { reason: "front-door" });
    } catch (e) {
      // The job was reserved or changed between the read above and the transaction (another broker
      // on the same file): refuse, as for a reserved job.
      return fail(409, "not_cancellable", (e as Error).message, { job: jobRecord(store.get(row.job_id)!) });
    }
    const { row: next, detail } = moved;
    emit(next, "cancelled", detail);
    return c.json(jobRecord(next));
  });

  decisionRoute(API, fail, jobRecord)(app, ctx);
  for (const add of opts.routes ?? []) add(app, ctx);
  return Object.assign(app, { sweepApprovals: () => sweepApprovals(ctx) });

  function replay(row: JobRow, job: JobEnvelope) {
    if (canonical(JSON.parse(row.envelope)) === canonical(job)) return Response.json(jobRecord(row), { status: 200 });
    return fail(409, "job_conflict", `job ${job.jobId} exists with a different envelope`, { job: jobRecord(row) });
  }
}

/** Listens on host:port. Refuses a non-loopback bind without a token, as the daemon does (PW-16). */
export function startBroker(opts: BrokerOptions & { host: string; port: number }): Promise<{ url: string; close: () => Promise<void> }> {
  if (!isLoopbackBind(opts.host) && !opts.token) {
    throw new Error(`refusing to bind the broker on ${opts.host} without PLANTWORKS_BROKER_TOKEN`);
  }
  // Off loopback the listen address (0.0.0.0, a pod IP) is not what callers reach; decision URLs need the real one.
  if (!isLoopbackBind(opts.host) && !opts.publicUrl) {
    throw new Error(`refusing to bind the broker on ${opts.host} without --public-url or PLANTWORKS_BROKER_PUBLIC_URL (decision URLs must be reachable)`);
  }
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const delivery = opts.send ? undefined : teamDelivery(opts.teams, opts.env ?? process.env, log);
  const outbox = delivery ? createJobStateOutbox(opts.store, delivery.deliver, log) : undefined;
  const send = opts.send ?? delivery!.send;
  const emit: Emit = outbox?.wake ?? ((row, state) => {
    const job = opts.store.get(row.job_id);
    const transition = opts.store.db.prepare("SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(row.job_id) as import("./store.ts").TransitionRow | undefined;
    if (!job || !transition || transition.to_state !== state) throw new Error(`missing persisted ${state} transition for ${row.job_id}`);
    send(row.team, eventForTransition(job, transition, transitionColumns(opts.store, transition)));
  });
  const live = { ...opts, send, emitJobState: emit }; // publicUrl is filled in once the port is known; createBroker reads it per request
  const app = createBroker(live);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info) => {
      const host = info.address.includes(":") ? `[${info.address}]` : info.address;
      const url = `http://${host}:${info.port}`;
      live.publicUrl ??= url;
      const decisionUrl = (jobId: string) => `${live.publicUrl!.replace(/\/$/, "")}${API}/jobs/${encodeURIComponent(jobId)}/decision`;
      const stop = opts.onListen?.({ store: opts.store, teams: opts.teams, emit, send: live.send!, decisionUrl });
      // A store error in the sweep (a busy file, a lost conditional update) is logged and retried next tick, never a crash.
      const sweep = setInterval(() => {
        try { app.sweepApprovals(); } catch (e) { log(`approval sweep failed: ${(e as Error).message}`); }
      }, SWEEP_MS);
      const replay = setInterval(() => { void outbox?.pump(); }, 1000);
      void outbox?.pump();
      resolve({ url, close: () => new Promise((r) => { clearInterval(sweep); clearInterval(replay); stop?.(); server.close(() => r()); }) });
    });
  });
}

/**
 * `callbackDefault` is one operator-supplied `${NAME_CALLBACK}` reference. Literal or mixed URLs
 * would let a team spec choose where broker-held credentials are sent.
 */
export function expand(value: string, env: Record<string, string | undefined>): string {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*_CALLBACK)\}$/.exec(value);
  if (!match) throw new Error("callbackDefault must be an operator callback reference (${NAME_CALLBACK})");
  const name = match[1]!;
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (used in callbackDefault)`);
  return v;
}

const CALLBACK_CREDENTIAL_PREFIX = "PLANTWORKS_CALLBACK_TOKEN_";

function callbackCredentials(env: Record<string, string | undefined>): Map<string, string> {
  return new Map(Object.entries(env)
    .filter(([name, value]) => name.startsWith(CALLBACK_CREDENTIAL_PREFIX) && value?.trim())
    .map(([name, value]) => [name.slice(CALLBACK_CREDENTIAL_PREFIX.length), value!.trim()]));
}

/**
 * One PW-10 emitter per team, posting to its callbackDefault. Approval events go there too: the
 * front door is the only approval consumer this broker knows (`events.approvalConsumer: frontdoor`).
 */
function teamDelivery(teams: Map<string, TeamSpec>, env: Record<string, string | undefined>, log: (l: string) => void) {
  const credentials = callbackCredentials(env);
  const emitters = new Map([...teams].map(([name, spec]) => {
    if (spec.events.approvalConsumer !== "frontdoor") throw new Error(`team ${name}: events.approvalConsumer ${spec.events.approvalConsumer} is not supported (only frontdoor)`);
    const bearerToken = spec.events.auth ? credentials.get(spec.events.auth.secretRef) : undefined;
    if (spec.events.auth && !bearerToken) throw new Error(`team ${name}: configured callback credential is unavailable`);
    return [name, createEmitter({
      url: expand(spec.events.callbackDefault, env),
      ...(bearerToken ? { bearerToken } : {}),
      onDeliveryError: (err) => { if (err.event.type !== "plantworks.job.state") log(`${err.event.type} not delivered: ${err.message}`); },
    })];
  }));
  const deliver = (team: string, event: CloudEvent): Promise<void> => {
    const emitter = emitters.get(team);
    return emitter ? emitter.emit(event) : Promise.reject(new Error(`no event callback for team ${team}`));
  };
  // Delivery runs alongside the request; a slow consumer never holds the API.
  return { deliver, send: (team: string, event: CloudEvent) => { void deliver(team, event).catch(() => {}); } };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** JSON with object keys sorted, so two equal envelopes compare equal whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
