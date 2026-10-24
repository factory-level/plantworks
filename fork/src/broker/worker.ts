// SPDX-License-Identifier: Apache-2.0
import type { Command } from "commander";
import { seatLiveness } from "../seat/liveness.ts";

/** One seat loop: claim one daemon-backed job and wait for broker reconciliation before claiming again. */
export function workerVerb(pw: Command): void {
  const worker = pw.command("worker").description("Run a Plantworks broker worker loop");
  worker.command("run")
    .requiredOption("--team <team>")
    .requiredOption("--seat <session>")
    .option("--class <class>")
    .option("--broker <url>", "broker URL", process.env.PLANTWORKS_BROKER_URL ?? "http://127.0.0.1:7534")
    .option("--poll-ms <ms>", "poll interval", "2000")
    .action(async (opts: { team: string; seat: string; class?: string; broker: string; pollMs: string }) => {
      const base = opts.broker.replace(/\/+$/, "");
      const headers = { "content-type": "application/json", ...(process.env.PLANTWORKS_BROKER_TOKEN ? { authorization: `Bearer ${process.env.PLANTWORKS_BROKER_TOKEN}` } : {}) };
      const pollMs = Number(opts.pollMs);
      if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60_000) throw new Error("--poll-ms must be 250..60000");
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
