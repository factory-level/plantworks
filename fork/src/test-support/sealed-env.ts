// SPDX-License-Identifier: Apache-2.0
// The environment for a test's child process, built from scratch. A test runs inside an OpenRig seat
// whose environment points at the live daemon (OPENRIG_DB, OPENRIG_URL, OPENRIG_PORT, ...); a child
// given a copy of it opens that daemon's database (the PR65 incident). So nothing is inherited but
// PATH and TMPDIR: HOME is a fresh temp directory unless the test names one, and everything else the
// child needs is passed explicitly. sealed-env.test.ts keeps test files from spreading process.env.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PATH, TMPDIR and a temp HOME, then `overrides` (a value of `undefined` leaves that name out). */
export function sealedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: tmpdir(),
    HOME: mkdtempSync(join(tmpdir(), "pw-sealed-home-")),
    ...overrides,
  };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  return env as NodeJS.ProcessEnv;
}
