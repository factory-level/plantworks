// SPDX-License-Identifier: Apache-2.0
import type { Command } from "commander";
import { JOB_PRIORITIES, type JobPriority } from "../contract/job.ts";
import { classFromSpec } from "../llm/classes.ts";
import { readEndpoint } from "../llm/endpoint.ts";
import { startGovernor, type Governor } from "../llm/governor.ts";
import { writeSeatFiles } from "../seat/pi-seat-files.ts";
import { loadPlatform } from "../team/command.ts";
import { seatLiveness } from "../seat/liveness.ts";
import { loadTeams } from "./server.ts";
import { promptFileProblem, report, take, type Take } from "./report.ts";

/** The seat's governor port: loopback, next to the broker (7534). Fixed, so a restarted worker keeps the seat's baseUrl valid. */
export const GOVERNOR_PORT = 7535;

/**
 * PW-11/PW-12 in the worker path: the seat's call governor, with the limits of the team spec class
 * this worker serves (`perCall` and `context`), and the seat's Pi files pointing at it. The daemon's
 * Pi seat reads them from $OPENRIG_HOME/state/pi/<seat>/agent when it launches, so the worker must
 * start before the seat does. Pi never sees the endpoint or its key; the governor adds the key.
 */
export async function governSeat(opts: { team: string; seat: string; class?: string; teamsDir?: string; platform?: string; port: number; openrigHome?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }): Promise<{ governor: Governor; agentDir: string; className: string; timeoutSeconds: number }> {
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  if (!opts.teamsDir) throw new Error("no team specs: pass --teams or set PLANTWORKS_TEAMS_DIR");
  if (!opts.openrigHome) throw new Error("OPENRIG_HOME is not set, so the seat's Pi directory is unknown");
  const spec = loadTeams(opts.teamsDir, loadPlatform(opts.platform)).get(opts.team);
  if (!spec) throw new Error(`no team spec for ${opts.team} under ${opts.teamsDir}`);
  const className = opts.class ?? spec.defaultClass;
  if (!Object.hasOwn(spec.classes, className)) throw new Error(`team ${opts.team} has no class ${className}`);
  const workerClass = classFromSpec(spec.classes[className]!);
  const governor = await startGovernor({
    endpoint: readEndpoint(opts.env ?? process.env),
    workerClass,
    port: opts.port,
    // PW-29: opt-in, for a vLLM served with --scheduling-policy priority.
    priorityHints: (opts.env ?? process.env).PLANTWORKS_LLM_PRIORITY === "1",
    // W4-A: with a workspace, no model call goes out before the job's baselines are taken.
    holdUntilArmed: spec.classes[className]!.workspace !== undefined,
    // ponytail: reported only; the job's broker state is not changed from here (fail-closed, PW-19).
    onFail: (reason) => log(`plantworks worker: ${opts.seat} hit ${reason} (consecutive model calls cut at the ${workerClass.deadlineSeconds}s deadline); the broker job is left as it is`),
  });
  try {
    const agentDir = writeSeatFiles({ openrigHome: opts.openrigHome, session: opts.seat, className, governorUrl: governor.url, workerClass, toolProfile: spec.classes[className]!.toolProfile });
    return { governor, agentDir, className, timeoutSeconds: spec.classes[className]!.timeoutSeconds, classPriority: spec.classes[className]!.priority ?? 0, workspace: spec.classes[className]!.workspace };
  } catch (e) {
    await governor.close();
    throw e;
  }
}

