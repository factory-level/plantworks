// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProgram } from "../../packages/cli/src/index.ts";
import { COMMAND_LOADERS } from "../../packages/cli/src/lazy-program.ts";
import { parsePiModelsJson } from "../../packages/daemon/src/adapters/pi-readiness.ts";
import { piSeatPinReadings } from "../../packages/daemon/src/domain/model-divergence/effective-model-readers.ts";

test("upstream CLI exposes createProgram and its lazy loader map matches the eager command names", () => {
  const program = createProgram();
  assert.equal(typeof createProgram, "function");
  assert.equal(typeof program.commands, "object");
  const names = program.commands.map((command) => command.name());
  assert.ok(!names.includes("plantworks"));
  assert.ok(names.includes("fork"));
  assert.deepEqual([...COMMAND_LOADERS.keys()], names);
});

test("Pi model configuration keeps the provider model contract readable", () => {
  const text = `\uFEFF{
    // Pi accepts comments and trailing commas in models.json.
    "providers": { "local": { "models": [
      { "id": "worker", "contextWindow": 16384, "maxTokens": 2048, },
    ] } },
  }`;
  const config = parsePiModelsJson(text);
  assert.deepEqual(config.providers.local.models[0], {
    id: "worker", contextWindow: 16384, maxTokens: 2048,
  });

  const agentDir = mkdtempSync(join(tmpdir(), "plantworks-pi-contract-"));
  try {
    writeFileSync(join(agentDir, "models.json"), text);
    assert.deepEqual(piSeatPinReadings("local/worker", agentDir), {
      ok: true, readings: ["local/worker"],
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
