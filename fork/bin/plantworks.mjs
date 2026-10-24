#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The `plantworks` and `pwctl` binaries. Needs the upstream CLI built (`npm run build` at the root).
// ponytail: always loads the full upstream program (no lazy per-command fast path like `rig`'s
// bin-wrapper); add one if startup time matters for seats calling this in a loop.
import { runProgram } from "../../packages/cli/dist/index.js";
import { createPlantworksProgram } from "../src/cli/program.ts";
import { jobVerb } from "../src/job/command.ts";
import { llmVerb } from "../src/llm/command.ts";

// A command may set process.exitCode itself (for example a failed preflight); keep it.
const code = await runProgram(createPlantworksProgram([llmVerb, jobVerb]), process.argv);
process.exitCode = process.exitCode || code;
