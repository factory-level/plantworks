// SPDX-License-Identifier: Apache-2.0
// `plantworks pw job run <envelope>`: run one job on one Pi seat, with no daemon (Phase 0).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { RejectedJob, runJob } from "./run.ts";

/** "pi", or a path; a .js/.mjs path runs under this Node. */
export function piCommand(pi: string): string[] {
  return /\.m?js$/.test(pi) ? [process.execPath, pi] : [pi];
}

export function jobVerb(pw: Command): void {
  const job = pw.command("job").description("Run Plantworks jobs");
  job
    .command("run")
    .description("Run one job envelope on one Pi seat, without the daemon (Phase 0). Prints the result as JSON")
    .argument("<envelope>", "path to the job envelope JSON, or - for stdin")
    .option("--callback <url>", "where plantworks.job.state events go (default: $PLANTWORKS_FRONTDOOR_CALLBACK)")
    .option("--cwd <dir>", "Pi's working directory", process.cwd())
    .option("--pi <path>", "Pi binary or cli.js (default: $PLANTWORKS_PI_BIN, else pi)")
    .action(async (path: string, opts: { callback?: string; cwd: string; pi?: string }) => {
      const callbackUrl = opts.callback ?? process.env.PLANTWORKS_FRONTDOOR_CALLBACK;
      try {
        if (!callbackUrl) throw new RejectedJob("no callback: pass --callback or set PLANTWORKS_FRONTDOOR_CALLBACK");
        let envelope: unknown;
        try {
          envelope = JSON.parse(readFileSync(path === "-" ? 0 : path, "utf8"));
        } catch (e) {
          throw new RejectedJob(`cannot read envelope: ${(e as Error).message}`);
        }
        const result = await runJob({
          envelope,
          callbackUrl,
          cwd: opts.cwd,
          openrigHome: process.env.OPENRIG_HOME ?? join(homedir(), ".openrig"),
          piCommand: piCommand(opts.pi ?? process.env.PLANTWORKS_PI_BIN ?? "pi"),
        });
        console.log(JSON.stringify(result));
        process.exitCode = result.state === "done" ? 0 : 1;
      } catch (e) {
        if (e instanceof RejectedJob) {
          console.error(`job rejected: ${e.message}`);
          process.exitCode = 2;
        } else {
          console.error(`runner error: ${(e as Error).stack ?? e}`);
          process.exitCode = 3;
        }
      }
    });
}
