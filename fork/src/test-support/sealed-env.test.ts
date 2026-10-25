// SPDX-License-Identifier: Apache-2.0
// Keeps test children off the live daemon (the PR65 incident class). Two checks:
// - a guard: no fork test file hands its own environment to a child, whether spread, assigned, or
//   by spawning a command with no `env` at all. The few exceptions are listed below with a reason;
// - a regression: with the parent pointing OPENRIG_DB/URL/PORT at sentinels, a child built with
//   sealedEnv sees none of them and contacts none of them.
// Code under test that reads process.env inside the test process itself is outside this guard: a test
// running such code in-process sets the variables it needs (for example a temp OPENRIG_HOME) first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sealedEnv } from "./sealed-env.ts";

const fork = fileURLToPath(new URL("../..", import.meta.url));
const self = relative(fork, fileURLToPath(import.meta.url));

/** Spawns that may inherit: each a short command that cannot reach a daemon, with the reason. */
const ALLOWED: { file: string; call: RegExp; why: string }[] = [
  { file: "src/remote/two-agents.test.ts", call: /execFileSync\("tmux", \["-V"\]\)/, why: "tmux version probe" },
  { file: "src/remote/remote-tmux.test.ts", call: /execFileSync\("tmux", \["-V"\]\)/, why: "tmux version probe" },
  { file: "src/daemon/boot.test.ts", call: /execFileSync\("tmux", \["-V"\]\)/, why: "tmux version probe" },
  { file: "src/remote/remote-tmux.test.ts", call: /execFileSync\("tmux", \["-L", socket/, why: "tmux on the test's own private -L socket" },
  { file: "src/remote/remote-tmux.test.ts", call: /execFileSync\("pgrep"/, why: "process lookup" },
  { file: "src/job/artifacts.test.ts", call: /execFileSync\("mkdir"/, why: "mkdir" },
  { file: "src/job/standalone.e2e.test.ts", call: /spawnSync\("git", \["--version"\]\)/, why: "git version probe" },
  { file: "src/job/run.test.ts", call: /spawnSync\("unshare", \["--user"/, why: "user-namespace capability probe running `true`" },
  { file: "scripts/linger-report.test.mjs", call: /spawn\(process\.execPath, \["-e", "setTimeout/, why: "a node timer process, for the linger report" },
  { file: "container/entrypoint.test.mjs", call: /spawnSync\("true"\)/, why: "`true`, for a dead pid" },
  { file: "src/job/fixtures/fake-pi.mjs", call: /spawn\("sleep", \["300"\]/, why: "the fake Pi's stand-in tool process; the fake Pi itself runs under runJob's allow-listed env (run.ts PASS_ENV), which has no OPENRIG_*" },
  { file: "src/job/fixtures/fake-pi.mjs", call: /JSON\.stringify\(process\.env\)/, why: "the fake Pi records its own environment for the env allow-list test; nothing is spawned with it" },
];

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return testFiles(p);
    // Test files, and the fixtures and helpers they run.
    return /\.test\.(ts|mjs)$/.test(e.name) || (/\.(ts|mjs)$/.test(e.name) && /(^|\/)(fixtures|test-support)\//.test(relative(fork, p))) ? [relative(fork, p)] : [];
  });
}

/** `process.env` copied into another object, or handed over whole. */
const COPIES = /\.\.\.process\.env\b|env:\s*process\.env\b|Object\.assign\([^,)]+,[^)]*process\.env|structuredClone\(process\.env\)/g;
/** `process.env` used whole as a value (an alias that a later spawn could hand over), other than writing to it or listing its names. */
const BARE = /(?<!Object\.(?:assign|keys)\()\bprocess\.env\b(?!\s*(?:\.|\[|\?\.))/g;
/** A child-process call that names its environment: an `env:` property or `{ env }` shorthand. */
const NAMES_ENV = /\benv\s*:|[{,]\s*env\s*[,}]/;

/** Each child-process call with its full argument text (balanced parentheses). */
function calls(src: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  const start = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\(|promisify\(execFile\)\(/g;
  for (const m of src.matchAll(start)) {
    let depth = 1, i = m.index! + m[0].length;
    while (i < src.length && depth) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
    out.push({ at: m.index!, text: src.slice(m.index!, i) });
  }
  return out;
}

test("no fork test hands its own environment to a child process", () => {
  const files = testFiles(fork).filter((f) => f !== self);
  assert.ok(files.length > 40, `found ${files.length} test files: the scan is looking in the wrong place`);
  const problems: string[] = [];
  const used = new Set<(typeof ALLOWED)[number]>();
  for (const file of files) {
    const src = readFileSync(join(fork, file), "utf8");
    const line = (at: number) => src.slice(0, at).split("\n").length;
    for (const m of src.matchAll(COPIES)) {
      problems.push(`${file}:${line(m.index!)}: copies process.env (use sealedEnv)`);
    }
    for (const m of src.matchAll(BARE)) {
      const ok = ALLOWED.find((a) => a.file === file && a.call.test(src.slice(m.index! - 40, m.index! + 40)));
      if (ok) used.add(ok);
      else problems.push(`${file}:${line(m.index!)}: uses process.env whole (use sealedEnv, or name the variables)`);
    }
    for (const c of calls(src)) {
      if (NAMES_ENV.test(c.text)) continue;
      const ok = ALLOWED.find((a) => a.file === file && a.call.test(c.text));
      if (ok) used.add(ok);
      else problems.push(`${file}:${line(c.at)}: child process with no env inherits this one's (pass sealedEnv): ${c.text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(ALLOWED.filter((a) => !used.has(a)).map((a) => `${a.file} ${a.call}`), [], "an allowlist entry matches nothing: remove it");
});

test("the guard flags each way of inheriting", () => {
  const flagged = (src: string) => calls(src).filter((c) => !NAMES_ENV.test(c.text)).length;
  assert.equal(flagged(`spawn(process.execPath, [bin, "ps"]);`), 1);
  assert.equal(flagged(`promisify(execFile)(process.execPath, [bin],\n  { timeout: 5 });`), 1, "multi-line");
  assert.equal(flagged(`spawn(process.execPath, [bin], { env: sealedEnv() });`), 0);
  assert.equal(flagged(`db.exec("BEGIN"); /x/.exec(s);`), 0, "a method named exec is not a spawn");
  assert.equal(flagged(`spawn(bin, ["--env-file", f]);`), 1, "the word env in an argument is not an env option");
  assert.equal(flagged(`execFileSync("git", args, { cwd, env, encoding: "utf8" });`), 0, "shorthand");
  const bare = (src: string) => [...src.matchAll(BARE)].length;
  assert.equal(bare(`const e = process.env; spawn(x, [], { env: e });`), 1, "an alias");
  assert.equal(bare(`opts.env ?? process.env`), 1);
  assert.equal(bare(`process.env.PATH; process.env[k] = v; delete process.env[k]; process.env?.HOME`), 0, "member access");
  assert.equal(bare(`Object.assign(process.env, env); for (const k of Object.keys(process.env)) {}`), 0, "writing to it, listing its names");
  const copies = (src: string) => [...src.matchAll(COPIES)].length;
  assert.equal(copies(`const e = { ...process.env, A: "1" };`), 1);
  assert.equal(copies(`const e = Object.assign({}, process.env);`), 1);
  assert.equal(copies(`spawn(x, [], { env: process.env });`), 1);
  assert.equal(copies(`Object.assign(process.env, overrides);`), 0, "setting this process's own variables copies nothing to a child");
});

test("a sealed child sees and reaches none of the parent's daemon locators", async (t) => {
  let sentinelHits = 0, sinkHits = 0;
  const listen = async (onHit: () => void) => {
    const s = createServer((_q, res) => { onHit(); res.writeHead(503).end(); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
    return (s.address() as AddressInfo).port;
  };
  const sentinelPort = await listen(() => sentinelHits++);
  const sinkPort = await listen(() => sinkHits++);
  const sentinelDb = join(mkdtempSync(join(tmpdir(), "pw-sentinel-")), "live.sqlite");
  const parent = { OPENRIG_DB: sentinelDb, OPENRIG_URL: `http://127.0.0.1:${sentinelPort}`, OPENRIG_PORT: String(sentinelPort) };
  const saved = Object.fromEntries(Object.keys(parent).map((k) => [k, process.env[k]]));
  Object.assign(process.env, parent);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  const env = sealedEnv({ FOO: "bar", DROPPED: undefined });
  for (const k of Object.keys(parent)) assert.equal(k in env, false, k);
  assert.deepEqual(Object.keys(env).sort(), ["FOO", "HOME", "PATH", "TMPDIR"]);
  assert.notEqual(env.HOME, process.env.HOME, "a fresh HOME, not the seat's");

  const run = promisify(execFile);
  const seen = JSON.parse((await run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env })).stdout);
  for (const k of Object.keys(parent)) assert.equal(k in seen, false, `${k} reached the child`);

  // The real bin, on a command that does contact a daemon: it reaches only the address it was given.
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "pw-sealed-bin-"));
  const ps = (e: NodeJS.ProcessEnv) => run(process.execPath, [bin, "ps"], { env: e, timeout: 20_000 }).catch((e) => e);
  await ps(sealedEnv({ HOME: home, OPENRIG_HOME: home, OPENRIG_URL: `http://127.0.0.1:${sinkPort}` }));
  assert.ok(sinkHits > 0, "the named address was used");
  assert.equal(sentinelHits, 0, "the parent's daemon address was not");
  assert.equal(existsSync(sentinelDb), false, "the parent's database was not opened");
  // Control: the sentinel would have seen a child that inherited the parent's OPENRIG_URL.
  await ps(sealedEnv({ HOME: home, OPENRIG_HOME: home, OPENRIG_URL: process.env.OPENRIG_URL }));
  assert.ok(sentinelHits > 0, "the sentinel detects an inherited locator");
});
