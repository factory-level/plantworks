// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactArgs } from "./linger-report.mjs";

const preload = fileURLToPath(new URL("./linger-report.mjs", import.meta.url));
const run = (script, env) => {
  const dir = mkdtempSync(join(tmpdir(), "pw-linger-"));
  const file = join(dir, "lingering.test.mjs");
  writeFileSync(file, script);
  const r = spawnSync(process.execPath, ["--import", preload, file], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 20_000 });
  return { r, dir };
};

test("a process that outlives the threshold records its live handles, redacted for a public log", () => {
  const out = mkdtempSync(join(tmpdir(), "pw-linger-out-"));
  // A server left listening and a child given a secret-shaped argument; exit after the report is due.
  const { r } = run(`import { createServer } from "node:http"; import { spawn } from "node:child_process";
    const s = createServer().listen(0, "127.0.0.1");
    const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", "--", "--token=sk-not-real", "https://user:pw@example.invalid/x"]);
    setTimeout(() => { c.kill(); s.close(); }, 1500);`, { LINGER_REPORT_DIR: out, LINGER_REPORT_AFTER_MS: "500" });
  assert.equal(r.status, 0, r.stderr);
  const [name] = readdirSync(out);
  const text = readFileSync(join(out, name), "utf8");
  const report = JSON.parse(text);
  assert.deepEqual(report.command.scripts, ["lingering.test.mjs"], "the test file is named");
  assert.ok(report.handles.some((h) => h.type === "Server" && /^127\.0\.0\.1:\d+$/.test(h.address)));
  const child = report.handles.find((h) => h.type === "ChildProcess");
  assert.deepEqual([child.command.program, child.command.argc, child.command.scripts], ["node", 6, []]);
  for (const secret of ["sk-not-real", "user:pw", "example.invalid", "--token", tmpdir()]) assert.equal(text.includes(secret), false, `${secret} is not in the report`);
});

test("without LINGER_REPORT_DIR it does nothing, and it never keeps a process alive", () => {
  const out = mkdtempSync(join(tmpdir(), "pw-linger-out-"));
  const started = Date.now();
  const { r } = run("// exits at once\n", { LINGER_REPORT_AFTER_MS: "60000", LINGER_REPORT_DIR: out });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - started < 10_000, "the unref'd timer didn't hold the process");
  assert.deepEqual(readdirSync(out), [], "a process gone before the threshold writes nothing");
  const quiet = run("setTimeout(() => {}, 800);\n", { LINGER_REPORT_AFTER_MS: "100" });
  assert.equal(quiet.r.status, 0, "and with no dir set it is a no-op");
});

test("redactArgs keeps only the program's basename, the count and script basenames", () => {
  assert.deepEqual(redactArgs(["/usr/bin/node", "--test", "/w/fork/src/job/run.test.ts", "--x=y", "http://h:1/a.mjs"]), { program: "node", argc: 5, scripts: ["run.test.ts"] });
  assert.deepEqual(redactArgs(undefined), { program: null, argc: 0, scripts: [] });
});
