// SPDX-License-Identifier: Apache-2.0
// PW-13: what a job leaves in its working tree, kept as a `pw/<jobId>` branch. The commit is made
// with git plumbing on a temporary index, so the user's checkout, index and current branch are never
// touched, and nothing is pushed.
//
// The job ran as this user in this work tree, so it could have written the repository's config and
// .gitattributes. The snapshot therefore runs nothing the job could choose: no `git add` (clean
// filters, fsmonitor), files hashed with --no-filters, hooks and fsmonitor off, and no system or
// global config. Untracked files are listed with the standard excludes, so ignored files such as a
// .env never reach the commit.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Artifacts =
  | { branch: string; commit: string; files: { path: string; sha256: string }[] }
  | { branch: null; skipped: string };

/** Fixed and neutral, so a snapshot carries no one's identity. */
const IDENTITY = { GIT_AUTHOR_NAME: "Plantworks runner", GIT_AUTHOR_EMAIL: "runner@plantworks.invalid", GIT_COMMITTER_NAME: "Plantworks runner", GIT_COMMITTER_EMAIL: "runner@plantworks.invalid" };
/** States in which HEAD isn't a settled parent; a snapshot would guess, so it is skipped. */
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"];
/** Settings that would run a command the repository's config names; forced off on every call. */
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"];

export const branchFor = (jobId: string) => `pw/${jobId}`;

/** Only what git needs: no caller environment, no system or global config. */
const gitEnv = (extra: NodeJS.ProcessEnv = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra });

function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, input?: string): string {
  return execFileSync("git", [...SAFE, ...args], { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: gitEnv(extra), maxBuffer: 256 * 1024 * 1024 }).trimEnd();
}

/** sha256 of a blob, streamed, so its size doesn't matter. */
function blobSha256(cwd: string, blob: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const child = spawn("git", [...SAFE, "cat-file", "blob", blob], { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stdout.on("data", (d) => hash.update(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(hash.digest("hex")) : reject(new Error(`git cat-file ${blob}: ${err.trim() || `exit ${code}`}`))));
  });
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

/** Paths a snapshot never takes: the fork's own working files (for example .plantworks/handoff.json). */
const OWN = ".plantworks/";

/**
 * The work tree as a git tree object, built on a temporary index seeded from HEAD, with nothing the
 * job could have planted run (see the header). Skip-worktree paths and the fork's own `.plantworks/`
 * keep HEAD's entry, so `.plantworks/` never reaches a snapshot even when the job wrote there.
 */
function workTree(top: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "pw-index-"));
  try {
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    git(top, ["read-tree", "HEAD"], index);
    const nul = (s: string) => s.split("\0").filter(Boolean);
    // HEAD's paths (from the index, without touching the work tree) and untracked, not-ignored files.
    // Submodules keep HEAD's entry; a nested repository (a path ending in /) isn't descended into.
    const tracked = nul(git(top, ["ls-files", "-z", "-s"], index)).map((l) => ({ mode: l.slice(0, 6), path: l.slice(l.indexOf("\t") + 1) }));
    const untracked = nul(git(top, ["ls-files", "-z", "--others", "--exclude-standard"], index)).filter((p) => !p.endsWith("/") && !p.startsWith(OWN));
    // Paths the user's own index marks skip-worktree (sparse checkout) aren't in the work tree on
    // purpose: they keep HEAD's entry rather than reading as deleted. The real index is only read.
    const sparse = new Set(nul(git(top, ["ls-files", "-z", "-t"])).filter((l) => l.startsWith("S ")).map((l) => l.slice(2)));
    const paths = [...tracked.filter((e) => e.mode !== "160000" && !sparse.has(e.path) && !e.path.startsWith(OWN)).map((e) => e.path), ...untracked];
    const zero = "0".repeat(git(top, ["rev-parse", "HEAD"]).length);
    const regular: string[] = [];
    const lines: string[] = [];
    for (const path of paths) {
      let st;
      try { st = lstatSync(join(top, path)); } catch { lines.push(`0 ${zero}\t${path}`); continue; } // deleted
      if (st.isSymbolicLink()) lines.push(`120000 ${git(top, ["hash-object", "-w", "--no-filters", "--stdin"], {}, readlinkSync(join(top, path)))}\t${path}`);
      else if (st.isFile()) regular.push(path);
      else lines.push(`0 ${zero}\t${path}`); // a file replaced by a directory or something else
    }
    // --stdin-paths is line-based, so a path with a newline is hashed on its own.
    const batch = regular.filter((p) => !p.includes("\n"));
    const ids = new Map<string, string>();
    if (batch.length) git(top, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {}, `${batch.join("\n")}\n`).split("\n").forEach((id, i) => ids.set(batch[i]!, id));
    for (const path of regular) if (!ids.has(path)) ids.set(path, git(top, ["hash-object", "-w", "--no-filters", "--", path]));
    for (const path of regular) lines.push(`${lstatSync(join(top, path)).mode & 0o111 ? "100755" : "100644"} ${ids.get(path)}\t${path}`);
    if (lines.length) git(top, ["update-index", "-z", "--index-info"], index, lines.map((l) => `${l}\0`).join(""));
    return git(top, ["write-tree"], index);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * W4-A: the work tree as it is now, before a broker job can change it, as an unreferenced commit on
 * HEAD. The job's snapshot takes it as its parent, so `files` lists only that job's changes. Nothing
 * refers to it, so `git gc --prune=now` may remove it; the snapshot then says so.
 */
export function takeBaseline(cwd: string): { commit: string } | { skipped: string } {
  const repo = repoOf(cwd);
  if ("skipped" in repo) return { skipped: repo.skipped };
  return { commit: git(repo.top, ["commit-tree", workTree(repo.top), "-p", "HEAD", "-m", "Plantworks job baseline"], IDENTITY) };
}

/**
 * After Pi has stopped: commits the work tree to `pw/<jobId>`, against `base` (a commit from
 * takeBaseline; default HEAD), or says why not. Everything that can fail runs before the branch is
 * written, so a failure leaves no branch.
 */
export async function snapshotWork(cwd: string, jobId: string, message: string, base = "HEAD"): Promise<Artifacts> {
  const repo = repoOf(cwd);
  if ("skipped" in repo) return { branch: null, skipped: repo.skipped };
  const { top } = repo;
  try { git(top, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]); } catch { return { branch: null, skipped: `baseline unreadable: ${base} is not a commit here (pruned, or from another repository)` }; }
  const nul = (s: string) => s.split("\0").filter(Boolean);
  const tree = workTree(top);
  if (tree === git(top, ["rev-parse", `${base}^{tree}`])) return { branch: null, skipped: "the job changed nothing in the work tree" };
  const changed = nul(git(top, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", "--diff-filter=d", base, tree]));
  const blobs = changed.map((path) => git(top, ["rev-parse", `${tree}:${path}`]));
  const files: { path: string; sha256: string }[] = [];
  for (let i = 0; i < changed.length; i++) files.push({ path: changed[i]!, sha256: await blobSha256(top, blobs[i]!) });
  const commit = git(top, ["commit-tree", tree, "-p", base, "-m", message], IDENTITY);
  // Last, and only now: the empty old value makes it fail rather than move a branch that appeared meanwhile.
  git(top, ["update-ref", `refs/heads/${branchFor(jobId)}`, commit, ""]);
  return { branch: branchFor(jobId), commit, files };
}
