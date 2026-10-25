// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealedEnv } from "../src/test-support/sealed-env.ts";

const script = fileURLToPath(new URL("./upstream-test-merge.sh", import.meta.url));
const env = sealedEnv({ SYNC_BRANCH: "sync/test", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

// A fork remote with main (fork work on top of upstream) and upstream-main (the mirror).
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pw-sync-"));
  const remote = join(root, "fork.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const work = join(root, "work");
  git(root, "clone", "-q", remote, work);
  const edit = (file, text, msg) => { writeFileSync(join(work, file), text); git(work, "add", "-A"); git(work, "commit", "-q", "-m", msg); };
  edit("a.txt", "upstream\n", "upstream base");
  git(work, "push", "-q", "origin", "HEAD:main", "HEAD:upstream-main");
  const onBranch = (b, fn) => { git(work, "switch", "-q", "-C", b, `origin/${b}`); fn(); git(work, "push", "-q", "origin", `HEAD:${b}`); git(work, "fetch", "-q"); };
  const run = (extra = {}) => spawnSync("bash", [script], { cwd: work, env: { ...env, ...extra }, encoding: "utf8" });
  const remoteRef = (ref) => spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", ref], { env, encoding: "utf8" }).stdout.trim();
  return { work, edit, onBranch, run, remoteRef };
}

test("does nothing when main already contains the mirror", () => {
  const t = setup();
  const r = t.run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(t.remoteRef("sync/test"), "");
});

test("pushes a sync branch whose merge commit joins main and the mirror", () => {
  const t = setup();
  t.onBranch("main", () => t.edit("fork.txt", "fork\n", "fork work"));
  t.onBranch("upstream-main", () => t.edit("b.txt", "new upstream\n", "upstream moves"));
  const before = [t.remoteRef("main"), t.remoteRef("upstream-main")];
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "sync/test");
  assert.deepEqual(git(t.work, "rev-parse", "origin/sync/test^1", "origin/sync/test^2").split("\n"), before);
  assert.deepEqual([t.remoteRef("main"), t.remoteRef("upstream-main")], before, "main and the mirror are untouched");
});

test("a conflict fails and pushes nothing", () => {
  const t = setup();
  t.onBranch("main", () => t.edit("a.txt", "fork edit\n", "fork edits a"));
  t.onBranch("upstream-main", () => t.edit("a.txt", "upstream edit\n", "upstream edits a"));
  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not merge cleanly[\s\S]*a\.txt/);
  assert.equal(t.remoteRef("sync/test"), "");
});

test("only a sync/ branch is ever pushed, so main and the mirror can't be rewritten", () => {
  const t = setup();
  t.onBranch("upstream-main", () => t.edit("b.txt", "new upstream\n", "upstream moves"));
  const before = [t.remoteRef("main"), t.remoteRef("upstream-main")];
  for (const SYNC_BRANCH of ["main", "upstream-main", "sync/", "sync/bad..name", "refs/heads/main", "feature/x"]) {
    const r = t.run({ SYNC_BRANCH });
    assert.equal(r.status, 2, SYNC_BRANCH);
    assert.match(r.stderr, /refusing sync branch/);
  }
  assert.deepEqual([t.remoteRef("main"), t.remoteRef("upstream-main")], before);
});
