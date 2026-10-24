// SPDX-License-Identifier: Apache-2.0
// Fails when a tracked file under fork/ lacks the Apache-2.0 SPDX header in its first lines.
// JSON has no comment syntax, and NOTICE is itself the notice, so both are exempt.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HEADER = "SPDX-License-Identifier: Apache-2.0";
const EXEMPT = [/\.json$/, /(^|\/)NOTICE$/];

export function missingHeaders(files, read = (f) => readFileSync(f, "utf8")) {
  return files
    .filter((f) => !EXEMPT.some((re) => re.test(f)))
    .filter((f) => !read(f).split("\n", 5).some((line) => line.includes(HEADER)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["ls-files", "-z", "--", "fork"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const missing = missingHeaders(files, (f) => readFileSync(`${root}/${f}`, "utf8"));
  if (missing.length) {
    console.error(`Missing "${HEADER}" in the first 5 lines:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`license headers ok (${files.length} files under fork/)`);
}
