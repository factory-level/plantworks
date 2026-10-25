// SPDX-License-Identifier: Apache-2.0
// PW-34, the handoff out (fork/docs/design/sre-handoff.md §1). A seat closes its qitem with
// `escalation` / `handoff-sre`; the job ends `done {outcome, closure: handoff-sre}` and the outbox
// emits `plantworks.handoff.requested` after that transition's job.state. Fork-defined, pending the
// HarnessHG ack. No Slack or Eve code: Hermes resolves the slackApp reference and posts.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { DNS_NAME, parseJobId, type DoneOutcome } from "../contract/job.ts";
import type { CloudEvent } from "../events/job-state.ts";
import type { TeamSpec } from "../team/spec.ts";

export const HANDOFF_EVENT = "plantworks.handoff.requested";
/** The one file in the class workspace the seat's Pi writes before closing with handoff-sre. */
export const HANDOFF_FILE = join(".plantworks", "handoff.json");
const MAX_FILE_BYTES = 16 * 1024;

/** What the worker's report carries in its `handoff` member: the parsed file, or why there is none. */
export type HandoffReport = { artifact: unknown } | { unavailable: string };

/** Persisted in the done transition's result, so a redelivered event is byte-identical. */
export type HandoffData =
  | { targetAgent: string; slackApp: string; summary: string; suggestedAction: string; evidence: { kind: string; uri: string }[]; outcome: DoneOutcome }
  | { unavailable: string };

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length >= 1 && v.length <= max;

/** The first problem with an artifact (untrusted, worker-asserted), or null. */
export function artifactProblem(a: unknown): string | null {
  if (!obj(a)) return "handoff must be an object";
  for (const k of Object.keys(a)) if (!["targetAgent", "summary", "suggestedAction", "evidence", "outcome"].includes(k)) return `unknown field ${k}`;
  if (typeof a.targetAgent !== "string" || !DNS_NAME.test(a.targetAgent)) return "targetAgent must be a DNS-safe name";
  if (!text(a.summary, 2000)) return "summary must be 1..2000 characters";
  if (!text(a.suggestedAction, 1000)) return "suggestedAction must be 1..1000 characters";
  if (a.evidence !== undefined) {
    if (!Array.isArray(a.evidence) || a.evidence.length > 20) return "evidence must be a list of at most 20";
    for (const e of a.evidence) {
      if (!obj(e) || Object.keys(e).some((k) => k !== "kind" && k !== "uri") || !text(e.kind, 64) || !text(e.uri, 2048)) return "evidence items must be {kind, uri}";
    }
  }
  if (a.outcome !== undefined && a.outcome !== "succeeded" && a.outcome !== "rejected-by-checks") return "outcome must be succeeded or rejected-by-checks";
  return null;
}

/**
 * The job's done outcome and the event data, from the report's handoff member and the team spec. Fail closed:
 * anything short of a valid artifact naming a mapped agent is `unavailable` with rejected-by-checks and no
 * targetAgent, so nothing routes to a guessed agent. A missing report (W4-A not yet on main) is `missing`.
 */
export function resolveHandoff(report: HandoffReport | undefined, spec: Pick<TeamSpec, "sre"> | undefined): { outcome: DoneOutcome; data: HandoffData } {
  const unavailable = (why: string) => ({ outcome: "rejected-by-checks" as const, data: { unavailable: why } });
  if (!report) return unavailable("missing");
  if ("unavailable" in report) return unavailable(report.unavailable);
  const problem = artifactProblem(report.artifact);
  if (problem) return unavailable(`invalid: ${problem}`);
  const a = report.artifact as { targetAgent: string; summary: string; suggestedAction: string; evidence?: { kind: string; uri: string }[]; outcome?: DoneOutcome };
  const agents = spec?.sre?.agents ?? {};
  if (!Object.hasOwn(agents, a.targetAgent)) return unavailable(`unknown-target: ${a.targetAgent}`);
  const outcome = a.outcome ?? "rejected-by-checks"; // a handoff never claims success by default
  // The reference's name, never its value: Hermes resolves it.
  const slackApp = agents[a.targetAgent]!.slackApp.slice(2, -1);
  return { outcome, data: { targetAgent: a.targetAgent, slackApp, summary: a.summary, suggestedAction: a.suggestedAction, evidence: (a.evidence ?? []).map(({ kind, uri }) => ({ kind, uri })), outcome } };
}

/**
 * The worker side: `.plantworks/handoff.json` in the class workspace, read once when the report is built.
 * A stale file left from before the job is the caller's to rule out (report.ts compares an lstat fingerprint).
 * The workspace's co-location check is the report path's (#105), not this function's.
 */
export function readHandoffFile(workspace: string | undefined): { artifact: unknown } | { unavailable: string } {
  if (!workspace) return { unavailable: "missing" };
  const path = join(workspace, HANDOFF_FILE);
  let stat;
  try { stat = lstatSync(path); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { unavailable: "missing" } : { unavailable: `invalid: ${(e as NodeJS.ErrnoException).code}` };
  }
  if (stat.isSymbolicLink()) return { unavailable: "invalid: symlink" };
  if (!stat.isFile()) return { unavailable: "invalid: not a regular file" };
  if (stat.size > MAX_FILE_BYTES) return { unavailable: "invalid: over 16 KiB" };
  let bytes: Buffer;
  try {
    // `.plantworks` itself may be a link out of the workspace.
    const rel = relative(realpathSync(workspace), realpathSync(path));
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { unavailable: "invalid: outside the workspace" };
    bytes = readFileSync(path);
  } catch (e) {
    return { unavailable: `invalid: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}` };
  }
  if (bytes.length > MAX_FILE_BYTES) return { unavailable: "invalid: over 16 KiB" };
  let artifact: unknown;
  try { artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return { unavailable: "invalid: not UTF-8 JSON" }; }
  return { artifact };
}

/** The event for a handoff done transition: same envelope as its job.state, id suffixed so consumers dedupe on it. */
export function handoffEvent(job: { jobId: string; team: string; transitionId: number; qitemId?: string; seat?: string; at: Date }, data: HandoffData): CloudEvent {
  const parsed = parseJobId(job.jobId);
  if (!parsed) throw new Error(`invalid jobId ${job.jobId}`);
  return {
    specversion: "1.0",
    type: HANDOFF_EVENT,
    source: `/plantworks/teams/${job.team}`,
    id: `${job.jobId}:${job.transitionId}:handoff.requested`,
    subject: job.jobId,
    time: job.at.toISOString(),
    datacontenttype: "application/json",
    data: {
      jobId: job.jobId, team: job.team, attempt: parsed.attempt,
      ...(job.qitemId ? { qitemId: job.qitemId } : {}),
      ...(job.seat ? { seat: job.seat } : {}),
      ...("unavailable" in data ? { outcome: "rejected-by-checks", unavailable: data.unavailable } : data),
    },
  };
}
