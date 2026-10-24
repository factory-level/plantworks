// SPDX-License-Identifier: Apache-2.0
// `plantworks pw llm preflight`: is PLANTWORKS_LLM_URL reachable, and does it serve the models the workers will call?
import type { Command } from "commander";
import { loadTeams } from "../broker/server.ts";
import { loadPlatform } from "../team/command.ts";
import { CLASSES, DEFAULT_CLASS, classByName } from "./classes.ts";
import { preflight, readEndpoint } from "./endpoint.ts";

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
}
