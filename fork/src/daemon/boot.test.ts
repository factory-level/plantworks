// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DAEMON_DEFAULTS, applyDaemonDefaults, applyHomeDefaults } from "./boot.ts";

const argv = (...args: string[]) => ["node", "plantworks", ...args];

test("defaults: fork home and port, loopback-only bind, kernel always off", () => {
  const env: Record<string, string | undefined> = { OPENRIG_NO_KERNEL: "0" };
  applyHomeDefaults(env);
  applyDaemonDefaults(env, argv("daemon", "start"));
  assert.deepEqual(env, { OPENRIG_HOME: DAEMON_DEFAULTS.home, OPENRIG_NO_KERNEL: "1", OPENRIG_PORT: "7533", OPENRIG_DAEMON_DB_CONFLICT: "stop", OPENRIG_BIND_HOST: "127.0.0.1" });
});

test("home: PLANTWORKS_HOME wins over OPENRIG_HOME; OPENRIG_HOME is the fallback; the fork home is the default", () => {
  const home = (env: Record<string, string | undefined>) => { applyHomeDefaults(env); return env.OPENRIG_HOME; };
  // Inside an OpenRig seat OPENRIG_HOME is always the seat's live home: an explicit Plantworks home must win over it.
  assert.equal(home({ PLANTWORKS_HOME: "/srv/pw", OPENRIG_HOME: "/seat/.openrig" }), "/srv/pw");
  assert.equal(home({ PLANTWORKS_HOME: "/srv/pw" }), "/srv/pw");
  assert.equal(home({ OPENRIG_HOME: "/srv/or" }), "/srv/or");
  assert.equal(home({}), DAEMON_DEFAULTS.home);
  assert.equal(home({ PLANTWORKS_HOME: "  ", OPENRIG_HOME: "/srv/or" }), "/srv/or", "a blank PLANTWORKS_HOME is unset");
});

test("db conflict: stop by default; an explicit env or home-config choice is kept", () => {
  const policy = (env: Record<string, string | undefined>, file = {}) => { applyDaemonDefaults(env, argv("daemon", "start"), file); return env.OPENRIG_DAEMON_DB_CONFLICT; };
  assert.equal(policy({}), "stop");
  assert.equal(policy({ OPENRIG_DAEMON_DB_CONFLICT: "warn" }), "warn");
  assert.equal(policy({}, { dbConflict: "warn" }), undefined, "a config-file value is left to upstream");
  assert.equal(policy({}, { dbConflict: "stop" }), undefined);
  assert.equal(policy({ OPENRIG_DAEMON_DB_CONFLICT: " " }), "stop", "a blank value is unset");
  // The one-boot escape is upstream's own and passes through untouched.
  const escape: Record<string, string | undefined> = { OPENRIG_ALLOW_DB_CONFLICT: "1" };
  applyDaemonDefaults(escape, argv("daemon", "start"));
  assert.equal(escape.OPENRIG_ALLOW_DB_CONFLICT, "1");
});

test("explicit home, port and config-file values win over the defaults", () => {
  const env: Record<string, string | undefined> = { OPENRIG_HOME: "/srv/pw", OPENRIG_PORT: "9000" };
  applyHomeDefaults(env);
  applyDaemonDefaults(env, argv("ps"), { host: "127.0.0.2" });
  assert.equal(env.OPENRIG_HOME, "/srv/pw");
  assert.equal(env.OPENRIG_PORT, "9000");
  assert.equal(env.OPENRIG_BIND_HOST, undefined, "a config-file host is left to upstream");
  const fromFile: Record<string, string | undefined> = {};
  applyDaemonDefaults(fromFile, argv("ps"), { port: 9100 });
  assert.equal(fromFile.OPENRIG_PORT, undefined, "a config-file port is left to upstream");
});