/** One seat loop: claim one daemon-backed job and wait for broker reconciliation before claiming again. */
export function workerVerb(pw: Command): void {
  const worker = pw.command("worker").description("Run a Plantworks broker worker loop");
  worker.command("run")
    .requiredOption("--team <team>")
    .requiredOption("--seat <session>")
    .option("--class <class>")
    .option("--broker <url>", "broker URL", process.env.PLANTWORKS_BROKER_URL ?? "http://127.0.0.1:7534")
    .option("--poll-ms <ms>", "poll interval", "2000")
    .option("--teams <dir>", "directory of emitted <team>/team.json (default: $PLANTWORKS_TEAMS_DIR)")
    .option("--platform <file>", "platform file the team spec is validated against (default: $PLANTWORKS_PLATFORM_FILE)")
    .option("--governor-port <port>", "the seat's call governor port, on 127.0.0.1", process.env.PLANTWORKS_GOVERNOR_PORT ?? String(GOVERNOR_PORT))
    .action(async (opts: { team: string; seat: string; class?: string; broker: string; pollMs: string; teams?: string; platform?: string; governorPort: string }) => {
      const base = opts.broker.replace(/\/+$/, "");
      const headers = { "content-type": "application/json", ...(process.env.PLANTWORKS_BROKER_TOKEN ? { authorization: `Bearer ${process.env.PLANTWORKS_BROKER_TOKEN}` } : {}) };
      const pollMs = Number(opts.pollMs);
      if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error("--poll-ms must be 250..60000");
      const port = Number(opts.governorPort);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--governor-port must be 0..65535");
      const { governor, agentDir, className, timeoutSeconds, classPriority, workspace } = await governSeat({ team: opts.team, seat: opts.seat, class: opts.class, teamsDir: opts.teams ?? process.env.PLANTWORKS_TEAMS_DIR, platform: opts.platform ?? process.env.PLANTWORKS_PLATFORM_FILE, port, openrigHome: process.env.OPENRIG_HOME });
      process.stdout.write(`${opts.seat}: class ${className} governed at ${governor.url}; Pi files in ${agentDir}\n`);
      let stopping = false;
      process.once("SIGINT", () => { stopping = true; });
      process.once("SIGTERM", () => { stopping = true; });
      const sleep = () => new Promise((resolve) => setTimeout(resolve, pollMs));
      const seatUrl = `${base}/plantworks/v1/seats/${encodeURIComponent(opts.seat)}/drain`;

      /**
       * Waits until the broker records the job `done`, the only state reconciliation reaches from the
       * seat's own authenticated closure; nothing else lets this seat take its next job. At the
       * timeout the governor cuts off the seat's model calls. That stops no tool or process, so the
       * job and its slot stay held and the wait goes on.
       */
      /**
       * A job's stored effective priority from the broker. A failed or unreadable answer is asked
       * again (held calls stay held meanwhile); only a record without one, from a broker that
       * predates the field, falls back to the class base.
       */
      const storedPriority = async (jobId: string): Promise<number> => {
        while (!stopping) {
          const res = await fetch(`${base}/plantworks/v1/jobs/${encodeURIComponent(jobId)}`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
          const record = res?.ok ? await res.json().catch(() => null) as { priority?: unknown } | null : null;
          if (record && typeof record === "object") return typeof record.priority === "number" ? record.priority : classPriority;
          await sleep();
        }
        return classPriority;
      };
      /**
       * W4-A: once the seat has closed the job, the broker asks for the job's report (reportWanted on
       * the record). It is sent once: 200 stored; any 409 is final; a 404 means a broker without the
       * report route, which still finishes the job at its bound; anything else is asked again.
       */
      const sendReport = async (t: Take, wanted: { closingTransitionId: number; qitemId: string }): Promise<boolean> => {
        const body = { seat: opts.seat, qitemId: wanted.qitemId, closingTransitionId: wanted.closingTransitionId, ...(await report(t, governor.usage(), workspace)) };
        const res = await fetch(`${base}/plantworks/v1/jobs/${encodeURIComponent(t.jobId)}/report`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (!res) return false;
        if (res.ok || res.status === 409) return true;
        if (res.status === 404) { process.stderr.write(`plantworks worker: the broker has no report route; ${t.jobId} finishes without usage or artifacts\n`); return true; }
        return false;
      };
      const waitForDone = async (jobId: string, timeoutS: number, t?: Take) => {
        process.stdout.write(`waiting for broker completion of ${jobId}\n`);
        let reported = false;
        const timer = setTimeout(() => {
          governor.cutOff(`${jobId} passed its ${timeoutS}s timeout`);
          process.stderr.write(`plantworks worker: ${jobId} passed its ${timeoutS}s timeout; the seat's model calls are cut off. Pi and its tools may still be running, so the job and its slot stay held until the seat closes it\n`);
        }, timeoutS * 1000);
        let noted = "";
        try {
          while (!stopping) {
            await sleep();
            const status = await fetch(`${base}/plantworks/v1/jobs/${encodeURIComponent(jobId)}`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
            if (!status?.ok) continue; // broker/daemon uncertainty keeps this worker from taking another job
            const record = await status.json() as { state: string; reportWanted?: { closingTransitionId?: unknown; qitemId?: unknown } };
            if (record.state === "done") return;
            const wanted = record.reportWanted;
            if (t && !reported && wanted && Number.isInteger(wanted.closingTransitionId) && typeof wanted.qitemId === "string") {
              reported = await sendReport(t, wanted as { closingTransitionId: number; qitemId: string });
            }
            if (["failed", "cancelled", "retried"].includes(record.state) && noted !== record.state) {
              noted = record.state;
              process.stderr.write(`plantworks worker: ${jobId} is ${record.state} in the broker, which isn't the seat's completion; ${opts.seat} takes no next job\n`);
            }
          }
        } finally {
          clearTimeout(timer);
          governor.restore();
        }
      };

      try {
        // PW-22: a (re)started worker resumes its own seat, and only that seat, if a previous pod drained it.
        const resumed = await fetch(seatUrl, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
        if (resumed instanceof Error || !resumed.ok) process.stderr.write(`could not resume ${opts.seat} (${resumed instanceof Error ? resumed.message : resumed.status}); claim-next will say if it is still draining\n`);
        // A restarted worker first waits on whatever its seat still holds in the broker (claimed,
        // running, or queued under its reservation), so a restart can't skip past held work. No
        // answer means no claim: it asks again.
        let held: string[] | undefined;
        while (!stopping && !held) {
          const view = await fetch(seatUrl, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
          const answer = view?.ok ? await view.json().catch(() => null) as { inFlight?: unknown } | null : null;
          if (Array.isArray(answer?.inFlight) && answer.inFlight.every((j) => typeof j === "string")) held = answer.inFlight as string[];
          else { process.stderr.write(`plantworks worker: cannot read what ${opts.seat} holds (${view?.status ?? "no answer"}); not claiming\n`); await sleep(); }
        }
        // The timer starts now, not at the job's claim, so a cut-off after a restart comes late, never early.
        // PW-29: a held job's envelope isn't at hand; its stored priority comes from the broker.
        // W4-A: baselines first, then the governor is armed (priority, then the workspace hold), so no
        // model reply can come before them. A held job wasn't seen to start, so it has none.
        const takeUp = (jobId: string, recovered: boolean) => take(jobId, governor.usage(), { recovered, workspace, openrigHome: process.env.OPENRIG_HOME!, seat: opts.seat });
        const settle = () => { governor.setPriority(undefined); governor.setArmed(false); };
        for (const jobId of held ?? []) {
          if (stopping) break;
          const t = takeUp(jobId, true);
          governor.setPriority(await storedPriority(jobId));
          governor.setArmed(true);
          await waitForDone(jobId, timeoutSeconds, t);
          settle();
        }
        while (!stopping) {
          // PW-12 (broker half): checked before every claim, never after one, since a claim wakes Pi.
          const refused = workspace ? promptFileProblem(workspace) : undefined;
          if (refused) { process.stderr.write(`plantworks worker: ${opts.seat}: ${refused}\n`); await sleep(); continue; }
          const claim = await fetch(`${base}/plantworks/v1/claim-next`, { method: "POST", headers, body: JSON.stringify({ team: opts.team, seat: opts.seat, ...(opts.class ? { class: opts.class } : {}) }), signal: AbortSignal.timeout(15_000) });
          let jobId: string;
          let timeoutS = timeoutSeconds;
          let t: Take;
          if (claim.status === 503 || claim.status === 409) {
            const body = await claim.json().catch(() => ({})) as { error?: string; jobId?: string };
            if ((body.error === "handoff_unconfirmed" || body.error === "reservation_lost") && body.jobId) {
              jobId = body.jobId;
              t = takeUp(jobId, false);
              governor.setPriority(await storedPriority(jobId)); // no envelope in this answer: ask the broker
            }
            else { await sleep(); continue; }
          } else if (claim.status === 204 || claim.status === 429) { await sleep(); continue; }
          else if (!claim.ok) throw new Error(`claim-next returned ${claim.status}: ${(await claim.text()).slice(0, 300)}`);
          else {
            const claimed = await claim.json() as { job: { jobId: string; priority?: number }; envelope?: { timeoutSeconds?: number; priority?: JobPriority } };
            jobId = claimed.job.jobId;
            timeoutS = claimed.envelope?.timeoutSeconds ?? timeoutSeconds;
            t = takeUp(jobId, false);
            // PW-29: the same effective priority the broker ordered the claim by. The seat runs one job at a time.
            governor.setPriority(typeof claimed.job.priority === "number" ? claimed.job.priority : classPriority + JOB_PRIORITIES[claimed.envelope?.priority ?? "normal"]);
          }
          governor.setArmed(true);
          await waitForDone(jobId, timeoutS, t);
          settle();
        }
      } finally {
        // Pi's model calls stop working with the governor: none goes to the endpoint ungoverned.
        await governor.close();
      }
    });

  // PW-22: the liveness probe, from the seat's runner-state.json. Only a recorded Pi exit fails it.
  worker.command("live")
    .description("Is the seat's Pi alive, by its runner-state.json? Exit 1 only when the runner recorded that Pi exited; starting or unreadable state is not a failure")
    .requiredOption("--seat <session>")
    .action((opts: { seat: string }) => {
      if (!process.env.OPENRIG_HOME) throw new Error("OPENRIG_HOME is not set, so the seat's state directory is unknown");
      const { verdict, detail } = seatLiveness(process.env.OPENRIG_HOME, opts.seat);
      process.stdout.write(`${opts.seat}: ${verdict}: ${detail}\n`);
      // Nothing here touches the broker: a dead Pi frees no slot and fails no job.
      if (verdict === "exited") process.exitCode = 1;
    });

  // PW-22: the preStop hook. Stops new work for the seat, then waits for what it still holds.
  worker.command("drain")
    .description("Stop new work for a seat and wait for its in-flight jobs. Exit 0 when drained, 3 on timeout, 4 if another worker resumed the seat")
    .requiredOption("--seat <session>")
    .option("--broker <url>", "broker URL", process.env.PLANTWORKS_BROKER_URL ?? "http://127.0.0.1:7534")
    .option("--timeout-s <s>", "how long to wait for in-flight jobs", "300")
    .option("--poll-ms <ms>", "poll interval", "2000")
    .action(async (opts: { seat: string; broker: string; timeoutS: string; pollMs: string }) => {
      const url = `${opts.broker.replace(/\/+$/, "")}/plantworks/v1/seats/${encodeURIComponent(opts.seat)}/drain`;
      const headers = process.env.PLANTWORKS_BROKER_TOKEN ? { authorization: `Bearer ${process.env.PLANTWORKS_BROKER_TOKEN}` } : {};
      const timeoutS = Number(opts.timeoutS);
      const pollMs = Number(opts.pollMs);
      if (!Number.isInteger(timeoutS) || timeoutS < 0) throw new Error("--timeout-s must be a whole number of seconds");
      if (!Number.isInteger(pollMs) || pollMs < 50 || pollMs > 60_000) throw new Error("--poll-ms must be 50..60000");
      const deadline = Date.now() + timeoutS * 1000;
      const res = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`drain ${opts.seat}: broker returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      let view = await res.json() as { draining: boolean; inFlight: string[] };
      while (view.draining && view.inFlight.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        // An unreachable or failing broker leaves the last answer standing: still in flight.
        const poll = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (poll?.ok) view = await poll.json() as { draining: boolean; inFlight: string[] };
      }
      if (!view.draining) {
        // A `worker run` on the same seat name resumed it: the seat takes work again, so this drain is void.
        process.stderr.write(`${opts.seat}: the drain was ended by another worker resuming this seat (one worker process per seat name); in flight: ${view.inFlight.join(", ") || "none"}\n`);
        process.exitCode = 4;
        return;
      }
      if (!view.inFlight.length) {
        process.stdout.write(`${opts.seat} drained: no jobs in flight\n`);
        return;
      }
      // Nothing here stops, fails or releases the work: the broker still tracks it, and reconciliation settles it.
      process.stderr.write(`${opts.seat}: in-flight work unresolved after ${timeoutS}s (${view.inFlight.join(", ")}); the broker still reports the seat draining, and the timeout does not prove execution stopped\n`);
      process.exitCode = 3;
    });
}
