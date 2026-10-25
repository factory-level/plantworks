// SPDX-License-Identifier: Apache-2.0
// W4-A, the worker's side of the broker-path job report (fork/docs/design/broker-report.md): what a
// worker records when it takes a job, and the report it sends once the seat has closed the job.
// Everything here is worker-asserted data; the broker stores it as such and never lets it decide `done`.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { snapshotWork, takeBaseline, type Artifacts } from "../job/artifacts.ts";
import { PROJECT_PROMPT_FILES } from "../job/run.ts";
import type { Usage } from "../llm/governor.ts";
import { seatLiveness } from "../seat/liveness.ts";
import { readHandoffFile, type HandoffReport } from "./handoff.ts";

export type ReportArtifacts = Artifacts & { observedBy: "worker" };

/** The broker's report limits (#113): beyond them it answers 400, so the worker degrades instead. */
export const REPORT_LIMITS = { files: 256, pathBytes: 2048, skippedChars: 512 };

/** Keeps a report within the broker's limits: a too-big file list becomes a skipped reason, so the usage still arrives. */
export function withinLimits(a: Artifacts): Artifacts {
  if (a.branch === null) return { branch: null, skipped: a.skipped.slice(0, REPORT_LIMITS.skippedChars) };
  const long = a.files.find((f) => Buffer.byteLength(f.path) > REPORT_LIMITS.pathBytes);
  if (a.files.length > REPORT_LIMITS.files || long) {
    const why = long ? `a path over ${REPORT_LIMITS.pathBytes} bytes` : `too many files (${a.files.length} > ${REPORT_LIMITS.files})`;
    return { branch: null, skipped: `${why}; the snapshot is on ${a.branch} at ${a.commit}, not listed`.slice(0, REPORT_LIMITS.skippedChars) };
  }
  return a;
}
/**
 * W4-E: `.plantworks/handoff.json` as the report's optional `handoff` member. On the wire `unavailable`
 * is exactly one category, `missing` or `invalid` (consumers match it, never parse it); the detail
 * goes only to the worker's log.
 */
export type JobReport = { usage: Usage | null; usageStatus?: string; artifacts: ReportArtifacts; handoff: HandoffReport };

/** What the worker holds for the job it runs: the baselines taken before the governor was armed. */
export type Take = {
  jobId: string;
  /** null when the worker didn't see the job start (a start-up recovery): its calls can't be counted. */
  usageBase: Usage | null;
  /** The tree baseline commit, or why there is none. */
  baseline: { commit: string } | { skipped: string };
  /** The job's last snapshot commit, if one was written: a later report for a new closure replaces exactly it. */
  snapshot?: string;
  /** W4-E: the workspace passed verification at take-up, so its handoff file may be read. */
  workspaceVerified?: boolean;
  /** W4-E: the hash of a handoff file already there at take-up, so a stale one never counts. */
  handoffBase?: string;
};

/**
 * Is `workspace` a tree this worker can vouch for? Absolute, present, readable, a git work tree, and
 * co-located with the seat: the seat's own runner state is visible and live, and the workspace sits
 * on the same filesystem as it. That is a heuristic (the deployment contract says the seat runs
 * there), not proof that Pi works in that tree. Returns the reason it can't, or undefined.
 */
export function workspaceProblem(workspace: string, openrigHome: string, seat: string): string | undefined {
  if (!isAbsolute(workspace)) return "workspace unverifiable: not an absolute path";
  if (!existsSync(workspace)) return "workspace unverifiable: it does not exist";
  try { accessSync(workspace, constants.R_OK | constants.X_OK); } catch { return "workspace unverifiable: not readable by the worker"; }
  if (!existsSync(join(workspace, ".git"))) return "workspace unverifiable: not a git work tree";
  const seatState = join(openrigHome, "state", "pi", seat);
  const live = seatLiveness(openrigHome, seat);
  if (live.verdict !== "live") return `workspace unverifiable: not co-located with the seat (its runner state is ${live.verdict})`;
  if (statSync(workspace).dev !== statSync(seatState).dev) return "workspace unverifiable: not co-located with the seat (another filesystem than its state)";
  return undefined;
}