test("daemon start refuses any non-loopback bind without a bearer token, Tailscale addresses included", () => {
  const cases: [string[], Record<string, string | undefined>, { host?: string }][] = [
    [argv("daemon", "start", "--host", "0.0.0.0"), {}, {}],
    [argv("daemon", "start", "--host=100.100.1.1"), {}, {}],
    // commander keeps the last --host, so the check must too
    [argv("daemon", "start", "--host", "127.0.0.1", "--host", "100.100.1.1"), {}, {}],
    [argv("daemon", "start", "--host=127.0.0.1", "--host=100.100.1.1"), {}, {}],
    [argv("daemon", "start"), { OPENRIG_BIND_HOST: "192.0.2.10" }, {}],
    [argv("daemon", "start"), {}, { host: "::" }],
  ];
  for (const [args, env, file] of cases) {
    assert.throws(() => applyDaemonDefaults(env, args, file), /refusing: binding the daemon on .* needs a bearer token/, args.join(" "));
  }
  for (const host of ["127.0.0.1", "localhost", "::1"]) applyDaemonDefaults({}, argv("daemon", "start", "--host", host));
  applyDaemonDefaults({}, argv("daemon", "start", "--host", "100.100.1.1", "--host", "127.0.0.1"));
});

test("other commands only warn, and pin any daemon they auto-start to loopback", () => {
  for (const [args, env, file] of [
    [argv("config", "set", "daemon.host", "127.0.0.1"), {}, { host: "0.0.0.0" }],
    [argv("up", "x"), { OPENRIG_BIND_HOST: "100.100.1.1" }, {}],
  ] as [string[], Record<string, string | undefined>, { host?: string }][]) {
    const warnings: string[] = [];
    applyDaemonDefaults(env, args, file, (m) => warnings.push(m));
    assert.equal(env.OPENRIG_BIND_HOST, "127.0.0.1", args.join(" "));
    assert.match(warnings.join(), /needs a bearer token/);
  }
  // `--host` on other commands names a remote host id, not a bind address.
  const send: Record<string, string | undefined> = {};
  applyDaemonDefaults(send, argv("send", "--host", "box2", "x", "hi"), {}, () => assert.fail("no warning"));
  assert.equal(send.OPENRIG_BIND_HOST, "127.0.0.1");
});

test("with a token, a non-loopback bind also closes the terminal routes with it", () => {
  const env: Record<string, string | undefined> = { OPENRIG_AUTH_BEARER_TOKEN: "t0k" };
  applyDaemonDefaults(env, argv("daemon", "start", "--host", "100.100.1.1"));
  assert.equal(env.OPENRIG_TERMINAL_BEARER_TOKEN, "t0k");
  const own: Record<string, string | undefined> = { OPENRIG_AUTH_BEARER_TOKEN: "t0k", OPENRIG_TERMINAL_BEARER_TOKEN: "other" };
  applyDaemonDefaults(own, argv("daemon", "start", "--host", "0.0.0.0"));
  assert.equal(own.OPENRIG_TERMINAL_BEARER_TOKEN, "other");
});

// End to end through the real binary and the built upstream daemon, in a throwaway home with its
// own tmux socket. No Claude or Codex on PATH: the daemon boots Pi-only.
const hasTmux = (() => { try { execFileSync("tmux", ["-V"]); return true; } catch { return false; } })();
test("plantworks daemon start boots a no-kernel loopback daemon in the fork home", { skip: !hasTmux && "tmux not installed" }, async () => {
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "pw-boot-"));
  const sock = mkdtempSync("/tmp/pwt-"); // tmux socket paths are length-limited
  const port = await freePort();
  const env = { PATH: `/usr/bin:/bin:${join(process.execPath, "..")}`, HOME: home, TMUX_TMPDIR: sock, OPENRIG_PORT: String(port) };
  const pw = (...args: string[]) => promisify(execFile)(process.execPath, [bin, ...args], { env })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));

  const refused = await pw("daemon", "start", "--host", "0.0.0.0");
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /refusing: binding the daemon on 0.0.0.0 needs a bearer token/);

  const started = await pw("daemon", "start");
  try {
    assert.equal(started.code, 0, started.stderr);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.status, "ok");
    assert.deepEqual([health.bind.mode, health.bind.hosts], ["explicit", ["127.0.0.1"]]);
    assert.match(readFileSync(join(home, ".plantworks", "daemon.log"), "utf8"), /OPENRIG_NO_KERNEL=1 — skipping kernel auto-boot/);
  } finally {
    const stopped = await pw("daemon", "stop");
    assert.equal(stopped.code, 0, stopped.stderr);
    try { execFileSync("tmux", ["kill-server"], { env, stdio: "ignore" }); } catch { /* no server */ }
    rmSync(sock, { recursive: true, force: true });
  }
});

