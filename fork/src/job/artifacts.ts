// SPDX-License-Identifier: Apache-2.0
// PW-13: what a job leaves in its working tree, kept as a `pw/<jobId>` branch. The commit is made
// with git plumbing (a temporary index, write-tree, commit-tree, update-ref), so the user's checkout,
// index and current branch are never touched. `git add -A` honours .gitignore, so ignored files such
// as a .env never reach the commit.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Artifacts =
  | { branch: string; commit: string; files: { path: string; sha256: string }[] }
  | { branch: null; skipped: string };

/** Fixed and neutral, so a snapshot carries no one's identity. */
const IDENTITY = { GIT_AUTHOR_NAME: "Plantworks runner", GIT_AUTHOR_EMAIL: "runner@plantworks.invalid", GIT_COMMITTER_NAME: "Plantworks runner", GIT_COMMITTER_EMAIL: "runner@plantworks.invalid" };
/** States in which HEAD isn't a settled parent; a snapshot would guess, so it is skipped. */
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"];

export const branchFor = (jobId: string) => `pw/${jobId}`;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  // Only what git needs: no caller environment reaches it.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", ...env } }).trimEnd();
}

/** The repository `cwd` is in, or why there is none to snapshot. */
function repoOf(cwd: string): { top: string; gitDir: string } | { skipped: string } {
  let top: string;
  try { top = git(cwd, ["rev-parse", "--show-toplevel"]); } catch { return { skipped: "the working directory is not in a git work tree" }; }
  const gitDir = git(top, ["rev-parse", "--absolute-git-dir"]);
  try { git(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]); } catch { return { skipped: "HEAD is unborn (no commit yet), so there is no parent for a snapshot" }; }
  const busy = IN_PROGRESS.find((name) => existsSync(join(gitDir, name)));
  if (busy) return { skipped: `the repository is mid-operation (${busy} exists), so HEAD is not a settled parent` };
  return { top, gitDir };
}

/** Before a job runs: refuses (returns a reason) when `pw/<jobId>` already exists, so it is never overwritten. */
export function branchConflict(cwd: string, jobId: string): string | undefined {
  const repo = repoOf(cwd);
  if ("skipped" in repo) return undefined;
  try {
    git(repo.top, ["show-ref", "--verify", "--quiet", `refs/heads/${branchFor(jobId)}`]);
    return `branch ${branchFor(jobId)} already exists in ${repo.top}; a job never overwrites one`;
  } catch {
    return undefined;
  }
}

/** After Pi has stopped: commits the work tree's changes against HEAD to `pw/<jobId>`, or says why not. */
export function snapshotWork(cwd: string, jobId: string, message: string): Artifacts {
  const repo = repoOf(cwd);
  if ("skipped" in repo) return { branch: null, skipped: repo.skipped };
  const scratch = mkdtempSync(join(tmpdir(), "pw-index-"));
  try {
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    git(repo.top, ["read-tree", "HEAD"], index);
    git(repo.top, ["add", "-A"], index);
    const tree = git(repo.top, ["write-tree"], index);
    if (tree === git(repo.top, ["rev-parse", "HEAD^{tree}"])) return { branch: null, skipped: "the job changed nothing in the work tree" };
    const commit = git(repo.top, ["commit-tree", tree, "-p", "HEAD", "-m", message], IDENTITY);
    // The empty old value makes update-ref fail rather than move a branch that appeared meanwhile.
    git(repo.top, ["update-ref", `refs/heads/${branchFor(jobId)}`, commit, ""]);
    const changed = git(repo.top, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", "--diff-filter=d", "HEAD", commit]).split("\0").filter(Boolean);
    const files = changed.map((path) => ({ path, sha256: createHash("sha256").update(execFileSync("git", ["cat-file", "blob", `${commit}:${path}`], { cwd: repo.top, env: { PATH: process.env.PATH } })).digest("hex") }));
    return { branch: branchFor(jobId), commit, files };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
