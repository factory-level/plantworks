// SPDX-License-Identifier: Apache-2.0
// Fails when the fork touches files outside fork/ in a way fork/PATCHES.md does not record:
// a modified upstream file without its ledger row and `fork-seam: <ID>` marker, an added file
// without its "Additions outside fork/" row, a deleted upstream file, a change to the root
// package.json or package-lock.json, or a ledger row that no longer matches a change.
// The diff is taken from the merge-base with the upstream mirror, so it is exactly what the
// fork changes. Usage: node fork/scripts/check-seams.mjs [upstream-ref] (default origin/upstream-main)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_PACKAGE_FILES = ["package.json", "package-lock.json"];

/** The rows of the markdown table under `## <heading>`, as arrays of trimmed cells. */
export function tableRows(markdown, heading) {
  const section = markdown.split(/^## /m).find((s) => s.startsWith(`${heading}\n`));
  if (!section) throw new Error(`PATCHES.md has no "## ${heading}" section`);
  return section
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .slice(2) // header and separator
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/^`|`$/g, "")));
}

/**
 * @param changes [{ status: "A" | "M" | "D" | ..., path }] from `git diff --name-status --no-renames`
 * @param ledger  the text of fork/PATCHES.md
 * @param read    reads a repo-relative file at HEAD
 * @returns a list of problems; empty means the seams are clean
 */
export function checkSeams(changes, ledger, read) {
  const seams = new Map(tableRows(ledger, "Seams").map(([id, file]) => [file, id]));
  const additions = new Set(tableRows(ledger, "Additions outside fork/").map(([file]) => file));
  const problems = [];
  const outside = changes.filter((c) => !c.path.startsWith("fork/"));

  for (const { status, path } of outside) {
    if (ROOT_PACKAGE_FILES.includes(path)) {
      problems.push(`${path}: the root package files must stay byte-identical to upstream`);
    } else if (status === "D") {
      problems.push(`${path}: upstream files are never deleted or renamed`);
    } else if (status === "A") {
      if (!additions.has(path)) problems.push(`${path}: added outside fork/ without a row under "Additions outside fork/"`);
      else if (!path.split("/").pop().startsWith("fork-")) problems.push(`${path}: files added outside fork/ need a fork- prefix`);
    } else {
      const id = seams.get(path);
      if (!id) problems.push(`${path}: upstream file modified without a row under "Seams"`);
      else if (!read(path).includes(`fork-seam: ${id}`)) problems.push(`${path}: missing its "fork-seam: ${id}" marker`);
    }
  }

  const touched = new Map(outside.map((c) => [c.path, c.status]));
  for (const [file, id] of seams) {
    if (touched.get(file) !== "M") problems.push(`${file}: ledger row ${id} but the file is not modified from upstream`);
  }
  for (const file of additions) {
    if (touched.get(file) !== "A") problems.push(`${file}: ledger addition but the file is not added by the fork`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const upstream = process.argv[2] ?? "origin/upstream-main";
  const base = git("merge-base", "HEAD", upstream).trim();
  const changes = git("diff", "--name-status", "--no-renames", "-z", base, "HEAD")
    .split("\0")
    .filter(Boolean)
    .reduce((acc, field, i, all) => (i % 2 ? acc : [...acc, { status: field[0], path: all[i + 1] }]), []);
  const problems = checkSeams(changes, readFileSync(`${root}/fork/PATCHES.md`, "utf8"), (p) => readFileSync(`${root}/${p}`, "utf8"));
  if (problems.length) {
    console.error(`Seam check failed against ${upstream} (merge-base ${base.slice(0, 9)}):\n  ${problems.join("\n  ")}`);
    console.error("See fork/CONTRIBUTING-fork.md.");
    process.exit(1);
  }
  console.log(`seams ok: ${changes.length} changed files since ${base.slice(0, 9)}, all recorded`);
}
