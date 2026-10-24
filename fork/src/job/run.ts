// SPDX-License-Identifier: Apache-2.0
// `plantworks pw job run`: the Phase 0 single-worker runner. One envelope, one Pi seat in RPC
// mode behind the per-seat call governor, and plantworks.job.state events for each step. No
// OpenRig daemon and no broker: the runner plays the broker's part for exactly one job.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CLASS, classByName, type WorkerClass } from "../llm/classes.ts";
import { readEndpoint } from "../llm/endpoint.ts";
import { startGovernor, type Governor } from "../llm/governor.ts";
import { writeSeatFiles } from "../seat/pi-seat-files.ts";
import { JOB_PRIORITIES, transition, validateEnvelope, type JobEnvelope, type JobState, type TransitionDetail } from "../contract/job.ts";
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
  /** Aborting it (Ctrl-C/SIGTERM in `pw job run`) stops Pi and ends the job `failed` with reason `interrupted`. */
  signal?: AbortSignal;
  /** The single-job lock. Default: <openrigHome>/plantworks/job.lock. */
  lockPath?: string;
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

/** Project files Pi reads ahead of the seat's own system prompt. */
export const PROJECT_PROMPT_FILES = ["SYSTEM.md", "APPEND_SYSTEM.md"];

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
  // A trusted project's own system prompt takes precedence over the seat's (Pi 1.4.0
  // dist/core/resource-loader.js:944-965), so a job repo that ships one is refused (PW-12).
  for (const name of PROJECT_PROMPT_FILES) if (existsSync(join(opts.cwd, ".pi", name))) throw new RejectedJob(`the job's repository ships .pi/${name}, which would replace the seat's system prompt; refusing it`);

  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  // PW-13: one job at a time. Taken before any event, so a refused job emits nothing.
  const lock = takeJobLock(opts.lockPath ?? join(opts.openrigHome, "plantworks", "job.lock"));
  try {
    return await runLocked(opts, job, className, workerClass, timeoutSeconds, log, lock);
  } finally {
    lock.release();
  }
}

