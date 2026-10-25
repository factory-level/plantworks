// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sealedEnv } from "../test-support/sealed-env.ts";
import { Command } from "commander";
import { NAMES, PLANTWORKS_RELEASE, brandedVersion, createPlantworksProgram } from "./program.ts";

const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
const run = (...args: string[]) => execFileSync(process.execPath, [bin, ...args], { env: sealedEnv(), encoding: "utf8" });

test("adds the fork namespace on top of upstream and registers fork verbs under it", () => {
  const upstream = () => new Command("rig").addCommand(new Command("queue"));
  const program = createPlantworksProgram([(pw) => pw.command("job")], upstream);
  assert.equal(program.name(), "plantworks");
  assert.deepEqual(program.commands.map((c) => c.name()), ["queue", "pw"]);
  assert.deepEqual(program.commands[1].commands.map((c) => c.name()), ["job"]);
});

test("the version is upstream's, branded with the fork release; a program without one gets none", () => {
  const program = createPlantworksProgram([], () => new Command("rig").version("9.8.7"));
  assert.equal(program.version(), "9.8.7+plantworks." + PLANTWORKS_RELEASE);
  assert.equal(program.options.filter((o) => o.long === "--version").length, 1, "one version option, not two");
  assert.equal(brandedVersion("0.7.0"), `0.7.0+plantworks.${PLANTWORKS_RELEASE}`);
  assert.equal(createPlantworksProgram([], () => new Command("rig")).version(), undefined);
});

test("refuses to start when upstream takes the namespace, by name or alias", () => {
  for (const taken of [new Command("pw"), new Command("pipe").alias("pw")]) {
    assert.throws(() => createPlantworksProgram([], () => new Command("rig").addCommand(taken)), /top-level "pw"/);
  }
});

test("the real binary runs upstream commands and the pw namespace", () => {
  const help = run("--help");
  assert.match(help, /Usage: plantworks/);
  assert.match(help, /^\s+queue\b/m);
  assert.match(help, /^\s+fork\b/m, "upstream's own `fork` command is untouched");
  assert.match(help, /^\s+pw\b/m);
  assert.match(run("queue", "--help"), /Usage: plantworks queue/);
  assert.match(run("pw", "--help"), /Usage: plantworks pw/);
  const upstreamVersion = JSON.parse(readFileSync(new URL("../../../packages/cli/package.json", import.meta.url), "utf8")).version;
  assert.equal(run("--version").trim(), `${upstreamVersion}+plantworks.${PLANTWORKS_RELEASE}`);
  assert.equal(run("-V").trim(), `${upstreamVersion}+plantworks.${PLANTWORKS_RELEASE}`);
});

test("plantworks and pwctl are the same binary", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.bin, { [NAMES.bin]: "bin/plantworks.mjs", [NAMES.alias]: "bin/plantworks.mjs" });
});
