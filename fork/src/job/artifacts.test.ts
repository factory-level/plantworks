// SPDX-License-Identifier: Apache-2.0
// PW-13 artifacts against temporary git repositories only, never the caller's.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RejectedJob, runJob, type RunOptions } from "./run.ts";
import { snapshotWork } from "./artifacts.ts";
import { stubConsumer, stubModel } from "./fixtures/stubs.ts";

const fakePi = [process.execPath, fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url))];
const jobId = "kb-social-media-t_3fa9c01e-a1";
const envelope = { jobId, team: "social-media", task: { prompt: "edit" } };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

/** A fresh repository: one commit with a tracked file and a .gitignore that hides .env, plus a secret-looking .env. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "pw-repo-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, ".env"), "API_KEY=sk-not-a-real-secret\n");
  return dir;
}

const open = new Set<() => Promise<unknown>>();
afterEach(async () => { const c = [...open]; open.clear(); await Promise.all(c.map((f) => f())); });
async function setup(cwd: string, write: string, mode = "ok") {
  const model = await stubModel("done editing");
  open.add(model.close);
  const consumer = await stubConsumer();
  open.add(consumer.close);
  const home = mkdtempSync(join(tmpdir(), "pw-run-"));
  const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
    envelope, callbackUrl: consumer.url, openrigHome: home, cwd, piCommand: fakePi,
    env: { PATH: process.env.PATH, HOME: home, PLANTWORKS_LLM_URL: model.url, PI_FAKE_MODE: mode, PI_FAKE_WRITE: write }, log: () => {}, ...over,
  });
  return { consumer, opts };
}

test("a job's changes become branch pw/<jobId> with file sha256s; the user's checkout, index and ignored files are untouched", async () => {
  const dir = repo();
  const head = git(dir, "rev-parse", "HEAD");
  const status = git(dir, "status", "--porcelain");
  const t = await setup(dir, "README.md=changed by the job\n;notes/../new.txt=a new file\n");
  const result = await runJob(t.opts());
  assert.equal(result.state, "done");
  assert.ok(result.artifacts.branch, JSON.stringify(result.artifacts));
  const { branch, commit, files } = result.artifacts as { branch: string; commit: string; files: { path: string; sha256: string }[] };
  assert.equal(branch, `pw/${jobId}`);
  assert.equal(git(dir, "rev-parse", `refs/heads/pw/${jobId}`), commit);
  assert.equal(git(dir, "rev-parse", `${commit}^`), head, "the snapshot's parent is HEAD");
  assert.deepEqual(files, [{ path: "README.md", sha256: sha("changed by the job\n") }, { path: "new.txt", sha256: sha("a new file\n") }]);
  assert.equal(git(dir, "ls-tree", "-r", "--name-only", commit).split("\n").includes(".env"), false, "an ignored .env never reaches the commit");
  assert.doesNotMatch(git(dir, "log", "-p", "--all"), /sk-not-a-real-secret/);
  // The user's side is as the job left it: same branch and HEAD, nothing staged, the edits still in the work tree.
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(dir, "rev-parse", "HEAD"), head);
  assert.equal(git(dir, "diff", "--cached", "--name-only"), "", "the user's index is untouched");
  assert.notEqual(git(dir, "status", "--porcelain"), status);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "changed by the job\n");
  assert.equal(git(dir, "log", "-1", "--format=%an <%ae>", commit), "Plantworks runner <runner@plantworks.invalid>");
  // The terminal event carries the D11 shapes: usage without wall time, artifacts as {name, uri}.
  const last = t.consumer.events.at(-1)!.data;
  assert.deepEqual(last.usage, { promptTokens: 10, completionTokens: 2 });
  assert.deepEqual(last.artifacts, files.map((f) => ({ name: f.path, uri: `git:${commit}:${f.path}` })));
});

test("an interrupted job still keeps what Pi left, on its branch", async () => {
  const dir = repo();
  const t = await setup(dir, "partial.txt=half done\n", "hang");
  const interrupt = new AbortController();
  const running = runJob(t.opts({ signal: interrupt.signal }));
  while (!t.consumer.states().includes("running")) await new Promise((r) => setTimeout(r, 20));
  // Wait for the fake Pi's edit to land before interrupting.
  for (let i = 0; i < 100; i++) { try { readFileSync(join(dir, "partial.txt")); break; } catch { await new Promise((r) => setTimeout(r, 20)); } }
  interrupt.abort();
  const result = await running;
  assert.equal((result.detail as { reason: string }).reason, "interrupted");
  assert.deepEqual((result.artifacts as { files: unknown[] }).files, [{ path: "partial.txt", sha256: sha("half done\n") }]);
});

test("an existing pw/<jobId> branch is never overwritten: the job is refused before any event", async () => {
  const dir = repo();
  git(dir, "branch", `pw/${jobId}`);
  const before = git(dir, "rev-parse", `pw/${jobId}`);
  const t = await setup(dir, "x.txt=x\n");
  await assert.rejects(runJob(t.opts()), (e: Error) => e instanceof RejectedJob && /already exists/.test(e.message));
  assert.equal(t.consumer.events.length, 0);
  assert.equal(git(dir, "rev-parse", `pw/${jobId}`), before);
});

test("no snapshot, with the reason, outside a repository, on an unborn HEAD, mid-merge, or with nothing changed", () => {
  assert.deepEqual(snapshotWork(mkdtempSync(join(tmpdir(), "pw-plain-")), jobId, "m"), { branch: null, skipped: "the working directory is not in a git work tree" });
  const unborn = mkdtempSync(join(tmpdir(), "pw-unborn-"));
  git(unborn, "init", "-q");
  writeFileSync(join(unborn, "f"), "x");
  assert.match((snapshotWork(unborn, jobId, "m") as { skipped: string }).skipped, /HEAD is unborn/);
  const merging = repo();
  writeFileSync(join(merging, "README.md"), "edit\n");
  writeFileSync(join(git(merging, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), `${git(merging, "rev-parse", "HEAD")}\n`);
  assert.match((snapshotWork(merging, jobId, "m") as { skipped: string }).skipped, /mid-operation \(MERGE_HEAD exists\)/);
  assert.equal(git(merging, "branch", "--list", `pw/${jobId}`), "", "no branch was made");
  const clean = repo();
  assert.deepEqual(snapshotWork(clean, jobId, "m"), { branch: null, skipped: "the job changed nothing in the work tree" });
});
