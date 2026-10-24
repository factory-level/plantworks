// SPDX-License-Identifier: Apache-2.0
// `plantworks pw job run`: the Phase 0 single-worker runner. One envelope, one Pi seat in RPC
// mode behind the per-seat call governor, and plantworks.job.state events for each step. No
// OpenRig daemon and no broker: the runner plays the broker's part for exactly one job.
import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_CLASS, classByName, type WorkerClass } from "../llm/classes.ts";
import { readEndpoint } from "../llm/endpoint.ts";
import { startGovernor, type Governor } from "../llm/governor.ts";
import { writeSeatFiles } from "../seat/pi-seat-files.ts";
import { transition, validateEnvelope, type JobState, type TransitionDetail } from "../contract/job.ts";
import { createEmitter, jobStateEvent, type DeliveryError } from "../events/job-state.ts";

/** Job timeout ceilings per class, from the ADR 0204 sample team spec (quick 900 s, long 3600 s). */
export const JOB_TIMEOUT_SECONDS: Record<string, number> = { quick: 900, long: 3600 };

export interface RunOptions {
  envelope: unknown;
  /** The team's events.callbackDefault: operator config, never from the envelope. */
  callbackUrl: string;
  openrigHome: string;
  /** Pi's working directory. */
  cwd: string;
  /** Pi's command line before the RPC flags, e.g. ["pi"] or [process.execPath, "/path/cli.js"]. */
  piCommand: string[];
  env?: NodeJS.ProcessEnv;
  /** Test hook: replaces the named class's limits. */
  workerClass?: WorkerClass;
  log?: (line: string) => void;
}

export interface RunResult {
  jobId: string;
  state: "done" | "failed";
  detail: TransitionDetail;
  /** Pi's last assistant text, or null. */
  text: string | null;
  /** Ids of state events the consumer never acknowledged; the caller owns re-sending them. */
  undelivered: string[];
}

/** Thrown before any event is emitted: the envelope or its class/timeout is not acceptable. */
export class RejectedJob extends Error {}

type Ending = { state: "done" | "failed"; detail: Record<string, unknown> };

/** Hermes task ids contain `_`, which seat session names do not allow. jobIds never contain `.`. */
export const sessionFor = (jobId: string) => `pw-${jobId.replaceAll("_", ".")}`;

