// SPDX-License-Identifier: Apache-2.0
// Two seat-agent processes and one routed daemon, all on this host: the local stand-in for two seat
// hosts (PW-32). Each agent drives its own private tmux socket; the daemon is upstream's, started by
// `pw remote daemon` from a routes file. Everything runs in temp homes with environments built from
// scratch. The containment checks run before any process starts and fail the test if they can't hold.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TmuxAdapter } from "../../../packages/daemon/dist/adapters/tmux.js";
import { execArgvCommand, execCommand } from "../../../packages/daemon/dist/adapters/tmux-exec.js";
import { createSeatRouter, ROUTER_ERROR } from "./router.ts";
import { routesFromFile } from "./command.ts";

const hasTmux = (() => { try { execFileSync("tmux", ["-V"]); return true; } catch { return false; } })();

// This process may run inside an OpenRig seat: drop its identity and give tmux a private, empty socket dir.
for (const k of Object.keys(process.env)) if (/^(OPENRIG_|RIGGED_|TMUX)/.test(k)) delete process.env[k];
const tmuxDir = mkdtempSync("/tmp/pw32h-"); // tmux socket paths are length-limited
process.env.TMUX_TMPDIR = tmuxDir;
const root = mkdtempSync(join(tmpdir(), "pw32-two-"));
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const s of ["pw32-a", "pw32-b", "default"]) {
    try { execFileSync("tmux", ["-L", s, "kill-server"], { env: { PATH: process.env.PATH, TMUX_TMPDIR: tmuxDir }, stdio: "ignore" }); } catch { /* not running */ }
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(tmuxDir, { recursive: true, force: true });
});

const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
const IDENTITY = /^(OPENRIG_|RIGGED_|TMUX$|TMUX_PANE$)/;

/** Throws unless every child environment is the test's own: built from scratch, homes and sockets under the temp dir. */
function assertContained(envs: Record<string, Record<string, string>>) {
  const tmp = realpathSync(tmpdir());
  for (const [name, env] of Object.entries(envs)) {
    const leaked = Object.keys(env).filter((k) => IDENTITY.test(k));
    if (leaked.length) throw new Error(`containment: ${name} would inherit ${leaked.join(", ")}`);
    for (const k of ["HOME", "PLANTWORKS_HOME"]) {
      if (env[k] !== undefined && !realpathSync(env[k]!).startsWith(`${tmp}/`)) throw new Error(`containment: ${name} ${k} is not under the temp dir`);
    }
    if (env.TMUX_TMPDIR !== tmuxDir) throw new Error(`containment: ${name} does not use the private tmux dir`);
  }
  if (readdirSync(tmuxDir).length) throw new Error("containment: the private tmux dir is not empty before the run");
  const dist = readFileSync(fileURLToPath(new URL("../../../packages/daemon/dist/index.js", import.meta.url)), "utf8");
  if (!/async function startServer\(port, options\)/.test(dist)) throw new Error("containment: packages/daemon/dist predates the PW-31 seam; the router would be ignored");
}

const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

/** Starts the CLI with exactly `env` and resolves once stdout prints a line matching `ready`. */
function start(args: string[], env: Record<string, string>, ready: RegExp): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, [bin, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (d) => { const line = String(d).split("\n").find((l) => ready.test(l)); if (line) resolve({ child, line }); });
    child.once("exit", (code) => reject(new Error(`${args.slice(0, 3).join(" ")} exited ${code}: ${err.slice(-1500)}`)));
  });
}

