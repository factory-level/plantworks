#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The `plantworks` and `pwctl` binaries. Needs the upstream CLI built (`npm run build` at the root).
// ponytail: always loads the full upstream program (no lazy per-command fast path like `rig`'s
// bin-wrapper); add one if startup time matters for seats calling this in a loop.
import { applyDaemonDefaults, applyHomeDefaults } from "../src/daemon/boot.ts";

// Upstream modules read OPENRIG_HOME when they load, so they are imported only after this.
const dropped = applyHomeDefaults(process.env);
if (dropped.length) console.error(`plantworks: PLANTWORKS_HOME is set, so the inherited ${dropped.join(", ")} (another daemon's) are ignored`);
const { ConfigStore } = await import("../../packages/cli/dist/config-store.js");
const store = new ConfigStore();
const fromFile = (key) => {
  const r = store.resolveWithSource(key);
  return r.source === "file" ? r.value : undefined;
};

let refused;
try {
  applyDaemonDefaults(process.env, process.argv, { port: fromFile("daemon.port"), host: fromFile("daemon.host"), dbConflict: fromFile("daemon.db_conflict") });
} catch (e) {
  refused = e;
}
if (refused) {
  console.error(`plantworks: ${refused.message}`);
  process.exitCode = 2;
} else {
  const { runProgram } = await import("../../packages/cli/dist/index.js");
  const { createPlantworksProgram } = await import("../src/cli/program.ts");
  const { jobVerb } = await import("../src/job/command.ts");
  const { llmVerb } = await import("../src/llm/command.ts");
  const { teamVerb } = await import("../src/team/command.ts");
  const { brokerVerb } = await import("../src/broker/command.ts");
  const { workerVerb } = await import("../src/broker/worker.ts");
  const { mcpVerb } = await import("../src/hermes/command.ts");
  const { remoteVerbs } = await import("../src/remote/command.ts");
  // A command may set process.exitCode itself (for example a failed preflight); keep it.
  const code = await runProgram(createPlantworksProgram([llmVerb, jobVerb, teamVerb, brokerVerb, workerVerb, mcpVerb, remoteVerbs]), process.argv);
  process.exitCode = process.exitCode || code;
}
