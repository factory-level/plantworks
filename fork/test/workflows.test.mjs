// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("fork-upstream-sync pins gh to this fork, since it adds an upstream remote that gh would prefer", () => {
  const wf = readFileSync(new URL("../../.github/workflows/fork-upstream-sync.yml", import.meta.url), "utf8");
  assert.match(wf, /git remote add upstream /);
  assert.match(wf, /^ {6}GH_REPO: \$\{\{ github\.repository \}\}$/m);
});
