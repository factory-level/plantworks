// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.deepEqual(env, { OPENRIG_HOME: DAEMON_DEFAULTS.home, OPENRIG_NO_KERNEL: "1", OPENRIG_PORT: "7533", OPENRIG_BIND_HOST: "127.0.0.1" });
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

test("any non-loopback bind needs a bearer token, Tailscale addresses included", () => {
  const cases: [string[], Record<string, string | undefined>, { host?: string }][] = [
    [argv("daemon", "start", "--host", "0.0.0.0"), {}, {}],
    [argv("daemon", "start", "--host=100.100.1.1"), {}, {}],
    [argv("ps"), { OPENRIG_BIND_HOST: "192.0.2.10" }, {}],
    [argv("up", "x"), {}, { host: "::" }],
  ];
  for (const [args, env, file] of cases) {
    assert.throws(() => applyDaemonDefaults(env, args, file), /without a bearer token/, args.join(" "));
  }
  for (const host of ["127.0.0.1", "localhost", "::1"]) applyDaemonDefaults({}, argv("daemon", "start", "--host", host));
  // `--host` on other commands names a remote host id, not a bind address.
  applyDaemonDefaults({}, argv("send", "--host", "box2", "x", "hi"));
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
  assert.match(refused.stderr, /without a bearer token/);

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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
