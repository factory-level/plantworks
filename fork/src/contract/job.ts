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

export const CANCEL_REASONS = ["denied", "approval-expired", "cancelled"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const DEFAULT_CLASS = "quick";

export interface JobEnvelope {
  jobId: string;
  team: string;
  class?: string;
  task: { prompt: string; title?: string };
  callback?: { url: string };
  timeoutSeconds?: number;
}

/** Detail carried by a transition. Only terminal states carry any. */
export type TransitionDetail =
  | { outcome: DoneOutcome; closure?: "handoff-sre" }
  | { reason: FailureReason | CancelReason; message?: string }
  | Record<string, never>;

const NEXT: Record<JobState, readonly JobState[]> = {
  held: ["queued", "cancelled"],
  queued: ["claimed", "cancelled"],
  claimed: ["running"],
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

export const JOB_ID = /^kb-([A-Za-z0-9]+)-([A-Za-z0-9]+)-a([1-9][0-9]*)$/;
export const DNS_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function parseJobId(jobId: string): { board: string; cardId: string; attempt: number } | null {
  const m = JOB_ID.exec(jobId);
  return m ? { board: m[1]!, cardId: m[2]!, attempt: Number(m[3]) } : null;
}

export type Validation = { ok: true; envelope: JobEnvelope } | { ok: false; errors: string[] };

/** Validates a submitted envelope (untrusted input) and fills the default class. */
export function validateEnvelope(input: unknown): Validation {
  const errors: string[] = [];
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!obj(input)) return { ok: false, errors: ["envelope must be an object"] };

  const known = ["jobId", "team", "class", "task", "callback", "timeoutSeconds"];
  for (const k of Object.keys(input)) if (!known.includes(k)) errors.push(`unknown field ${k}`);

  if (typeof input.jobId !== "string" || !parseJobId(input.jobId)) errors.push("jobId must match kb-<board>-<cardId>-a<attempt>");
  if (typeof input.team !== "string" || !DNS_NAME.test(input.team)) errors.push("team must be a DNS-safe name");
  if (input.class !== undefined && (typeof input.class !== "string" || !DNS_NAME.test(input.class))) errors.push("class must be a DNS-safe name");

  if (!obj(input.task)) errors.push("task must be an object");
  else {
    for (const k of Object.keys(input.task)) if (k !== "prompt" && k !== "title") errors.push(`unknown field task.${k}`);
    if (typeof input.task.prompt !== "string" || input.task.prompt.trim() === "") errors.push("task.prompt must be a non-empty string");
    if (input.task.title !== undefined && typeof input.task.title !== "string") errors.push("task.title must be a string");
  }

  if (input.callback !== undefined) {
    if (!obj(input.callback) || Object.keys(input.callback).some((k) => k !== "url")) errors.push("callback must be { url }");
    else if (typeof input.callback.url !== "string" || !/^https?:\/\//.test(input.callback.url) || !URL.canParse(input.callback.url)) errors.push("callback.url must be an http(s) URL");
  }

  const t = input.timeoutSeconds;
  if (t !== undefined && !(Number.isInteger(t) && (t as number) > 0)) errors.push("timeoutSeconds must be a positive integer");

  if (errors.length) return { ok: false, errors };
  const envelope = input as unknown as JobEnvelope;
  return { ok: true, envelope: { ...envelope, class: envelope.class ?? DEFAULT_CLASS } };
}
