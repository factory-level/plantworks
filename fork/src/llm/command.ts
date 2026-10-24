// SPDX-License-Identifier: Apache-2.0
// `plantworks pw llm preflight`: is PLANTWORKS_LLM_URL reachable, and does it serve the class model?
import type { Command } from "commander";
import { CLASSES, DEFAULT_CLASS, classByName } from "./classes.ts";
import { preflight, readEndpoint } from "./endpoint.ts";

export function llmVerb(pw: Command): void {
  const llm = pw.command("llm").description("The one OpenAI-compatible endpoint (PLANTWORKS_LLM_URL)");
  llm
    .command("preflight")
    .description("Check the endpoint answers GET /models and serves the class model (no inference call)")
    .option("--class <name>", `worker class (${Object.keys(CLASSES).join(", ")})`, DEFAULT_CLASS)
    .option("--json", "JSON output")
    .action(async (opts: { class: string; json?: boolean }) => {
      const result = await preflight(readEndpoint(), [classByName(opts.class).model]);
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(result.ok ? `ok: ${result.url} serves ${classByName(opts.class).model}` : `failed: ${result.url}: ${result.error}`);
      if (!result.ok) process.exitCode = 1;
    });
}
