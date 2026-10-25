// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealedEnv } from "../src/test-support/sealed-env.ts";
import { checkSeams } from "./check-seams.mjs";

const ledger = (seams = [], additions = []) => `# Seam ledger

## Seams

| ID | File | Reason | Card |
|---|---|---|---|
${seams.map(([id, f]) => `| ${id} | \`${f}\` | why | PW-00 |`).join("\n")}

## Additions outside fork/

| File | Reason | Card |
|---|---|---|
${additions.map((f) => `| \`${f}\` | why | PW-00 |`).join("\n")}

## Never
`;

test("accepts fork/ changes, ledgered seams with markers, and ledgered fork- additions", () => {
  const changes = [
    { status: "A", path: "fork/src/x.ts" },
    { status: "M", path: "packages/cli/src/index.ts" },
    { status: "A", path: ".github/workflows/fork-ci.yml" },
  ];
  const files = { "packages/cli/src/index.ts": "a\n// fork-seam: S-001\nb\n" };
  const text = ledger([["S-001", "packages/cli/src/index.ts"]], [".github/workflows/fork-ci.yml"]);
  assert.deepEqual(checkSeams(changes, text, (p) => files[p]), []);
});

test("flags every kind of unrecorded change", () => {
  const changes = [
    { status: "M", path: "package.json" },
    { status: "M", path: "package-lock.json" },
    { status: "D", path: "docs/a.md" },
    { status: "A", path: "scripts/new.mjs" },
    { status: "A", path: ".github/workflows/ci.yml" },
    { status: "M", path: "packages/cli/src/a.ts" },
    { status: "M", path: "packages/cli/src/b.ts" },
  ];
  const text = ledger([["S-002", "packages/cli/src/b.ts"], ["S-003", "packages/cli/src/gone.ts"]], [".github/workflows/ci.yml", ".github/workflows/fork-old.yml"]);
  const problems = checkSeams(changes, text, () => "// fork-seam: S-999\n");
  const expect = [
    /^package\.json: the root package files/,
    /^package-lock\.json: the root package files/,
    /^docs\/a\.md: upstream files are never deleted/,
    /^scripts\/new\.mjs: added outside fork\/ without a row/,
    /^\.github\/workflows\/ci\.yml: files added outside fork\/ need a fork- prefix/,
    /^packages\/cli\/src\/a\.ts: upstream file modified without a row/,
    /^packages\/cli\/src\/b\.ts: missing its "fork-seam: S-002" marker/,
    /^packages\/cli\/src\/gone\.ts: ledger row S-003 but the file is not modified/,
    /^\.github\/workflows\/fork-old\.yml: ledger addition but the file is not added/,
  ];
  assert.equal(problems.length, expect.length, problems.join("\n"));
  expect.forEach((re, i) => assert.match(problems[i], re));
});

test("the CLI diffs from the merge-base with the upstream mirror", () => {
  const env = sealedEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  const repo = mkdtempSync(join(tmpdir(), "pw-seams-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  const write = (p, s) => { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), s); };
  git("init", "-q", "-b", "main");
  write("package.json", "{}\n");
  write("src/a.ts", "a\n");
  write("fork/PATCHES.md", ledger());
  git("add", "-A"); git("commit", "-q", "-m", "upstream");
  git("branch", "upstream-main");
  // Upstream moving on after the fork point is not the fork's change.
  git("switch", "-q", "upstream-main"); write("src/a.ts", "a2\n"); git("commit", "-qam", "upstream later");
  git("switch", "-q", "main");
  write("fork/x.mjs", "x\n"); git("add", "-A"); git("commit", "-q", "-m", "fork");
  const script = fileURLToPath(new URL("./check-seams.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [script, "upstream-main"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(run().status, 0, run().stderr);
  write("src/a.ts", "changed by the fork\n"); git("commit", "-qam", "seam without a row");
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /src\/a\.ts: upstream file modified without a row/);
});
