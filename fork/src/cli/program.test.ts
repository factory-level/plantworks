// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { NAMES, createPlantworksProgram } from "./program.ts";

const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
const run = (...args: string[]) => execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("adds the fork namespace on top of upstream and registers fork verbs under it", () => {
  const upstream = () => new Command("rig").addCommand(new Command("queue"));
  const program = createPlantworksProgram([(pw) => pw.command("job")], upstream);
  assert.equal(program.name(), "plantworks");
  assert.deepEqual(program.commands.map((c) => c.name()), ["queue", "pw"]);
  assert.deepEqual(program.commands[1].commands.map((c) => c.name()), ["job"]);
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
  assert.equal(run("--version").trim(), upstreamVersion);
});

test("plantworks and pwctl are the same binary", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.bin, { [NAMES.bin]: "bin/plantworks.mjs", [NAMES.alias]: "bin/plantworks.mjs" });
});
