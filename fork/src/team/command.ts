// SPDX-License-Identifier: Apache-2.0
// `plantworks pw team emit` and `plantworks pw team validate`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { PHASE_0_1, buildSpec, hermesProfileConfig, validatePlatform, validateSpec, type Platform, type TeamSpec } from "./spec.ts";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

function loadPlatform(path?: string): Platform {
  if (!path) return PHASE_0_1;
  const p = readJson(path);
  const errors = validatePlatform(p);
  if (errors.length) throw new Error(`${path}: ${errors.join("; ")}`);
  return p as Platform;
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Writes <out>/<team>/team.json and <out>/<team>/hermes-profile/config.yaml, or nothing if the spec is invalid. */
export function emitTeam(definition: unknown, outDir: string, platform: Platform = PHASE_0_1): { files: string[] } | { errors: string[] } {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) return { errors: ["team definition must be an object"] };
  if ("hermesProfile" in definition) return { errors: ["hermesProfile is derived from the team; leave it out of the definition"] };
  const spec = buildSpec(definition as Record<string, unknown>);
  const errors = validateSpec(spec, platform);
  if (errors.length) return { errors };
  const dir = join(outDir, (spec as unknown as TeamSpec).team);
  mkdirSync(join(dir, "hermes-profile"), { recursive: true });
  const files = [join(dir, "team.json"), join(dir, "hermes-profile", "config.yaml")];
  writeAtomic(files[0], `${JSON.stringify(spec, null, 2)}\n`);
  writeAtomic(files[1], hermesProfileConfig(spec as unknown as TeamSpec));
  return { files };
}

export function teamVerb(pw: Command): void {
  const team = pw.command("team").description("Team spec: the contract the platform reads (ADR 0204)");
  team
    .command("emit")
    .description("Validate a team definition (JSON) and write its team spec and Hermes profile file")
    .argument("<definition>", "team definition JSON file")
    .requiredOption("--out <dir>", "output directory")
    .option("--platform <file>", "platform limits JSON (slot caps, served models, context maximum); default Phase 0–1 with no slot caps")
    .action((definition: string, opts: { out: string; platform?: string }) => {
      const result = emitTeam(readJson(definition), opts.out, loadPlatform(opts.platform));
      if ("errors" in result) {
        console.error(`invalid team definition:\n  ${result.errors.join("\n  ")}`);
        process.exitCode = 1;
      } else console.log(result.files.join("\n"));
    });
  team
    .command("validate")
    .description("Check an emitted team spec against the validator rules")
    .argument("<spec>", "team spec JSON file")
    .option("--platform <file>", "platform limits JSON")
    .action((spec: string, opts: { platform?: string }) => {
      const errors = validateSpec(readJson(spec), loadPlatform(opts.platform));
      if (errors.length) {
        console.error(`invalid team spec:\n  ${errors.join("\n  ")}`);
        process.exitCode = 1;
      } else console.log("team spec ok");
    });
}
