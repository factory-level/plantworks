// SPDX-License-Identifier: Apache-2.0
// The router and the seat agent against real tmux: two private sockets on this host stand in for
// the daemon's server and a remote one. No real transport and no remote host. Skipped without tmux.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TmuxAdapter } from "../../../packages/daemon/dist/adapters/tmux.js";
import { execArgvCommand, execCommand } from "../../../packages/daemon/dist/adapters/tmux-exec.js";
import { createSeatRouter, ROUTER_ERROR } from "./router.ts";
import { createSeatAgent, runTmux } from "./seat-agent.ts";
import { inProcessTransport } from "./transport.ts";

const hasTmux = (() => { try { execFileSync("tmux", ["-V"]); return true; } catch { return false; } })();
const skip = hasTmux ? false : "tmux is not installed";
// Run from inside an OpenRig seat, this process inherits that seat's live daemon identity: OPENRIG_DB, OPENRIG_URL,
// OPENRIG_SESSION_NAME, its hook token and TMUX. None of it may reach anything this file starts. A fresh
// TMUX_TMPDIR also makes the default tmux socket a private, empty one, so even a call that misses `-L` can't
// reach the caller's tmux server.
for (const k of Object.keys(process.env)) if (/^(OPENRIG_|RIGGED_|TMUX)/.test(k)) delete process.env[k];
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/pw32-"); // tmux socket paths are length-limited

/** The fixture daemon's whole environment: built from scratch, never copied from this process. */
function fixtureEnv(home: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMUX_TMPDIR: process.env.TMUX_TMPDIR!,
    OPENRIG_HOME: home, OPENRIG_DB: join(home, "openrig.sqlite"), OPENRIG_PORT: String(port),
    OPENRIG_NO_KERNEL: "1", OPENRIG_BIND_HOST: "127.0.0.1",
  };
}