test("home config resolves under PLANTWORKS_HOME, never the ambient OPENRIG_HOME, and a second daemon on the same database is refused", { skip: !hasTmux && "tmux not installed", timeout: 120_000 }, async () => {
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "pw-home-"));
  const seat = mkdtempSync(join(tmpdir(), "pw-seat-")); // stands in for a seat's ambient (live) home: must stay empty
  const sock = mkdtempSync("/tmp/pwt-");
  const base = { PATH: `/usr/bin:/bin:${join(process.execPath, "..")}`, HOME: root, TMUX_TMPDIR: sock };
  const pw = (env: Record<string, string>, ...args: string[]) => promisify(execFile)(process.execPath, [bin, ...args], { env: { ...base, ...env } })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));

  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(b);
  writeFileSync(join(b, "config.json"), JSON.stringify({ daemon: { dbConflict: "warn" } }));
  assert.equal((await pw({ PLANTWORKS_HOME: a, OPENRIG_HOME: seat }, "config", "get", "daemon.db_conflict")).stdout.trim(), "stop");
  assert.equal((await pw({ PLANTWORKS_HOME: b, OPENRIG_HOME: seat }, "config", "get", "daemon.db_conflict")).stdout.trim(), "warn", "the selected home's config wins over the default");
  assert.equal((await pw({ PLANTWORKS_HOME: a, OPENRIG_DAEMON_DB_CONFLICT: "warn" }, "config", "get", "daemon.db_conflict")).stdout.trim(), "warn");

  // Two homes, one explicit database: the second daemon stops before opening it, unless told once to proceed.
  const db = join(a, "shared.sqlite");
  const [portA, portB, portC] = [await freePort(), await freePort(), await freePort()];
  const first = { PLANTWORKS_HOME: a, OPENRIG_HOME: seat, OPENRIG_DB: db, OPENRIG_PORT: String(portA) };
  const second = { PLANTWORKS_HOME: join(root, "c"), OPENRIG_HOME: seat, OPENRIG_DB: db, OPENRIG_PORT: String(portB) };
  const started = await pw(first, "daemon", "start");
  try {
    assert.equal(started.code, 0, started.stderr);
    const refused = await pw(second, "daemon", "start");
    assert.notEqual(refused.code, 0, "the second daemon must not start");
    assert.match(readFileSync(join(root, "c", "daemon.log"), "utf8"), /OPENRIG_DB_CONFLICT: .*daemon\.db_conflict=stop/);
    const escaped = await pw({ ...second, PLANTWORKS_HOME: join(root, "d"), OPENRIG_PORT: String(portC) }, "daemon", "start", "--allow-db-conflict");
    assert.equal(escaped.code, 0, `upstream's one-boot escape still works: ${escaped.stderr}`);
    await pw({ ...second, PLANTWORKS_HOME: join(root, "d"), OPENRIG_PORT: String(portC) }, "daemon", "stop");
  } finally {
    await pw(first, "daemon", "stop");
    try { execFileSync("tmux", ["kill-server"], { env: base, stdio: "ignore" }); } catch { /* no server */ }
    assert.deepEqual(readdirSync(seat), [], "the ambient OPENRIG_HOME was never written");
    rmSync(sock, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(seat, { recursive: true, force: true });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
