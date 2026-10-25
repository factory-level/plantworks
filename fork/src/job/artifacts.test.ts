// SPDX-License-Identifier: Apache-2.0
// PW-13 artifacts against temporary git repositories only, never the caller's.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RejectedJob, runJob, type RunOptions } from "./run.ts";
import { snapshotWork, takeBaseline } from "./artifacts.ts";
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

test("no snapshot, with the reason, outside a repository, on an unborn HEAD, mid-merge, or with nothing changed", async () => {
  assert.deepEqual(await snapshotWork(mkdtempSync(join(tmpdir(), "pw-plain-")), jobId, "m"), { branch: null, skipped: "the working directory is not in a git work tree" });
  const unborn = mkdtempSync(join(tmpdir(), "pw-unborn-"));
  git(unborn, "init", "-q");
  writeFileSync(join(unborn, "f"), "x");
  assert.match((await snapshotWork(unborn, jobId, "m") as { skipped: string }).skipped, /HEAD is unborn/);
  const merging = repo();
  writeFileSync(join(merging, "README.md"), "edit\n");
  writeFileSync(join(git(merging, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), `${git(merging, "rev-parse", "HEAD")}\n`);
  assert.match((await snapshotWork(merging, jobId, "m") as { skipped: string }).skipped, /mid-operation \(MERGE_HEAD exists\)/);
  assert.equal(git(merging, "branch", "--list", `pw/${jobId}`), "", "no branch was made");
  const clean = repo();
  assert.deepEqual(await snapshotWork(clean, jobId, "m"), { branch: null, skipped: "the job changed nothing in the work tree" });
});

test("the snapshot runs nothing the job could plant: no clean filter, no fsmonitor, no hooks; files are taken byte for byte", async () => {
  const dir = repo();
  const marker = join(mkdtempSync(join(tmpdir(), "pw-marker-")), "ran");
  // What a job could write as this user: repository config naming commands, and attributes that apply them.
  git(dir, "config", "filter.x.clean", `sh -c 'touch ${marker}.filter; tr a-z A-Z'`);
  git(dir, "config", "core.fsmonitor", `sh -c 'touch ${marker}.fsmonitor; exit 1' --`);
  git(dir, "config", "core.hooksPath", join(dir, "hooks"));
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=x\n");
  writeFileSync(join(dir, "work.txt"), "lower case\n");
  const result = await snapshotWork(dir, jobId, "m");
  assert.ok(result.branch, JSON.stringify(result));
  assert.equal(existsSync(`${marker}.filter`), false, "the clean filter never ran");
  assert.equal(existsSync(`${marker}.fsmonitor`), false, "fsmonitor never ran");
  assert.equal(git(dir, "cat-file", "blob", `${result.commit}:work.txt`), "lower case", "committed as the bytes in the work tree, unfiltered");
});

test("large files, deletions, symlinks and the executable bit are kept as they are", async () => {
  const dir = repo();
  const big = "x".repeat(3 * 1024 * 1024);
  writeFileSync(join(dir, "big.bin"), big);
  rmSync(join(dir, "README.md"));
  symlinkSync("target-of-link", join(dir, "link"));
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  const result = await snapshotWork(dir, jobId, "m");
  assert.ok(result.branch, JSON.stringify(result));
  assert.deepEqual(result.files.map((f) => f.path).sort(), ["big.bin", "link", "run.sh"], "deletions aren't listed");
  assert.equal(result.files.find((f) => f.path === "big.bin")!.sha256, sha(big), "a 3 MB file is hashed whole");
  assert.equal(result.files.find((f) => f.path === "link")!.sha256, sha("target-of-link"), "a symlink is its target text");
  const tree = git(dir, "ls-tree", "-r", result.commit);
  assert.match(tree, /^120000 blob \S+\tlink$/m);
  assert.match(tree, /^100755 blob \S+\trun\.sh$/m);
  assert.doesNotMatch(tree, /README\.md/, "the deleted file is gone from the snapshot");
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".env\n");
});

test("under sparse checkout, files outside the cone keep HEAD's version instead of reading as deleted", async () => {
  const dir = repo();
  for (const d of ["keep", "far"]) { execFileSync("mkdir", ["-p", join(dir, d)]); writeFileSync(join(dir, d, "x.txt"), `${d}\n`); }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "two dirs");
  git(dir, "sparse-checkout", "set", "keep");
  assert.equal(existsSync(join(dir, "far", "x.txt")), false, "far/ is outside the cone");
  writeFileSync(join(dir, "keep", "new.txt"), "new\n");
  const result = await snapshotWork(dir, jobId, "m");
  assert.ok(result.branch, JSON.stringify(result));
  assert.deepEqual(result.files.map((f) => f.path), ["keep/new.txt"]);
  assert.equal(git(dir, "cat-file", "blob", `${result.commit}:far/x.txt`), "far", "kept from HEAD");
});

test("W4-A: a baseline taken at take-up keeps an earlier job's changes out of this job's snapshot", async () => {
  const dir = repo();
  writeFileSync(join(dir, "earlier.txt"), "left by the previous job\n"); // uncommitted, as a job leaves it
  const base = takeBaseline(dir);
  assert.ok("commit" in base, JSON.stringify(base));
  writeFileSync(join(dir, "mine.txt"), "this job's work\n");
  const result = await snapshotWork(dir, jobId, "m", base.commit);
  assert.ok(result.branch, JSON.stringify(result));
  assert.deepEqual(result.files.map((f) => f.path), ["mine.txt"], "only this job's change is listed");
  assert.equal(git(dir, "rev-parse", `${result.commit}^`), base.commit, "the snapshot's parent is the baseline");
  assert.equal(git(dir, "rev-parse", `${base.commit}^`), git(dir, "rev-parse", "HEAD"), "and the baseline sits on HEAD");
  assert.equal(git(dir, "for-each-ref", "--format=%(refname)", "refs/heads/"), `refs/heads/main\nrefs/heads/pw/${jobId}`, "the baseline itself is not a branch");
  // A baseline that can't be read (pruned by gc, or from elsewhere) gives no snapshot, with the reason.
  const other = repo();
  writeFileSync(join(other, "x.txt"), "x\n");
  assert.match((await snapshotWork(other, jobId, "m", base.commit) as { skipped: string }).skipped, /^baseline unreadable: /);
  assert.equal(git(other, "branch", "--list", `pw/${jobId}`), "");
});

test("W4-A: the fork's own .plantworks/ never reaches a snapshot's tree, only the job's files do", async () => {
  const dir = repo();
  execFileSync("mkdir", ["-p", join(dir, ".plantworks")]);
  writeFileSync(join(dir, ".plantworks", "handoff.json"), '{"secret":"not for the branch"}\n');
  writeFileSync(join(dir, "work.txt"), "w\n");
  const result = await snapshotWork(dir, jobId, "m");
  assert.ok(result.branch, JSON.stringify(result));
  assert.deepEqual(result.files.map((f) => f.path), ["work.txt"]);
  assert.doesNotMatch(git(dir, "ls-tree", "-r", "--name-only", result.commit), /\.plantworks/, "not in the committed tree");
  // Only .plantworks/ changed: nothing to snapshot.
  const quiet = repo();
  execFileSync("mkdir", ["-p", join(quiet, ".plantworks")]);
  writeFileSync(join(quiet, ".plantworks", "handoff.json"), "{}\n");
  assert.deepEqual(await snapshotWork(quiet, jobId, "m"), { branch: null, skipped: "the job changed nothing in the work tree" });
});