const L = `pw32-local-${process.pid}`;
const R = `pw32-remote-${process.pid}`;
const onSocket = (socket: string, argv: string[]) => (argv[0] === "tmux" ? ["tmux", "-L", socket, ...argv.slice(1)] : argv);
const tmux = (socket: string, ...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
/** Ends both servers. A server whose last session ended has already exited. */
const reset = () => { for (const s of [L, R]) { try { tmux(s, "kill-server"); } catch { /* not running */ } } };
after(reset);

const agent = createSeatAgent({ prefix: "rs-", run: (argv, stdin) => runTmux(onSocket(R, argv), stdin) });
const local = {
  argv: (argv: string[]) => execArgvCommand(onSocket(L, argv)),
  shell: (cmd: string) => execCommand(cmd.startsWith("tmux ") ? `tmux -L ${L} ${cmd.slice(5)}` : cmd),
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("seat agent: refused verbs and shapes exit 2; allowed ones return tmux's real output, scoped to the prefix", { skip }, async () => {
  tmux(R, "new-session", "-d", "-s", "rs-a");
  tmux(R, "new-session", "-d", "-s", "other");
  const otherId = tmux(R, "display-message", "-p", "-t", "=other", "#{session_id}").trim();
  const refused: Array<[string[], string?]> = [
    [["tmux", "kill-server"]], [["tmux", "run-shell", "id"]], [["tmux", "switch-client", "-t", "rs-a"]],
    [["tmux", "detach-client", "-s", "rs-a"]], [["sh", "-c", "id"]], [["tmux", "-L", "x", "list-sessions"]], [["tmux", "-D"]],
    [["tmux", "pipe-pane", "-t", "rs-a", "cat >/dev/null"]], [["tmux", "if-shell", "true", "run-shell id"]],
    [["tmux", "set-option", "-g", "status", "off"]], [["tmux", "show-options", "-gv", "default-shell"]],
    [["tmux", "has-session", "-t", "=other"]], [["tmux", "display-message", "-p", "-t", otherId, "x"]],
    [["tmux", "send-keys", "-t", "rs-a", "id;"]], [["tmux", "list-sessions", "-f", "1"]], [["tmux", "source-file", "/etc/hosts"]],
    [["tmux", "source-file", "-"], "run-shell 'id'\n"], [["tmux", "source-file", "-"], "new-session -d -s 'rs-b'\nnew-session -d -s 'rs-c'\n"],
    [["tmux", "source-file", "-"], "new-session -d -s 'other2'\n"], [["tmux", "source-file", "-"], "new-session -d -s \"$HOME\"\n"],
  ];
  for (const [argv, stdin] of refused) {
    const r = await agent.handle({ argv, ...(stdin ? { stdin } : {}) });
    assert.equal(r.code, 2, `${argv.join(" ")} ${stdin ?? ""}`);
    assert.match(r.stderr, /^plantworks seat-agent: /);
  }
  assert.equal(tmux(R, "list-sessions", "-F", "#{session_name}"), "other\nrs-a\n", "nothing refused ran");

  const missing = await agent.handle({ argv: ["tmux", "has-session", "-t", "=rs-missing"] });
  assert.deepEqual([missing.code, missing.stderr], [1, "can't find session: rs-missing\n"]);
  const listed = await agent.handle({ argv: ["tmux", "list-sessions", "-F", "#{session_name}"] });
  assert.deepEqual(listed, { code: 0, stdout: "rs-a\n", stderr: "" });
  const staged = await agent.handle({ argv: ["tmux", "start-server", ";", "source-file", "-"], stdin: "new-session -d -s 'rs-b' -P -F '#{pane_id}'\n" });
  assert.equal(staged.code, 0);
  assert.match(staged.stdout, /^%\d+\n$/);
  reset();
});

test("kill guard: a remote pane's pid is never signalled locally; local pane processes still are", { skip }, async () => {
  tmux(L, "new-session", "-d", "-s", "dev-l", "sh -c 'sleep 300 & sleep 301'");
  tmux(R, "new-session", "-d", "-s", "rs-k", "sleep 300");
  const router = createSeatRouter({ routes: new Map([["rs-k", inProcessTransport(agent)]]), local });
  const adapter = new TmuxAdapter(router.tmuxExec, undefined, router.argvExec);

  const remotePid = await adapter.getPanePid("rs-k");
  assert.ok(remotePid && alive(remotePid), "the remote pane's process is a real process on this host: the witness");
  for (const result of [await adapter.signalPaneProcess("rs-k", "KILL"), await adapter.signalPid(remotePid!, "KILL")]) {
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.message.startsWith(`${ROUTER_ERROR} refusing to signal pid ${remotePid}`), JSON.stringify(result));
  }
  await sleep(100);
  assert.ok(alive(remotePid!), "the refused signal reached no process");
  // logical vs physical: a refused stop leaves the seat present, never reported stopped
  assert.equal(await adapter.isPaneDead((await adapter.listPanes("rs-k"))[0]!.id), false);

  const localPid = (await adapter.getPanePid("dev-l"))!;
  const child = Number(execFileSync("pgrep", ["-P", String(localPid)], { encoding: "utf8" }).trim().split("\n")[0]);
  assert.deepEqual(await adapter.signalPid(child, "TERM"), { ok: true });
  assert.deepEqual(await adapter.signalPaneProcess("dev-l", "TERM"), { ok: true });
  reset();
});

test("a routed seat is created, written to and read through upstream's adapter, with the text shipped as stdin", { skip }, async () => {
  tmux(L, "new-session", "-d", "-s", "dev-l");
  tmux(R, "new-session", "-d", "-s", "rs-keep"); // keeps the remote server up after rs-w ends
  const router = createSeatRouter({ routes: new Map([["rs-w", inProcessTransport(agent)]]), local });
  const adapter = new TmuxAdapter(router.tmuxExec, undefined, router.argvExec);
  const created = await adapter.createSession("rs-w");
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(tmux(R, "has-session", "-t", "=rs-w"), "");
  assert.equal(await adapter.hasSession("rs-w"), true);
  assert.deepEqual(await adapter.sendText("rs-w", "echo routed-$((40+2))", undefined, { bracketed: false }), { ok: true });
  await adapter.sendKeys("rs-w", ["Enter"]);
  await sleep(300);
  assert.match((await adapter.capturePaneContent("rs-w", 20)) ?? "", /routed-42/);
  assert.equal(tmux(L, "list-buffers"), "", "no local buffer is left behind");
  assert.deepEqual(await adapter.killSession("rs-w"), { ok: true });
  assert.deepEqual(await adapter.probeSession("rs-w"), { state: "absent" }, "the remote tmux's own absence text");
  reset();
});

test("end to end: startServer with the router; the daemon lists the remote seat, and fails rather than drop it when its agent is down", { skip, timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pw32-home-"));
  tmux(L, "new-session", "-d", "-s", "dev-l");
  tmux(R, "new-session", "-d", "-s", "rs-e");
  const port = await new Promise<number>((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  const fixture = fileURLToPath(new URL("./fixtures/daemon-with-router.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture, String(port), L, R, "rs-e"], {
    env: fixtureEnv(home, port), stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (d) => (log += d));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => { if (String(d).includes("ready")) resolve(); });
      child.once("exit", (code) => reject(new Error(`daemon exited ${code}: ${log.slice(-2000)}`)));
    });
    const sessions = async () => fetch(`http://127.0.0.1:${port}/api/adapters/tmux/sessions`);
    const up = await sessions();
    assert.equal(up.status, 200);
    assert.deepEqual((await up.json() as Array<{ name: string }>).map((s) => s.name).sort(), ["dev-l", "rs-e"]);
    writeFileSync(join(home, "agent-down"), "");
    const down = await sessions();
    assert.notEqual(down.status, 200, "an unreachable agent fails the listing; it never returns a list without its seat");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
    reset();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the fixture daemon refuses an inherited OpenRig identity: a leaked DB path or daemon URL is never opened or contacted", { skip, timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pw32-home-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "pw32-sentinel-")); // stands in for a live seat's home
  const hits: string[] = [];
  const sentinel = http.createServer((q, r) => { hits.push(`${q.method} ${q.url}`); r.writeHead(503).end(); });
  await new Promise<void>((r) => sentinel.listen(0, "127.0.0.1", () => r()));
  const sentinelUrl = `http://127.0.0.1:${(sentinel.address() as { port: number }).port}`;
  const fixture = fileURLToPath(new URL("./fixtures/daemon-with-router.mjs", import.meta.url));
  const leaks: Array<Record<string, string>> = [
    { OPENRIG_DB: join(elsewhere, "openrig.sqlite") },
    { OPENRIG_URL: sentinelUrl }, { OPENRIG_SESSION_NAME: "sentinel@seat" }, { OPENRIG_NODE_ID: "SENTINEL" },
    { OPENRIG_ACTIVITY_HOOK_TOKEN: "sentinel-token" }, { TMUX: "/nonexistent/sentinel,1,0" },
  ];
  try {
    for (const leak of leaks) {
      const run = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [fixture, "1", "l", "r", "rs-x"], { env: { ...fixtureEnv(home, 1), ...leak }, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.once("exit", (code) => resolve({ code, stderr }));
      });
      assert.equal(run.code, 2, `${Object.keys(leak)[0]}: ${run.stderr}`);
      assert.match(run.stderr, /refusing to start/);
    }
    assert.deepEqual(readdirSync(elsewhere), [], "the leaked DB path was never created");
    assert.deepEqual(readdirSync(home), [], "the fixture refused before the daemon touched its own home");
    assert.deepEqual(hits, [], "the leaked daemon URL was never contacted");
    // and the environment the end-to-end test uses carries none of the parent's identity, whatever the parent holds
    const env = fixtureEnv(home, 1);
    assert.deepEqual(Object.keys(env).filter((k) => /^(OPENRIG_|TMUX)/.test(k)).sort(),
      ["OPENRIG_BIND_HOST", "OPENRIG_DB", "OPENRIG_HOME", "OPENRIG_NO_KERNEL", "OPENRIG_PORT", "TMUX_TMPDIR"]);
    assert.ok(env.OPENRIG_DB.startsWith(`${home}/`));
  } finally {
    sentinel.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("runTmux: a command that exits without reading its stdin answers with its exit code; EPIPE never escapes", async () => {
  const big = "x".repeat(4 * 1024 * 1024);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await runTmux([process.execPath, "-e", "process.stderr.write('gone'); process.exit(3)"], big), { code: 3, stdout: "", stderr: "gone" });
  }
});