test("two seat agents behind one routed daemon: each seat lives on its own agent, the daemon lists both, and a down agent or wrong token fails closed", { skip: !hasTmux && "tmux is not installed", timeout: 120_000 }, async () => {
  // Sentinels that a leaked environment would reach: the test process's own env names them; no child may see them.
  const hits: string[] = [];
  const sentinel = http.createServer((q, r) => { hits.push(`${q.method} ${q.url}`); r.writeHead(503).end(); });
  await new Promise<void>((r) => sentinel.listen(0, "127.0.0.1", () => r()));
  const sentinelDb = join(root, "sentinel", "openrig.sqlite");
  process.env.OPENRIG_URL = `http://127.0.0.1:${(sentinel.address() as { port: number }).port}`;
  process.env.OPENRIG_DB = sentinelDb;
  const realDefault = `/tmp/tmux-${process.getuid!()}/default`;
  const realBefore = existsSync(realDefault) ? statSync(realDefault).mtimeMs : null;

  const home = join(root, "daemon-home");
  mkdirSync(home);
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: tmpdir(), TMUX_TMPDIR: tmuxDir };
  const envs = {
    agentA: { ...base, PLANTWORKS_SEAT_AGENT_TOKEN: "token-a" },
    agentB: { ...base, PLANTWORKS_SEAT_AGENT_TOKEN: "token-b" },
    daemon: { ...base, PLANTWORKS_HOME: home, SEAT_TOKEN_A: "token-a", SEAT_TOKEN_B: "token-b" },
  };
  assertContained(envs); // before any process starts: a failure here fails the test

  const tmux = (socket: string, ...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { env: base, encoding: "utf8" });
  try {
    const a = await start(["pw", "seat-agent", "serve", "--prefix", "rs-", "--socket", "pw32-a"], envs.agentA, /listening on/);
    const b = await start(["pw", "seat-agent", "serve", "--prefix", "rs-", "--socket", "pw32-b"], envs.agentB, /listening on/);
    const urlA = a.line.split(" ").at(-1)!;
    const urlB = b.line.split(" ").at(-1)!;
    assert.match(urlA, /^http:\/\/127\.0\.0\.1:\d+$/);
    const routes = join(root, "routes.json");
    writeFileSync(routes, JSON.stringify({ routes: { "rs-a1": { url: urlA, tokenEnv: "SEAT_TOKEN_A" }, "rs-a9": { url: urlA, tokenEnv: "SEAT_TOKEN_A" }, "rs-b1": { url: urlB, tokenEnv: "SEAT_TOKEN_B" } } }));

    // Through upstream's adapter over HTTP: a seat on each agent, created, written and read on its own socket.
    const router = createSeatRouter({ routes: routesFromFile(routes, envs.daemon), local: {
      argv: (argv) => execArgvCommand(argv), shell: (cmd) => execCommand(cmd),
    } });
    const adapter = new TmuxAdapter(router.tmuxExec, undefined, router.argvExec);
    for (const [seat, socket] of [["rs-a1", "pw32-a"], ["rs-b1", "pw32-b"]] as const) {
      assert.equal((await adapter.createSession(seat)).ok, true, seat);
      assert.equal(tmux(socket, "has-session", "-t", `=${seat}`), "", `${seat} lives on ${socket}`);
      assert.deepEqual(await adapter.sendText(seat, `echo on-${seat}`, undefined, { bracketed: false }), { ok: true });
      await adapter.sendKeys(seat, ["Enter"]);
      let screen = "";
      for (let i = 0; i < 50 && !screen.includes(`on-${seat}`); i++) { await sleep(100); screen = (await adapter.capturePaneContent(seat, 20)) ?? ""; }
      assert.match(screen, new RegExp(`on-${seat}`));
    }
    assert.throws(() => tmux("pw32-b", "has-session", "-t", "=rs-a1"), "rs-a1 is not on agent B");
    assert.deepEqual(await adapter.probeSession("rs-a9"), { state: "absent" }, "a routed seat that doesn't exist reads as absent, from its agent's own tmux");

    // The daemon, started by the new entry from the same routes file, lists the local and both remote seats.
    const port = await freePort();
    await start(["pw", "remote", "daemon", "--routes", routes, "--port", String(port)], envs.daemon, /remote daemon ready/);
    const list = async () => fetch(`http://127.0.0.1:${port}/api/adapters/tmux/sessions`);
    const up = await list();
    assert.equal(up.status, 200);
    assert.deepEqual((await up.json() as Array<{ name: string }>).map((s) => s.name).filter((n) => n.startsWith("rs-")).sort(), ["rs-a1", "rs-b1"]);
    assert.ok(readdirSync(home).some((f) => f.endsWith(".sqlite")), "the daemon's database is in its temp home");

    // A wrong token fails closed, never as an absence.
    const wrong = createSeatRouter({ routes: routesFromFile(routes, { SEAT_TOKEN_A: "nope", SEAT_TOKEN_B: "nope" }), local: { argv: async () => "", shell: async () => "" } });
    await assert.rejects(new TmuxAdapter(wrong.tmuxExec, undefined, wrong.argvExec).probeSession("rs-a1"), (e: Error) => e.message.startsWith(ROUTER_ERROR));

    // Agent B goes down: the daemon's listing fails rather than drop rs-b1.
    b.child.kill("SIGTERM");
    await new Promise((r) => (b.child.exitCode !== null ? r(null) : b.child.once("exit", r)));
    assert.notEqual((await list()).status, 200);
  } finally {
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
    sentinel.close();
    delete process.env.OPENRIG_URL;
    delete process.env.OPENRIG_DB;
  }
  assert.deepEqual(hits, [], "the sentinel daemon URL was never contacted");
  assert.equal(existsSync(sentinelDb), false, "the sentinel database was never created");
  assert.equal(existsSync(realDefault) ? statSync(realDefault).mtimeMs : null, realBefore, "the user's default tmux socket was not touched");
});
