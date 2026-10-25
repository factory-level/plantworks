// SPDX-License-Identifier: Apache-2.0
// `plantworks pw llm preflight`: is PLANTWORKS_LLM_URL reachable, and does it serve the models the workers will call?
// `plantworks pw llm bench` (PW-30): Pi-shaped load at rising concurrency, see bench.ts.
import type { Command } from "commander";
import { loadTeams } from "../broker/server.ts";
import { loadPlatform } from "../team/command.ts";
import { CLASSES, DEFAULT_CLASS, classByName } from "./classes.ts";
import { preflight, readEndpoint } from "./endpoint.ts";
import { checkBenchTarget, runBench } from "./bench.ts";

/** Every model the team specs under `dir` name, across all their classes. The specs load as the broker loads them. */
export function teamModels(dir: string, platformFile?: string): string[] {
  const models = new Set<string>();
  for (const spec of loadTeams(dir, loadPlatform(platformFile)).values()) {
    for (const c of Object.values(spec.classes)) models.add(c.model);
  }
  return [...models].sort();
}

export function llmVerb(pw: Command): void {
  const llm = pw.command("llm").description("The one OpenAI-compatible endpoint (PLANTWORKS_LLM_URL)");
  llm
    .command("preflight")
    .description("Check the endpoint answers GET /models and serves every model the team specs name, or the class model without specs (no inference call)")
    .option("--teams <dir>", "emitted <team>/team.json specs: check every model their classes name (default: $PLANTWORKS_TEAMS_DIR)")
    .option("--platform <file>", "with --teams: the platform file the specs are validated against, as for `pw broker serve`")
    .option("--class <name>", `one built-in worker class instead of team specs; wins over $PLANTWORKS_TEAMS_DIR (${Object.keys(CLASSES).join(", ")})`, DEFAULT_CLASS)
    .option("--json", "JSON output")
    .action(async (opts: { teams?: string; platform?: string; class: string; json?: boolean }, cmd: Command) => {
      // An explicit --class means one class: it wins over $PLANTWORKS_TEAMS_DIR, and can't be combined with --teams.
      const explicitClass = cmd.getOptionValueSource("class") === "cli";
      const dir = opts.teams ?? (explicitClass ? undefined : process.env.PLANTWORKS_TEAMS_DIR?.trim() || undefined);
      let need: string[];
      try {
        if (opts.teams && explicitClass) throw new Error("--class and --teams can't be combined: one checks a single class, the other every model the specs name");
        if (opts.platform && !dir) throw new Error("--platform applies only to team specs: pass --teams or set PLANTWORKS_TEAMS_DIR");
        need = dir ? teamModels(dir, opts.platform) : [classByName(opts.class).model];
      } catch (e) {
        console.error(`preflight: ${(e as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const result = await preflight(readEndpoint(), need);
      if (opts.json) console.log(JSON.stringify({ ...result, checked: need, source: dir ? "teams" : "class" }));
      else console.log(result.ok ? `ok: ${result.url} serves ${need.join(", ")}` : `failed: ${result.url}: ${result.error}`);
      if (!result.ok) process.exitCode = 1;
    });
  llm
    .command("bench")
    .description("Replay synthetic Pi-shaped sessions at rising concurrency; report tokens/s, p50/p95, jobs/hour and the knee. Puts real load on the endpoint")
    .option("--url <url>", "the endpoint to bench (default: $PLANTWORKS_LLM_URL)")
    .option("--model <name>", "model to call (default: the default class's model)")
    .option("--levels <list>", "comma-separated concurrent sessions", "1,2,4,8")
    .option("--sessions <n>", "sessions each concurrent worker runs per level", "3")
    .option("--context <tokens>", "the context window the profiles grow into and compact at", "16384")
    .option("--call-timeout <seconds>", "one call's limit; a call over it fails its session", "300")
    .option("--knee-gain <fraction>", "a step up that adds less output tokens/s than this is past the knee", "0.1")
    .option("--i-have-a-window", "allow a non-loopback endpoint: only inside an agreed quiet window")
    .option("--json", "JSON output")
    .action(async (opts: { url?: string; model?: string; levels: string; sessions: string; context: string; callTimeout: string; kneeGain: string; iHaveAWindow?: boolean; json?: boolean }) => {
      let endpoint;
      const levels = opts.levels.split(",").map(Number);
      const [sessions, window, callTimeout, minGain] = [opts.sessions, opts.context, opts.callTimeout, opts.kneeGain].map(Number);
      try {
        endpoint = readEndpoint(opts.url ? { ...process.env, PLANTWORKS_LLM_URL: opts.url } : process.env);
        if (!levels.every((n) => Number.isInteger(n) && n > 0) || !Number.isInteger(sessions) || sessions < 1 || !(window > 0) || !(callTimeout > 0) || !(minGain >= 0)) {
          throw new Error("--levels, --sessions, --context and --call-timeout take positive numbers (--levels comma-separated integers); --knee-gain takes a fraction >= 0");
        }
        const refused = checkBenchTarget(endpoint.url, Boolean(opts.iHaveAWindow));
        if (refused) throw new Error(refused);
      } catch (e) {
        console.error(`bench: ${(e as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const report = await runBench(endpoint, opts.model ?? classByName(DEFAULT_CLASS).model, { levels, sessions, window, callTimeoutMs: callTimeout * 1000, minGain });
      if (opts.json) console.log(JSON.stringify(report));
      else {
        console.log(`bench ${report.url} model ${report.model}; SYNTHETIC profiles: ${report.profiles.join(", ")}`);
        console.log("conc  calls  err  out tok/s  total tok/s  p50 ms  p95 ms  jobs/h measured  jobs/h estimated");
        for (const l of report.levels) {
          console.log([l.concurrency, l.calls, l.errors, l.outputTokensPerSecond.toFixed(1), l.totalTokensPerSecond.toFixed(1), l.p50Ms.toFixed(0), l.p95Ms.toFixed(0), l.jobsPerHourMeasured.toFixed(0), l.jobsPerHourEstimated.toFixed(0)].join("  "));
          if (l.firstError) console.log(`      first error: ${l.firstError}`);
        }
        console.log(report.knee === null ? "knee: not reached; run higher --levels" : `knee: ${report.knee} concurrent sessions`);
      }
      if (report.levels.some((l) => l.errors)) process.exitCode = 1;
    });
}
