// SPDX-License-Identifier: Apache-2.0
// The fork's CLI: upstream's whole `rig` program, renamed, plus one namespace for fork verbs.
// Upstream commands stay upstream's; fork verbs never sit at the top level, so a command
// upstream adds later cannot collide with one of ours.
import type { Command, Option } from "commander";
import { createProgram } from "../../../packages/cli/dist/index.js";

/** Every product name the CLI uses. A rename (PW-07) changes this table and fork/package.json `bin`. */
export const NAMES = { bin: "plantworks", alias: "pwctl", namespace: "pw" } as const;

/** The fork's own release counter, bumped by hand when the fork ships changes on the same upstream version. */
export const PLANTWORKS_RELEASE = 1;

/** `0.7.0` -> `0.7.0+plantworks.1`: upstream's version, then the fork's, as semver build metadata. */
export const brandedVersion = (upstream: string) => `${upstream}+plantworks.${PLANTWORKS_RELEASE}`;

/** Fork verbs register here, for example `pw job run` (PW-13). */
export type ForkVerb = (pw: Command) => void;

export function createPlantworksProgram(verbs: ForkVerb[] = [], upstream: () => Command = createProgram): Command {
  const program = upstream().name(NAMES.bin);
  // Commander can't change a registered version, so drop upstream's -V/--version option and its handler first.
  const version = program.version();
  if (version) {
    const options = program.options as Option[];
    const at = options.findIndex((o) => o.long === "--version");
    if (at >= 0) options.splice(at, 1);
    program.removeAllListeners("option:version");
    program.version(brandedVersion(version));
  }
  if (program.commands.some((c) => c.name() === NAMES.namespace || c.aliases().includes(NAMES.namespace))) {
    throw new Error(`upstream now has a top-level "${NAMES.namespace}" command; rename the fork namespace in NAMES`);
  }
  const pw = program
    .command(NAMES.namespace)
    .description(`${NAMES.bin} fork commands (everything else is upstream OpenRig)`)
    .action(() => pw.help());
  for (const add of verbs) add(pw);
  return program;
}
