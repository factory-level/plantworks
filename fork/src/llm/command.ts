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
    .option("--class <name>", `without team specs: the built-in worker class (${Object.keys(CLASSES).join(", ")})`, DEFAULT_CLASS)
    .option("--json", "JSON output")
    .action(async (opts: { teams?: string; platform?: string; class: string; json?: boolean }) => {
      const dir = opts.teams ?? (process.env.PLANTWORKS_TEAMS_DIR?.trim() || undefined);
      let need: string[];
      try {
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
