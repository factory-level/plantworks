// SPDX-License-Identifier: Apache-2.0
// The image entrypoint's role dispatch, run against a fake `plantworks` on PATH, so CI covers it
// without Docker. fork/container/smoke.sh checks the real image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealedEnv } from "../src/test-support/sealed-env.ts";

const entrypoint = fileURLToPath(new URL("./entrypoint.sh", import.meta.url));

function run(args, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), "pw-ep-"));
  const log = join(bin, "calls");
  // The fake records each call. `daemon status` prints $FAKE_STATUS (empty: a stopped daemon, so the daemon role exits).
  writeFileSync(join(bin, "plantworks"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n[ "$*" = "daemon status" ] && printf '%s\\n' "\${FAKE_STATUS:-}"\ncase "$*" in "pw worker live "*) exit "\${FAKE_LIVE:-0}" ;; esac\nexit 0\n`);
  chmodSync(join(bin, "plantworks"), 0o755);
  writeFileSync(log, "");
  const r = spawnSync("bash", [entrypoint, ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, FORK_ROLE_FILE: join(bin, "role"), ...env } });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

test("daemon: loopback only; any other bind is refused before anything starts", () => {
  for (const host of ["0.0.0.0", "10.0.0.5", "::", "example.invalid"]) {
    const r = run(["daemon"], { OPENRIG_BIND_HOST: host });
    assert.equal(r.code, 2, host);
    assert.match(r.stderr, /loopback only/);
    assert.deepEqual(r.calls, [], `${host}: nothing started`);
  }
  const r = run(["daemon"]);
  // `daemon logs --follow` runs in the background, so only membership is deterministic.
  assert.equal(r.calls[0], "daemon start --host 127.0.0.1", "starts on loopback first");
  for (const call of ["daemon logs --follow", "daemon status"]) assert.ok(r.calls.includes(call), call);
  assert.equal(r.code, 1, "the container stops when the daemon isn't running");
  assert.match(r.stderr, /no longer running/);
});

test("broker: loopback 7534 by default; platform, db, host and port pass through", () => {
  assert.deepEqual(run(["broker"]).calls, ["pw broker serve --host 127.0.0.1 --port 7534"]);
  assert.deepEqual(
    run(["broker"], { PLANTWORKS_BROKER_HOST: "0.0.0.0", PLANTWORKS_BROKER_PORT: "8000", PLANTWORKS_PLATFORM_FILE: "/w/p.json", PLANTWORKS_BROKER_DB: "/var/lib/fork/b.sqlite" }).calls,
    ["pw broker serve --host 0.0.0.0 --port 8000 --platform /w/p.json --db /var/lib/fork/b.sqlite"],
    "a non-loopback broker bind is passed on; the broker itself refuses it without PLANTWORKS_BROKER_TOKEN",
  );
});

test("worker: needs a team and a seat; class is optional", () => {
  const missing = run(["worker"], { PLANTWORKS_SEAT: "s@t" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /PLANTWORKS_TEAM/);
  assert.deepEqual(missing.calls, []);
  assert.match(run(["worker"], { PLANTWORKS_TEAM: "t" }).stderr, /PLANTWORKS_SEAT/);
  assert.deepEqual(run(["worker"], { PLANTWORKS_TEAM: "t", PLANTWORKS_SEAT: "s@t" }).calls, ["pw worker run --team t --seat s@t"]);
  assert.deepEqual(run(["worker"], { PLANTWORKS_TEAM: "t", PLANTWORKS_SEAT: "s@t", PLANTWORKS_CLASS: "long" }).calls, ["pw worker run --team t --seat s@t --class long"]);
});

test("anything else goes to the plantworks CLI unchanged; help prints the roles", () => {
  assert.deepEqual(run(["--version"]).calls, ["--version"]);
  assert.deepEqual(run(["pw", "worker", "drain", "--seat", "s@t"]).calls, ["pw worker drain --seat s@t"]);
  const help = run(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /daemon`, `broker` or `worker`/);
  assert.deepEqual(help.calls, []);
});

// Health runs separately from the role, so it reads the role from FORK_ROLE_FILE.
function health(role, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pw-health-"));
  const roleFile = join(dir, "role");
  if (role) writeFileSync(roleFile, `${role}\n`);
  return run(["health"], { FORK_ROLE_FILE: roleFile, ...env });
}

test("each role records itself for the health check", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-role-"));
  for (const [args, env, role] of [[["broker"], {}, "broker"], [["worker"], { PLANTWORKS_TEAM: "t", PLANTWORKS_SEAT: "s@t" }, "worker"], [["daemon"], {}, "daemon"]]) {
    const file = join(dir, role);
    run(args, { FORK_ROLE_FILE: file, ...env });
    assert.match(readFileSync(file, "utf8").trim(), role === "worker" ? /^worker \d+$/ : new RegExp(`^${role}$`));
  }
});

test("health: broker is healthy only on a 200 from /healthz", async () => {
  let status = 200;
  const server = createServer((req, res) => res.writeHead(req.url === "/healthz" ? status : 404).end("{}"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = String(server.address().port);
  // spawnSync would block the stub server, so run the check asynchronously.
  const check = (env) => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "pw-health-"));
    writeFileSync(join(dir, "role"), "broker\n");
    spawn("bash", [entrypoint, "health"], { env: sealedEnv({ FORK_ROLE_FILE: join(dir, "role"), PLANTWORKS_BROKER_PORT: port, ...env }) }).on("exit", resolve);
  });
  try {
    assert.equal(await check({}), 0);
    assert.equal(await check({ PLANTWORKS_BROKER_HOST: "0.0.0.0" }), 0, "a wildcard bind is probed on loopback");
    status = 503;
    assert.equal(await check({}), 1, "503 unavailable is unhealthy");
  } finally {
    server.close();
  }
  assert.equal(await check({ PLANTWORKS_BROKER_PORT: "9" }), 1, "no broker is unhealthy");
});

test("health: daemon must be running and not UNHEALTHY; a dead worker or no role behaves as documented", () => {
  assert.equal(health("daemon", { FAKE_STATUS: "Daemon running on port 7533 (pid 42)" }).code, 0);
  assert.equal(health("daemon", { FAKE_STATUS: "Daemon running on port 7533 (pid 42) — process present but UNHEALTHY: healthz failed" }).code, 1);
  assert.equal(health("daemon", { FAKE_STATUS: "Daemon not running" }).code, 1);
  const seat = { PLANTWORKS_SEAT: "s@t" };
  const live = health(`worker ${process.pid}`, seat);
  assert.equal(live.code, 0, "the recorded worker process is alive and its seat's Pi recorded no exit");
  assert.deepEqual(live.calls, ["pw worker live --seat s@t"]);
  assert.equal(health(`worker ${process.pid}`, { ...seat, FAKE_LIVE: "1" }).code, 1, "the seat's runner recorded a Pi exit");
  const gone = spawnSync("true").pid;
  assert.equal(health(`worker ${gone}`, seat).code, 1, "the recorded worker process is gone");
  assert.equal(health("worker", seat).code, 1, "no recorded worker process");
  assert.equal(health(null).code, 0, "a one-off command has no role to check");
});
