// SPDX-License-Identifier: Apache-2.0
// Approvals (PW-23, ADR 0204): a job in a class with `approval` other than `never` starts `held`.
// The broker posts plantworks.approval.requested with a decision URL; whoever the front door asks
// (Hermes, then a person in Slack) POSTs a decision there. Approved goes held -> queued; denied
// or a run-out TTL goes held -> cancelled. Hooks only: the broker knows nothing about Slack.
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseJobId } from "../contract/job.ts";
import type { CloudEvent } from "../events/job-state.ts";
import type { JobRow } from "./store.ts";
import type { BrokerContext } from "./server.ts";

export const APPROVAL_REQUESTED = "plantworks.approval.requested";
export const APPROVAL_RESOLVED = "plantworks.approval.resolved";
/** How often the broker looks for held jobs whose TTL has run out. */
export const SWEEP_MS = 1000;

export type Decision = "approved" | "denied" | "expired";

export function approvalEvent(row: Pick<JobRow, "job_id" | "team">, type: typeof APPROVAL_REQUESTED | typeof APPROVAL_RESOLVED, data: Record<string, unknown>, now = new Date()): CloudEvent {
  const id = parseJobId(row.job_id);
  if (!id) throw new Error(`invalid jobId ${row.job_id}`);
  return {
    specversion: "1.0",
    type,
    source: `/plantworks/teams/${row.team}`,
    id: `${row.job_id}:${type === APPROVAL_REQUESTED ? "approval.requested" : "approval.resolved"}`,
    subject: row.job_id,
    time: now.toISOString(),
    datacontenttype: "application/json",
    data: { jobId: row.job_id, team: row.team, attempt: id.attempt, ...data },
  };
}

/** Posts plantworks.approval.requested for a job that has just been stored as held. */
export function requestApproval(row: JobRow, ctx: BrokerContext): void {
  const title = (JSON.parse(row.envelope) as { task: { title?: string } }).task.title;
  ctx.send(row.team, approvalEvent(row, APPROVAL_REQUESTED, {
    class: row.class,
    decisionUrl: ctx.decisionUrl(row.job_id),
    expiresAt: row.approval_expires_at,
    ...(title === undefined ? {} : { title }),
  }));
}

/** Resolves one held job: the state transition, its job.state event, then approval.resolved. */
function resolve(row: JobRow, decision: Decision, ctx: BrokerContext, extra: { by?: string; reason?: string } = {}): JobRow {
  const [to, detail] = decision === "approved"
    ? ["queued", {}] as const
    : ["cancelled", { reason: decision === "denied" ? "denied" : "approval-expired", ...(extra.reason ? { message: extra.reason } : {}) }] as const;
  const next = ctx.store.transition(row.job_id, to, detail, { approval_decision: decision });
  ctx.emit(next.row, to, next.detail);
  ctx.send(row.team, approvalEvent(row, APPROVAL_RESOLVED, { decision, ...extra }));
  return next.row;
}

/** Cancels every held job whose TTL has run out, as approval-expired. Returns how many. */
export function sweepApprovals(ctx: BrokerContext): number {
  const expired = ctx.store.expiredHolds();
  for (const row of expired) resolve(row, "expired", ctx);
  return expired.length;
}

/** POST /plantworks/v1/jobs/{jobId}/decision: {decision: "approve" | "deny", by?, reason?}. */
export function decisionRoute(api: string, fail: (status: 400 | 404 | 409 | 413, error: string, message: string, extra?: Record<string, unknown>) => Response, record: (row: JobRow) => unknown) {
  return (app: Hono, ctx: BrokerContext) => {
    app.post(`${api}/jobs/:jobId/decision`, bodyLimit({ maxSize: 4096, onError: () => fail(413, "too_large", "the decision body is over 4096 bytes") }), async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { return fail(400, "invalid_decision", "body is not JSON"); }
      const problems = decisionProblems(body);
      if (problems.length) return fail(400, "invalid_decision", problems.join("; "), { errors: problems });
      const { decision, by, reason } = body as { decision: "approve" | "deny"; by?: string; reason?: string };
      const want: Decision = decision === "approve" ? "approved" : "denied";

      sweepApprovals(ctx); // a decision that arrives after the TTL finds the job expired, sweep or not
      const row = ctx.store.get(c.req.param("jobId"));
      if (!row) return fail(404, "not_found", `no job ${c.req.param("jobId")}`);
      if (row.approval_decision === want) return c.json(record(row)); // the same decision again
      if (row.approval_decision === "expired") return fail(409, "approval_expired", `the approval for ${row.job_id} expired`, { job: record(row) });
      if (row.approval_decision) return fail(409, "already_decided", `${row.job_id} was already ${row.approval_decision}`, { job: record(row) });
      if (row.state !== "held") return fail(409, "not_held", `a ${row.state} job has no pending approval`, { job: record(row) });
      return c.json(record(resolve(row, want, ctx, { ...(by ? { by } : {}), ...(reason ? { reason } : {}) })));
    });
  };
}

function decisionProblems(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ["body must be an object"];
  const b = body as Record<string, unknown>;
  const errors = Object.keys(b).filter((k) => !["decision", "by", "reason"].includes(k)).map((k) => `unknown field ${k}`);
  if (b.decision !== "approve" && b.decision !== "deny") errors.push("decision must be approve or deny");
  if (b.by !== undefined && (typeof b.by !== "string" || b.by.length > 200)) errors.push("by must be a string of at most 200 characters");
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 1000)) errors.push("reason must be a string of at most 1000 characters");
  return errors;
}