export async function runJob(opts: RunOptions): Promise<RunResult> {
  const v = validateEnvelope(opts.envelope);
  if (!v.ok) throw new RejectedJob(`invalid envelope: ${v.errors.join("; ")}`);
  const job = v.envelope;
  const className = job.class ?? DEFAULT_CLASS;
  let workerClass: WorkerClass;
  try {
    workerClass = opts.workerClass ?? classByName(className);
  } catch (e) {
    throw new RejectedJob((e as Error).message);
  }
  const ceiling = JOB_TIMEOUT_SECONDS[className] ?? JOB_TIMEOUT_SECONDS.quick!;
  const timeoutSeconds = job.timeoutSeconds ?? ceiling;
  if (timeoutSeconds > ceiling) throw new RejectedJob(`timeoutSeconds ${timeoutSeconds} exceeds the ${className} ceiling of ${ceiling}`);

  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  const undelivered: string[] = [];
  const emitter = createEmitter({
    url: opts.callbackUrl,
    onDeliveryError: (err: DeliveryError) => { undelivered.push(err.event.id); log(`event not delivered: ${err.message}`); },
  });
  const sent: Promise<void>[] = [];
  let state: JobState = "queued";
  const enter = (to: JobState, detail: Record<string, unknown> = {}) => {
    const checked = to === "queued" ? {} : transition(state, to, detail);
    state = to;
    // Delivery runs alongside the job; a slow consumer never holds the seat.
    sent.push(emitter.emit(jobStateEvent(job, to, checked)).catch(() => {}));
  };

  enter("queued");
  enter("claimed");

  let governor: Governor | undefined;
  let pi: PiRpc | undefined;
  let ending: Ending;
  let text: string | null = null;
  try {
    const env = opts.env ?? process.env;
    let stop: (e: Ending) => void = () => {};
    const stopped = new Promise<Ending>((resolve) => (stop = resolve));
    governor = await startGovernor({
      endpoint: readEndpoint(env),
      workerClass,
      onFail: (reason) => stop({ state: "failed", detail: { reason, message: "3 consecutive model calls hit the deadline" } }),
    });
    const agentDir = writeSeatFiles({ openrigHome: opts.openrigHome, session: sessionFor(job.jobId), className, governorUrl: governor.url });
    pi = startPi(opts.piCommand, { cwd: opts.cwd, env: { ...env, PI_CODING_AGENT_DIR: agentDir } }, log);
    pi.exited.then((code) => stop({ state: "failed", detail: { reason: "error", message: `pi exited (${code}) before the job settled` } }));

    enter("running");
    const timer = setTimeout(() => stop({ state: "failed", detail: { reason: "timeout", message: `job exceeded ${timeoutSeconds}s` } }), timeoutSeconds * 1000);
    try {
      const accepted = await Promise.race([pi.request({ type: "prompt", message: job.task.prompt }), stopped]);
      if ("state" in accepted) ending = accepted;
      else if (!accepted.success) ending = { state: "failed", detail: { reason: "error", message: `pi rejected the prompt: ${accepted.error}` } };
      else {
        const result = await Promise.race([pi.settled, stopped]);
        if ("state" in result) ending = result;
        else if (result.lastStopReason === "error" || result.lastStopReason === "aborted") {
          ending = { state: "failed", detail: { reason: "error", message: result.lastError ?? `model call ended with ${result.lastStopReason}` } };
        } else {
          const reply = await pi.request({ type: "get_last_assistant_text" });
          text = (reply.data as { text?: string | null } | undefined)?.text ?? null;
          ending = { state: "done", detail: { outcome: "succeeded" } };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    ending = { state: "failed", detail: { reason: "error", message: (e as Error).message } };
  } finally {
    await pi?.stop();
    await governor?.close();
  }

  enter(ending.state, ending.detail);
  await Promise.all(sent);
  return { jobId: job.jobId, state: ending.state, detail: ending.detail as TransitionDetail, text, undelivered };
}

// --- Pi RPC client: just what one job needs -------------------------------------------------

type Response = { type: "response"; id?: string; command: string; success: boolean; error?: string; data?: unknown };
type Settled = { lastStopReason?: string; lastError?: string };

interface PiRpc {
  request(cmd: Record<string, unknown>): Promise<Response>;
  /** Resolves on agent_settled with the last assistant message's stop reason. */
  settled: Promise<Settled>;
  /** Resolves with the exit code (or signal) if Pi exits. */
  exited: Promise<number | string>;
  stop(): Promise<void>;
}

function startPi(command: string[], spawnOpts: { cwd: string; env: NodeJS.ProcessEnv }, log: (l: string) => void): PiRpc {
  const [bin, ...args] = command;
  const child: ChildProcess = spawn(bin!, [...args, "--mode", "rpc", "--no-session"], { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<string, (r: Response) => void>();
  let nextId = 0;
  let last: Settled = {};
  let settle: (s: Settled) => void = () => {};
  const settled = new Promise<Settled>((resolve) => (settle = resolve));
  const exited = new Promise<number | string>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? signal ?? "unknown"));
    child.on("error", (err) => { log(`pi failed to start: ${err.message}`); resolve(`spawn error: ${err.message}`); });
  });
  // A request still waiting when Pi goes away fails instead of hanging.
  exited.then((code) => {
    for (const [id, resolve] of pending) resolve({ type: "response", id, command: "?", success: false, error: `pi exited (${code})` });
    pending.clear();
  });

  // Strict JSONL: split on LF only (readline would also split on U+2028/U+2029 inside strings).
  let buf = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { log(`pi: unparseable stdout line`); continue; }
      if (rec.type === "response" && rec.id && pending.has(rec.id)) { pending.get(rec.id)!(rec); pending.delete(rec.id); }
      else if (rec.type === "message_end" && rec.message?.role === "assistant") last = { lastStopReason: rec.message.stopReason, lastError: rec.message.errorMessage };
      else if (rec.type === "agent_settled") settle(last);
    }
  });
  child.stderr!.setEncoding("utf8").on("data", (d: string) => log(`pi: ${d.trimEnd()}`));
  child.stdin!.on("error", () => {});

  return {
    request(cmd) {
      const id = `pw-${++nextId}`;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin!.write(`${JSON.stringify({ id, ...cmd })}\n`);
      });
    },
    settled,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin!.end(); // orderly shutdown
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
      if (!gone) { child.kill("SIGKILL"); await exited; }
    },
  };
}
