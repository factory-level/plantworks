// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./sync-upstream-main.sh", import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pw-mirror-"));
  for (const bare of ["upstream.git", "fork.git"]) git(root, "init", "-q", "--bare", "-b", "main", bare);
  const author = join(root, "author");
  git(root, "clone", "-q", join(root, "upstream.git"), author);
  const commit = (msg) => { git(author, "commit", "-q", "--allow-empty", "-m", msg); git(author, "push", "-q", "origin", "HEAD:main"); return git(author, "rev-parse", "HEAD"); };
  const work = join(root, "work");
  git(root, "clone", "-q", join(root, "fork.git"), work);
  git(work, "remote", "add", "upstream", join(root, "upstream.git"));
  const sync = () => spawnSync("bash", [script], { cwd: work, env, encoding: "utf8" });
  const mirror = () => git(root, "--git-dir", join(root, "fork.git"), "rev-parse", "upstream-main");
  return { root, author, commit, sync, mirror };
}

test("creates the mirror, then fast-forwards it", () => {
  const t = setup();
  const first = t.commit("one");
  assert.equal(t.sync().status, 0);
  assert.equal(t.mirror(), first);
  const second = t.commit("two");
  assert.equal(t.sync().status, 0);
  assert.equal(t.mirror(), second);
  assert.match(t.sync().stdout, /already at/);
});

test("refuses to rewrite a mirror that upstream no longer contains", () => {
  const t = setup();
  t.commit("one");
  assert.equal(t.sync().status, 0);
  git(t.author, "commit", "-q", "--amend", "--allow-empty", "-m", "rewritten");
  git(t.author, "push", "-q", "--force", "origin", "HEAD:main");
  const before = t.mirror();
  const result = t.sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to rewrite/);
  assert.equal(t.mirror(), before);
});
