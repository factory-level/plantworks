// SPDX-License-Identifier: Apache-2.0
import type { Command } from "commander";

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
      let stopping = false;
      process.once("SIGINT", () => { stopping = true; });
      process.once("SIGTERM", () => { stopping = true; });
      const sleep = () => new Promise((resolve) => setTimeout(resolve, pollMs));
      while (!stopping) {
        const claim = await fetch(`${base}/plantworks/v1/claim-next`, { method: "POST", headers, body: JSON.stringify({ team: opts.team, seat: opts.seat, ...(opts.class ? { class: opts.class } : {}) }), signal: AbortSignal.timeout(15_000) });
        if (claim.status === 204 || claim.status === 429 || claim.status === 503) { await sleep(); continue; }
        if (!claim.ok) throw new Error(`claim-next returned ${claim.status}: ${(await claim.text()).slice(0, 300)}`);
        const { job } = await claim.json() as { job: { jobId: string } };
        process.stdout.write(`claimed ${job.jobId}; waiting for authenticated daemon completion\n`);
        while (!stopping) {
          await sleep();
          const status = await fetch(`${base}/plantworks/v1/jobs/${encodeURIComponent(job.jobId)}`, { headers, signal: AbortSignal.timeout(15_000) });
          if (!status.ok) continue; // broker/daemon uncertainty keeps this worker from taking another job
          const record = await status.json() as { state: string };
          if (record.state === "done") break;
        }
      }
    });
}
