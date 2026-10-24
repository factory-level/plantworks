// SPDX-License-Identifier: Apache-2.0
// Job envelope and lifecycle: the contract between a front door, the broker and the runner.
// fork/schema/job-envelope.schema.json is the published form of the envelope; job.test.ts keeps
// the two in step. See README.md in this directory for which parts are defaults.

export const JOB_STATES = ["held", "queued", "claimed", "running", "done", "failed", "cancelled", "retried"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const DONE_OUTCOMES = ["succeeded", "rejected-by-checks"] as const;
export type DoneOutcome = (typeof DONE_OUTCOMES)[number];

export const FAILURE_REASONS = ["call-deadline", "timeout", "error"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const CANCEL_REASONS = ["denied", "approval-expired", "front-door"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export interface JobEnvelope {
  jobId: string;
  team: string;
  /** Absent means the team spec's default class; the broker resolves it. */
  class?: string;
  task: { prompt: string; title?: string };
  timeoutSeconds?: number;
  /** Optional fork-defined repository scope; HarnessHG acknowledgement is pending. */
  repo?: { owner: string; name: string };
  /** Optional fork-defined token budget; absent uses the selected class context. */
  contextBudget?: number;
  /** Optional opaque origin reference; HarnessHG acknowledgement is pending. */
  origin?: { kind: string; ref: string };
}

/** Detail carried by a transition. Only done, failed and cancelled carry any. */
export type TransitionDetail =
  | { outcome: DoneOutcome; closure?: "handoff-sre" }
  | { reason: FailureReason | CancelReason; message?: string }
  | Record<string, never>;

const NEXT: Record<JobState, readonly JobState[]> = {
  held: ["queued", "cancelled"],
  queued: ["claimed", "cancelled"],
  claimed: ["running", "failed"],
  running: ["done", "failed"],
  failed: ["retried"],
  done: [],
  cancelled: [],
  retried: [],
};

export const INITIAL_STATES: readonly JobState[] = ["queued", "held"];

export function isTerminal(state: JobState): boolean {
  return NEXT[state].length === 0;
}

export function canTransition(from: JobState, to: JobState): boolean {
  return NEXT[from].includes(to);
}

/** Checks a move and its detail; returns the detail to record, or throws. */
export function transition(from: JobState, to: JobState, detail: Record<string, unknown> = {}): TransitionDetail {
  if (!canTransition(from, to)) throw new Error(`illegal job transition ${from} -> ${to}`);
  const keys = Object.keys(detail);
  const allow = (...allowed: string[]) => {
    const extra = keys.filter((k) => !allowed.includes(k));
    if (extra.length) throw new Error(`${to} does not take ${extra.join(", ")}`);
  };
  switch (to) {
    case "done":
      allow("outcome", "closure");
      if (!DONE_OUTCOMES.includes(detail.outcome as DoneOutcome)) throw new Error(`done needs outcome: ${DONE_OUTCOMES.join(" | ")}`);
      if (detail.closure !== undefined && detail.closure !== "handoff-sre") throw new Error("done closure must be handoff-sre");
      return detail as TransitionDetail;
    case "failed":
    case "cancelled": {
      allow("reason", "message");
      const reasons: readonly string[] = to === "failed" ? FAILURE_REASONS : CANCEL_REASONS;
      if (!reasons.includes(detail.reason as string)) throw new Error(`${to} needs reason: ${reasons.join(" | ")}`);
      if (detail.message !== undefined && typeof detail.message !== "string") throw new Error("message must be a string");
      return detail as TransitionDetail;
    }
    default:
      allow();
      return {};
  }
}

// Board: a Hermes kanban board slug (may contain - and _). Card: a Hermes task id such as
// t_3fa9c01e (no -), so the card is always the second-to-last segment.
export const JOB_ID = /^kb-([a-z0-9][a-z0-9_-]{0,63})-([A-Za-z0-9_]{1,64})-a([1-9][0-9]{0,5})$/;
export const DNS_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const MAX_PROMPT = 65536;
export const MAX_TITLE = 200;

export function parseJobId(jobId: string): { board: string; cardId: string; attempt: number } | null {
  const m = JOB_ID.exec(jobId);
  return m ? { board: m[1]!, cardId: m[2]!, attempt: Number(m[3]) } : null;
}

export type Validation = { ok: true; envelope: JobEnvelope } | { ok: false; errors: string[] };

/** Validates a submitted envelope (untrusted input). */
export function validateEnvelope(input: unknown): Validation {
  const errors: string[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!obj(input)) return { ok: false, errors: ["envelope must be an object"] };

  const known = ["jobId", "team", "class", "task", "timeoutSeconds", "repo", "contextBudget", "origin"];
  for (const k of Object.keys(input)) if (!known.includes(k)) errors.push(`unknown field ${k}`);

  if (typeof input.jobId !== "string" || !parseJobId(input.jobId)) errors.push("jobId must match kb-<board>-<cardId>-a<attempt>");
  if (typeof input.team !== "string" || !DNS_NAME.test(input.team)) errors.push("team must be a DNS-safe name");
  if (input.class !== undefined && (typeof input.class !== "string" || !DNS_NAME.test(input.class))) errors.push("class must be a DNS-safe name");

  if (!obj(input.task)) errors.push("task must be an object");
  else {
    for (const k of Object.keys(input.task)) if (k !== "prompt" && k !== "title") errors.push(`unknown field task.${k}`);
    const { prompt, title } = input.task;
    if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_PROMPT) errors.push(`task.prompt must be a non-empty string of at most ${MAX_PROMPT} characters`);
    if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE)) errors.push(`task.title must be a string of at most ${MAX_TITLE} characters`);
  }

  const t = input.timeoutSeconds;
  if (t !== undefined && !(Number.isInteger(t) && (t as number) > 0)) errors.push("timeoutSeconds must be a positive integer");

  const repo = input.repo;
  if (repo !== undefined) {
    if (!obj(repo)) errors.push("repo must be an object");
    else {
      for (const k of Object.keys(repo)) if (k !== "owner" && k !== "name") errors.push(`unknown field repo.${k}`);
      for (const k of ["owner", "name"]) if (typeof repo[k] !== "string" || repo[k] === "") errors.push(`repo.${k} must be a non-empty string`);
    }
  }
  if (input.contextBudget !== undefined && !(Number.isInteger(input.contextBudget) && (input.contextBudget as number) > 0)) errors.push("contextBudget must be a positive integer");
  const origin = input.origin;
  if (origin !== undefined) {
    if (!obj(origin)) errors.push("origin must be an object");
    else {
      for (const k of Object.keys(origin)) if (k !== "kind" && k !== "ref") errors.push(`unknown field origin.${k}`);
      for (const k of ["kind", "ref"]) if (typeof origin[k] !== "string" || origin[k] === "") errors.push(`origin.${k} must be a non-empty string`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, envelope: input as unknown as JobEnvelope };
}
