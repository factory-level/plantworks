// SPDX-License-Identifier: Apache-2.0
// The `daemon start` pre-check under daemon.db_conflict=stop: an inconclusive probe refuses; warn and the
// one-boot escape keep upstream behaviour. Probes are injected, or real against temp files, a never-answering
// local server and a PATH-shimmed lsof. Every child environment is built from scratch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dbConflictRefusal, dbHolder, healthzProbe, type Healthz, type Lsof } from "./db-conflict.ts";

const PID = 424242;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pw-dbc-"));
  const other = join(root, "other"), home = join(root, "home");
  mkdirSync(other); mkdirSync(home);
  const db = join(other, "shared.sqlite");
  writeFileSync(db, "");
  const record = (dir: string, port = 7999) => writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: PID, db, port }));
  return { root, other, home, db, record, done: () => rmSync(root, { recursive: true, force: true }) };
}
const holds = (pid = PID): Lsof => async (args) => args[0] === "-t" ? { code: 0, stdout: `${pid}\n` } : { code: 1, stdout: "" };
const answers = (pid: unknown = PID): Healthz => async () => ({ pid });

test("inconclusive probes refuse under stop; warn and the one-boot escape do not check", async () => {
  const f = fixture();
  try {
    f.record(f.other);
    const cases: [string, Lsof, Healthz, RegExp][] = [
      ["lsof timed out", async () => ({ error: "lsof gave no answer within 2000 ms" }), answers(), /no answer within 2000 ms/],
      ["lsof missing", async () => ({ error: "lsof could not run (ENOENT)" }), answers(), /lsof could not run/],
      ["lsof failed", async () => ({ code: 2, stdout: "" }), answers(), /lsof exited 2/],
      ["holder fd lookup timed out", async (a) => a[0] === "-t" ? { code: 0, stdout: `${PID}\n` } : { error: "lsof gave no answer within 2000 ms" }, answers(), /no answer/],
      ["healthz slow", holds(), async () => ({ error: "healthz on port 7999: no answer within 2000 ms" }), /names it, but healthz on port 7999: no answer/],
    ];
    for (const [name, lsof, healthz, why] of cases) {
      const refusal = await dbConflictRefusal({ db: f.db, home: f.home, policy: "stop", allow: false, probes: { lsof, healthz } });
      assert.match(refusal ?? "", /^cannot confirm that no other daemon has the database open \(/, name);
      assert.match(refusal!, why, name);
      assert.doesNotMatch(refusal!, /\n/, `${name}: one line`);
      assert.equal(await dbConflictRefusal({ db: f.db, home: f.home, policy: "warn", allow: false, probes: { lsof, healthz } }), null, `${name}: warn starts`);
      assert.equal(await dbConflictRefusal({ db: f.db, home: f.home, policy: "stop", allow: true, probes: { lsof, healthz } }), null, `${name}: the escape starts`);
    }
  } finally { f.done(); }
});

test("holders: a confirmed other daemon refuses; any holder not confirmed as this home's daemon is inconclusive; no holder and this home's own daemon pass", async () => {
  const f = fixture();
  try {
    const none: Lsof = async () => ({ code: 1, stdout: "" });
    assert.deepEqual(await dbHolder(f.db, f.home, { lsof: none, healthz: answers() }), { kind: "none" }, "lsof exit 1 with no output is nothing found");
    assert.deepEqual(await dbHolder(f.db, f.home, { lsof: holds(), healthz: answers(), self: PID }), { kind: "none" }, "this process is never its own conflict");
    const unconfirmed = /^pid \d+ has .*shared\.sqlite open and is not confirmed as this home's daemon$/;
    const kept = async (why: string, lsof: Lsof, healthz = answers()) => {
      const v = await dbHolder(f.db, f.home, { lsof, healthz });
      assert.equal(v.kind, "inconclusive", why);
      assert.match((v as { why: string }).why, unconfirmed, why);
      assert.match(await dbConflictRefusal({ db: f.db, home: f.home, policy: "stop", allow: false, probes: { lsof, healthz } }) ?? "", /^cannot confirm/, why);
      assert.equal(await dbConflictRefusal({ db: f.db, home: f.home, policy: "warn", allow: false, probes: { lsof, healthz } }), null, `${why}: warn keeps upstream's lenient rule`);
    };
    await kept("a holder with no daemon.json anywhere (an sqlite3 shell, a test harness, systemd stdout)", holds());
    // Split paths: the holder's daemon.json is in its own home, not beside the database, and its stdout is not a daemon.log.
    const split = join(f.root, "split-home");
    mkdirSync(split);
    f.record(split);
    await kept("a split-path daemon whose record is not beside the database", holds());
    f.record(f.other);
    await kept("healthz names another pid: the record is stale but the file is still held", holds(), answers(PID + 1));
    await kept("the record names another pid", holds(PID + 1));
    const confirmed = await dbConflictRefusal({ db: f.db, home: f.home, policy: "stop", allow: false, probes: { lsof: holds(), healthz: answers() } });
    assert.match(confirmed ?? "", /^OPENRIG_DB_CONFLICT: another live daemon \(pid 424242, record .*daemon\.json\) has .*shared\.sqlite open; daemon start stopped/);

    // A daemon whose stdout is <home>/daemon.log names that home; when it is this home, upstream says "already running".
    rmSync(join(f.other, "daemon.json"));
    f.record(f.home);
    const viaLog: Lsof = async (a) => a[0] === "-t" ? { code: 0, stdout: `${PID}\n` } : { code: 0, stdout: `p${PID}\nf1\nn${join(f.home, "daemon.log")}\n` };
    assert.deepEqual(await dbHolder(f.db, f.home, { lsof: viaLog, healthz: answers() }), { kind: "own-home" });
    assert.equal(await dbConflictRefusal({ db: f.db, home: f.home, policy: "stop", allow: false, probes: { lsof: viaLog, healthz: answers() } }), null);

    // An unreadable record for a holder fails closed.
    rmSync(join(f.home, "daemon.json"));
    mkdirSync(join(f.other, "daemon.json"));
    assert.equal((await dbHolder(f.db, f.home, { lsof: holds(), healthz: answers() })).kind, "inconclusive");
  } finally { f.done(); }
});

test("the real healthz probe reads a server that never answers as inconclusive, not as no daemon", async () => {
  const silent = createServer(() => { /* never answers */ });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (silent.address() as { port: number }).port;
    const started = Date.now();
    const r = await healthzProbe(port);
    assert.ok("error" in r && /no answer within 2000 ms/.test(r.error), JSON.stringify(r));
    assert.ok(Date.now() - started < 5000);
  } finally { silent.closeAllConnections(); silent.close(); }
});

test("plantworks daemon start with a slow lsof on PATH refuses in one line before spawning a daemon; (warn starting is in boot.test.ts)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pw-dbc-bin-"));
  try {
    const shim = join(root, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "lsof"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(shim, "lsof"), 0o755);
    const home = join(root, "pw");
    mkdirSync(home);
    const db = join(home, "openrig.sqlite");
    writeFileSync(db, ""); // an existing database, so the holder check runs
    const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
    const env = { PATH: `${shim}:/usr/bin:/bin:${join(process.execPath, "..")}`, HOME: root, PLANTWORKS_HOME: home };
    const r = await promisify(execFile)(process.execPath, [bin, "daemon", "start"], { env, timeout: 30_000, killSignal: "SIGKILL" })
      .then(() => ({ code: 0, stderr: "" }), (e) => ({ code: e.code as number, stderr: e.stderr as string }));
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /^plantworks: cannot confirm that no other daemon has the database open \(lsof gave no answer within 2000 ms\); daemon start stopped \(daemon\.db_conflict=stop\)\. .*\n$/);
    assert.equal(existsSync(join(home, "daemon.json")), false, "no daemon was spawned");
    assert.equal(existsSync(join(home, "daemon.log")), false, "no daemon was spawned");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