async function runLocked(opts: RunOptions, job: JobEnvelope, className: string, workerClass: WorkerClass, timeoutSeconds: number, log: (line: string) => void, lock: JobLock): Promise<RunResult> {
  const undelivered: string[] = [];
  const emitter = createEmitter({
    url: opts.callbackUrl,
    onDeliveryError: (err: DeliveryError) => { undelivered.push(err.event.id); log(`event not delivered: ${err.message}`); },
  });
  const sent: Promise<void>[] = [];
  let state: JobState = "queued";
  let transitionSeq = 0;
  const enter = (to: JobState, detail: Record<string, unknown> = {}) => {
    const checked = to === "queued" ? {} : transition(state, to, detail);
    state = to;
    transitionSeq++;
    // Delivery runs alongside the job; a slow consumer never holds the seat.
    sent.push(emitter.emit(jobStateEvent({ ...job, transitionSeq }, to, checked)).catch(() => {}));
  };

  enter("queued");
  enter("claimed");

  let interrupted: Ending | undefined;
  let governor: Governor | undefined;
  let pi: PiRpc | undefined;
  let ending: Ending;
  let text: string | null = null;
  try {
    const env = opts.env ?? process.env;
    let stop: (e: Ending) => void = () => {};
    const stopped = new Promise<Ending>((resolve) => (stop = resolve));
    const onAbort = () => { interrupted = { state: "failed", detail: { reason: "interrupted", message: "the runner was interrupted (SIGINT/SIGTERM)" } }; stop(interrupted); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (interrupted) throw new Error("interrupted before Pi started");
    governor = await startGovernor({
      endpoint: readEndpoint(env),
      workerClass,
      priorityHints: env.PLANTWORKS_LLM_PRIORITY === "1", priority: JOB_PRIORITIES[job.priority ?? "normal"], // PW-29: built-in classes have no base
      onFail: (reason) => stop({ state: "failed", detail: { reason, message: "3 consecutive model calls hit the deadline" } }),
    });
    const agentDir = writeSeatFiles({ openrigHome: opts.openrigHome, session: sessionFor(job.jobId), className, governorUrl: governor.url });
    // The lock says a Pi is starting before the spawn, and names its PID as soon as spawn() returns
    // (synchronously), so a runner that dies in between leaves a lock nobody may take over.
    lock.recordPi("starting");
    pi = startPi(opts.piCommand, { cwd: opts.cwd, env: piEnv(env, agentDir) }, log);
    lock.recordPi(pi.pid ?? null);
    await pi.started; // a Pi that cannot start fails the job from `claimed`, never `running`
    if (interrupted) throw new Error("interrupted before the job started running");
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
          const reply = await Promise.race([pi.request({ type: "get_last_assistant_text" }), stopped]);
          if ("state" in reply) ending = reply;
          else {
            text = (reply.data as { text?: string | null } | undefined)?.text ?? null;
            ending = { state: "done", detail: { outcome: "succeeded" } };
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    ending = interrupted ?? { state: "failed", detail: { reason: "error", message: (e as Error).message } };
  } finally {
    // The ending is recorded only after this: Pi's process has been seen to exit (or was SIGKILLed and reaped).
    await pi?.stop();
    await governor?.close();
  }
  if (interrupted) ending = interrupted;

  enter(ending.state, ending.detail);
  await Promise.all(sent);
  return { jobId: job.jobId, state: ending.state, detail: ending.detail as TransitionDetail, text, undelivered };
}

/**
 * Pi, and every command its model runs, sees only this environment: the basics a shell needs,
 * Pi's own PI_* settings, and the seat directory. Never the endpoint URL, its key or the
 * callback, so a model-driven command cannot go around the governor.
 */
const PASS_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR|TZ|PI_[A-Z0-9_]+)$/;
export function piEnv(env: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (PASS_ENV.test(k)) out[k] = v;
  // Fully local: no model catalog refresh, version check or telemetry from the seat.
  return { ...out, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
}

// --- Pi RPC client: just what one job needs -------------------------------------------------

type Response = { type: "response"; id?: string; command: string; success: boolean; error?: string; data?: unknown };
type Settled = { lastStopReason?: string; lastError?: string };

interface PiRpc {
  /** Resolves once the process is running; rejects if it could not start. */
  started: Promise<void>;
  pid: number | undefined;
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
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (err) => reject(new Error(`pi could not start: ${err.message}`)));
  });
  started.catch(() => {});
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
    pid: child.pid,
    request(cmd) {
      const id = `pw-${++nextId}`;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin!.write(`${JSON.stringify({ id, ...cmd })}\n`);
      });
    },
    started,
    settled,
    exited,
    // Abort first: Pi's tools run in their own process groups, and only Pi's own abort path kills
    // them. Then ask Pi to exit (stdin closed), then SIGTERM, then SIGKILL.
    // ponytail: a Pi that ignores all of this is SIGKILLed and cannot clean up its tool processes;
    // in-cluster the worker pod's boundary does. On a host, Phase 0 runs one job at a time.
    async stop() {
      const alive = () => child.exitCode === null && child.signalCode === null;
      const within = (ms: number, p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
      if (!alive()) return;
      await within(3000, this.request({ type: "abort" }));
      child.stdin!.end();
      if (await within(5000, exited)) return;
      child.kill("SIGTERM");
      if (await within(2000, exited)) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}

// --- PW-13: the host's single-job lock --------------------------------------------------------

/**
 * The held lock: `recordPi` records "starting" just before Pi is spawned and its PID (or null, when
 * the spawn failed) right after; `release` removes the lock if it is still ours.
 */
export interface JobLock { recordPi(pid: number | "starting" | null): void; release(): void }
type LockRecord = { runner: number; pi: number | "starting" | null; token: string; since: string };

/** What an operator does about a lock the runner won't take over. Pi runs as `pi --mode rpc --no-session`. */
// The path is given as data (JSON-quoted), not as a shell command, so any characters in a configured
// PLANTWORKS_JOB_LOCK are shown exactly and nothing here is meant to be pasted into a shell.
const CLEAR_LOCK = (path: string) => `To clear it: check that no runner Pi is left (pgrep -af -- '--mode rpc --no-session' prints nothing, or only Pis you can account for; stop any stray one), then delete exactly this lock file: ${JSON.stringify(path)}`;

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * Takes `path` with an exclusive create, or throws RejectedJob. Fail-closed: a lock is stale, and
 * replaced, only when the runner and the Pi it records are both gone; a lock that can't be read or
 * parsed is refused and left in place, since nothing proves its job stopped.
 */
export function takeJobLock(path: string, now = () => new Date()): JobLock {
  mkdirSync(dirname(path), { recursive: true });
  const mine: LockRecord = { runner: process.pid, pi: null, token: randomBytes(8).toString("hex"), since: now().toISOString() };
  const write = (target: string, flag?: string) => {
    const fd = openSync(target, flag ?? "w");
    try { writeFileSync(fd, `${JSON.stringify(mine)}\n`); } finally { closeSync(fd); }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      write(path, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new RejectedJob(`another job took ${path} while this one was starting`);
        throw e;
      }
    }
    let raw: string;
    let held: LockRecord;
    try {
      raw = readFileSync(path, "utf8");
      held = JSON.parse(raw);
      if (!Number.isInteger(held.runner) || (held.pi !== null && held.pi !== "starting" && !Number.isInteger(held.pi))) throw new Error("not a lock record");
    } catch (e) {
      throw new RejectedJob(`${path} exists but can't be read as a job lock (${(e as Error).message}); refusing to run. ${CLEAR_LOCK(path)}`);
    }
    if (held.pi === "starting" && !alive(held.runner)) throw new RejectedJob(`${path}: runner ${held.runner} died while starting Pi, so a Pi may still be running unrecorded; refusing to run. ${CLEAR_LOCK(path)}`);
    if (alive(held.runner) || (typeof held.pi === "number" && alive(held.pi))) throw new RejectedJob(`one job at a time on this host: ${path} is held by runner ${held.runner}${typeof held.pi === "number" ? ` and Pi ${held.pi}` : ""} since ${held.since}`);
    // Stale: move it aside, then make sure what moved is the lock we judged stale, not one just taken.
    const aside = `${path}.stale.${process.pid}.${mine.token}`;
    renameSync(path, aside);
    if (readFileSync(aside, "utf8") !== raw) {
      // ponytail: a second runner replaced the stale lock between our read and rename; put its lock back and stand down.
      try { linkSync(aside, path); } catch { /* it has already been replaced again */ }
      unlinkSync(aside);
      throw new RejectedJob(`another job took ${path} while this one was starting`);
    }
    unlinkSync(aside);
  }
  const ours = () => { try { return (JSON.parse(readFileSync(path, "utf8")) as LockRecord).token === mine.token; } catch { return false; } };
  return {
    recordPi(pid) {
      if (!ours()) return;
      mine.pi = pid;
      const tmp = `${path}.${mine.token}.tmp`;
      write(tmp);
      renameSync(tmp, path);
    },
    release() { if (ours()) unlinkSync(path); },
  };
}
