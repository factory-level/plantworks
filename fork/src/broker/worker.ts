// SPDX-License-Identifier: Apache-2.0
import type { Command } from "commander";
import { classFromSpec } from "../llm/classes.ts";
import { readEndpoint } from "../llm/endpoint.ts";
import { startGovernor, type Governor } from "../llm/governor.ts";
import { writeSeatFiles } from "../seat/pi-seat-files.ts";
import { loadPlatform } from "../team/command.ts";
import { loadTeams } from "./server.ts";

/** The seat's governor port: loopback, next to the broker (7534). Fixed, so a restarted worker keeps the seat's baseUrl valid. */
export const GOVERNOR_PORT = 7535;

/**
 * PW-11/PW-12 in the worker path: the seat's call governor, with the limits of the team spec class
 * this worker serves (`perCall` and `context`), and the seat's Pi files pointing at it. The daemon's
 * Pi seat reads them from $OPENRIG_HOME/state/pi/<seat>/agent when it launches, so the worker must
 * start before the seat does. Pi never sees the endpoint or its key; the governor adds the key.
 */
export async function governSeat(opts: { team: string; seat: string; class?: string; teamsDir?: string; platform?: string; port: number; openrigHome?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }): Promise<{ governor: Governor; agentDir: string; className: string }> {
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
    // ponytail: reported only; the job's broker state is not changed from here (fail-closed, PW-19).
    onFail: (reason) => log(`plantworks worker: ${opts.seat} hit ${reason} (consecutive model calls cut at the ${workerClass.deadlineSeconds}s deadline); the broker job is left as it is`),
  });
  try {
    const agentDir = writeSeatFiles({ openrigHome: opts.openrigHome, session: opts.seat, className, governorUrl: governor.url, workerClass });
    return { governor, agentDir, className };
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
      const { governor, agentDir, className } = await governSeat({ team: opts.team, seat: opts.seat, class: opts.class, teamsDir: opts.teams ?? process.env.PLANTWORKS_TEAMS_DIR, platform: opts.platform ?? process.env.PLANTWORKS_PLATFORM_FILE, port, openrigHome: process.env.OPENRIG_HOME });
      process.stdout.write(`${opts.seat}: class ${className} governed at ${governor.url}; Pi files in ${agentDir}\n`);
      try {
        // PW-22: a (re)started worker resumes its own seat, and only that seat, if a previous pod drained it.
        const resumed = await fetch(`${base}/plantworks/v1/seats/${encodeURIComponent(opts.seat)}/drain`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
        if (resumed instanceof Error || !resumed.ok) process.stderr.write(`could not resume ${opts.seat} (${resumed instanceof Error ? resumed.message : resumed.status}); claim-next will say if it is still draining\n`);
        let stopping = false;
        process.once("SIGINT", () => { stopping = true; });
        process.once("SIGTERM", () => { stopping = true; });
        const sleep = () => new Promise((resolve) => setTimeout(resolve, pollMs));
        while (!stopping) {
          const claim = await fetch(`${base}/plantworks/v1/claim-next`, { method: "POST", headers, body: JSON.stringify({ team: opts.team, seat: opts.seat, ...(opts.class ? { class: opts.class } : {}) }), signal: AbortSignal.timeout(15_000) });
          let jobId: string;
          if (claim.status === 503 || claim.status === 409) {
            const body = await claim.json().catch(() => ({})) as { error?: string; jobId?: string };
            if ((body.error === "handoff_unconfirmed" || body.error === "reservation_lost") && body.jobId) jobId = body.jobId;
            else { await sleep(); continue; }
          } else if (claim.status === 204 || claim.status === 429) { await sleep(); continue; }
          else if (!claim.ok) throw new Error(`claim-next returned ${claim.status}: ${(await claim.text()).slice(0, 300)}`);
          else jobId = (await claim.json() as { job: { jobId: string } }).job.jobId;
          process.stdout.write(`waiting for broker completion of ${jobId}\n`);
          while (!stopping) {
            await sleep();
            const status = await fetch(`${base}/plantworks/v1/jobs/${encodeURIComponent(jobId)}`, { headers, signal: AbortSignal.timeout(15_000) });
            if (!status.ok) continue; // broker/daemon uncertainty keeps this worker from taking another job
            const record = await status.json() as { state: string };
            if (record.state === "done") break;
          }
        }
      } finally {
        // Pi's model calls stop working with the governor: none goes to the endpoint ungoverned.
        await governor.close();
      }
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