/** A workspace that ships Pi prompt files would override the seat's own; the worker won't claim for it. */
export function promptFileProblem(workspace: string): string | undefined {
  const found = PROJECT_PROMPT_FILES.find((name) => existsSync(join(workspace, ".pi", name)));
  return found ? `the workspace ships .pi/${found}, which would replace the seat's system prompt; refusing to claim (refused when seen by the worker)` : undefined;
}

/**
 * At take-up, before the governor is armed: the usage and tree baselines. `recovered` is a job this
 * worker didn't see start (it found it held at start-up), so neither baseline would be honest.
 */
export function take(jobId: string, usageNow: Usage | undefined, opts: { recovered: boolean; workspace?: string; openrigHome: string; seat: string }): Take {
  if (opts.recovered) return { jobId, usageBase: null, baseline: { skipped: "baseline lost (worker restarted)" } };
  const usageBase = usageNow ?? { promptTokens: 0, completionTokens: 0 }; // undefined: no call has reported yet
  if (!opts.workspace) return { jobId, usageBase, baseline: { skipped: "no workspace" } };
  const problem = workspaceProblem(opts.workspace, opts.openrigHome, opts.seat);
  if (problem) return { jobId, usageBase, baseline: { skipped: problem } };
  let baseline: Take["baseline"];
  try { baseline = takeBaseline(opts.workspace); } catch (e) { baseline = { skipped: `baseline unreadable: ${(e as Error).message.split("\n")[0]}` }; }
  const before = readHandoffFile(opts.workspace);
  return { jobId, usageBase, baseline, workspaceVerified: true, ...("hash" in before ? { handoffBase: before.hash } : {}) };
}

/** W4-E: the job's handoff, as the wire's `{artifact}` or a bare `{unavailable}` category, and the detail for the log. */
export function handoffOf(t: Take, workspace: string | undefined): { handoff: HandoffReport; detail?: string } {
  if (!workspace) return { handoff: { unavailable: "missing" }, detail: "no workspace" };
  if (t.usageBase === null) return { handoff: { unavailable: "missing" }, detail: "baseline lost (worker restarted)" };
  if (!t.workspaceVerified) return { handoff: { unavailable: "missing" }, detail: "skipped" in t.baseline ? t.baseline.skipped : "workspace unverifiable" };
  const read = readHandoffFile(workspace, t.handoffBase);
  if ("artifact" in read) return { handoff: { artifact: read.artifact } };
  if (read.unavailable === "missing") return { handoff: { unavailable: "missing" }, detail: t.handoffBase ? "unchanged since take-up" : "no handoff file" };
  return { handoff: { unavailable: "invalid" }, detail: read.unavailable };
}

/** After the seat has closed the job: the usage delta, the snapshot against the baseline, and the handoff. */
export async function report(t: Take, usageNow: Usage | undefined, workspace: string | undefined, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<JobReport> {
  const usage = t.usageBase && { promptTokens: (usageNow?.promptTokens ?? 0) - t.usageBase.promptTokens, completionTokens: (usageNow?.completionTokens ?? 0) - t.usageBase.completionTokens };
  let artifacts: Artifacts;
  if ("skipped" in t.baseline || !workspace) artifacts = { branch: null, skipped: "skipped" in t.baseline ? t.baseline.skipped : "no workspace" };
  else {
    try { artifacts = await snapshotWork(workspace, t.jobId, `Plantworks job ${t.jobId}`, t.baseline.commit, t.snapshot); } catch (e) { artifacts = { branch: null, skipped: `the snapshot failed: ${(e as Error).message.split("\n")[0]}` }; }
    if (artifacts.branch) t.snapshot = artifacts.commit;
  }
  const { handoff, detail } = handoffOf(t, workspace);
  // The ordinary cases (no workspace, no file written) aren't worth a line; the rest are.
  if (detail && "unavailable" in handoff && detail !== "no workspace" && detail !== "no handoff file") log(`plantworks worker: ${t.jobId} handoff ${handoff.unavailable} (${detail})`);
  return { usage, ...(usage ? {} : { usageStatus: "unavailable(worker restarted)" }), artifacts: { ...withinLimits(artifacts), observedBy: "worker" }, handoff };
}
