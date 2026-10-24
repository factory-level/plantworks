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
import { canTransition, parseJobId, validateEnvelope, type JobEnvelope, type JobState } from "../contract/job.ts";
import { createEmitter, jobStateEvent } from "../events/job-state.ts";
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
export interface BrokerContext { store: Store; teams: Map<string, TeamSpec>; emit: Emit }
/** Adds routes to the broker without editing this file (PW-18's claim-next, PW-23's decisions). */
export type BrokerRoutes = (app: Hono, ctx: BrokerContext) => void;

export interface BrokerOptions {
  store: Store;
  teams: Map<string, TeamSpec>;
  /** PLANTWORKS_BROKER_TOKEN. When set, every API request needs `Authorization: Bearer <token>`. */
  token?: string;
  routes?: BrokerRoutes[];
  /** Test hook; defaults to one PW-10 emitter per team, posting to its events.callbackDefault. */
  emit?: Emit;
  /** Where `${NAME}` placeholders in a spec's callbackDefault are read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

const fail = (status: 400 | 401 | 404 | 409 | 413, error: string, message: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, message, ...extra }, { status });

export function createBroker(opts: BrokerOptions): Hono {
  const { store, teams } = opts;
  const log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const emit = opts.emit ?? teamEmitters(teams, opts.env ?? process.env, log);
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
    // ponytail: approval classes are refused until PW-23 adds held jobs and decisions, so no
    // job ever runs unapproved; PW-23 replaces this with `held`.
    if (qc.approval !== "never") return fail(400, "approval_unsupported", `class ${cls} needs approval (${qc.approval}), which this broker does not handle yet`);

    const { row, created } = store.insert(job, cls, "queued");
    if (!created) return replay(row, job);
    emit(row, "queued");
    // The next attempt retires a failed previous one (ADR: failed -> retried when Hermes resubmits).
    const id = parseJobId(job.jobId)!;
    const previous = id.attempt > 1 ? store.get(`kb-${id.board}-${id.cardId}-a${id.attempt - 1}`) : undefined;
    if (previous?.state === "failed" && previous.team === job.team) {
      const { row: retired, detail } = store.transition(previous.job_id, "retried");
      emit(retired, "retried", detail);
    }
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
    if (!canTransition(row.state, "cancelled")) return fail(409, "not_cancellable", `a ${row.state} job cannot be cancelled`, { job: jobRecord(row) });
    const { row: next, detail } = store.transition(row.job_id, "cancelled", { reason: "front-door" });
    emit(next, "cancelled", detail);
    return c.json(jobRecord(next));
  });

  for (const add of opts.routes ?? []) add(app, { store, teams, emit });
  return app;

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
  const app = createBroker(opts);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info) => {
      const host = info.address.includes(":") ? `[${info.address}]` : info.address;
      resolve({ url: `http://${host}:${info.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/**
 * `${NAME}` in a spec's callbackDefault, from the broker's environment. Only names ending in
 * `_CALLBACK` resolve, so a team spec cannot copy a broker secret (its token, an endpoint key) into
 * the URL every event is posted to. Throws on any other or unset name: the broker refuses to start.
 */
export function expand(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    if (!name.endsWith("_CALLBACK")) throw new Error(`only \${..._CALLBACK} names may be used in callbackDefault, not ${name}`);
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set (used in ${value})`);
    return v;
  });
}

function teamEmitters(teams: Map<string, TeamSpec>, env: Record<string, string | undefined>, log: (l: string) => void): Emit {
  const emitters = new Map([...teams].map(([name, spec]) => [name, createEmitter({
    url: expand(spec.events.callbackDefault, env),
    onDeliveryError: (err) => log(`plantworks.job.state not delivered: ${err.message}`),
  })]));
  return (row, state, detail = {}) => {
    // Delivery runs alongside the request; a slow consumer never holds the API.
    emitters.get(row.team)?.emit(jobStateEvent({ jobId: row.job_id, team: row.team }, state, detail)).catch(() => {});
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** JSON with object keys sorted, so two equal envelopes compare equal whatever their key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
