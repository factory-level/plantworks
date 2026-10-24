// SPDX-License-Identifier: Apache-2.0
// The router against fakes: routing, error parity with upstream's classifiers, enumeration fan-out.
// Upstream's TmuxAdapter (the built daemon) is the consumer, unmodified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TmuxAdapter } from "../../../packages/daemon/dist/adapters/tmux.js";
import { createSeatRouter, ROUTER_ERROR } from "./router.ts";
import type { SeatRequest, SeatResponse, SeatTransport } from "./transport.ts";

/** Upstream's absence and transport texts. A router error containing any of them would read as "gone". */
const ABSENCE_TEXTS = ["session not found", "can't find session", "no current target", "no session", "can't find pane",
  "pane not found", "no such pane", "no server running", "duplicate session", "error connecting to",
  "No such file or directory", "Connection refused"];

test("the absence list matches upstream's classifiers, so router errors are checked against the real strings", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../packages/daemon/src/adapters/tmux.ts", import.meta.url)), "utf8");
  const classifiers = src.slice(src.indexOf("function isNoServerError"), src.indexOf("/** The launch warning"));
  const literals = [...classifiers.matchAll(/includes\("([^"]+)"\)/g)].map((m) => m[1]!);
  for (const l of literals) assert.ok(ABSENCE_TEXTS.includes(l), `upstream classifies on ${JSON.stringify(l)}: add it to ABSENCE_TEXTS`);
  for (const t of ABSENCE_TEXTS) assert.ok(classifiers.includes(t), `${t} is no longer in upstream's classifiers`);
});

function assertRouterError(e: unknown) {
  assert.ok(e instanceof Error && e.message.startsWith(ROUTER_ERROR), `not a router error: ${String(e)}`);
  for (const t of ABSENCE_TEXTS) assert.ok(!e.message.includes(t), `router error contains ${JSON.stringify(t)}: ${e.message}`);
  return true;
}

/** A fake agent: records requests and answers from a handler. */
function fakeAgent(answer: (req: SeatRequest) => SeatResponse | Promise<SeatResponse>) {
  const seen: SeatRequest[] = [];
  const transport: SeatTransport = async (req) => { seen.push(req); return answer(req); };
  return { seen, transport };
}
const ok = (stdout = ""): SeatResponse => ({ code: 0, stdout, stderr: "" });
const down: SeatTransport = async () => { throw new Error("connect ECONNREFUSED: Connection refused"); };

function fakeLocal(answer: (argv: string[]) => string = () => "") {
  const argvSeen: string[][] = [];
  const shellSeen: string[] = [];
  return {
    argvSeen, shellSeen,
    local: { argv: async (a: string[]) => { argvSeen.push(a); return answer(a); }, shell: async (c: string) => { shellSeen.push(c); return ""; } },
  };
}

test("routing: a routed name, =name and name:0.0 reach the agent; other sessions stay local", async () => {
  const agent = fakeAgent(() => ok("x\n"));
  const l = fakeLocal();
  const r = createSeatRouter({ routes: new Map([["rs-a", agent.transport]]), local: l.local });
  await r.argvExec(["tmux", "has-session", "-t", "rs-a"]);
  await r.argvExec(["tmux", "has-session", "-t", "=rs-a"]);
  await r.argvExec(["tmux", "capture-pane", "-p", "-t", "rs-a:0.0"]);
  await r.argvExec(["tmux", "has-session", "-t", "=dev-local"]);
  assert.deepEqual(agent.seen.map((q) => q.argv.at(-1)), ["rs-a", "=rs-a", "rs-a:0.0"]);
  assert.deepEqual(l.argvSeen, [["tmux", "has-session", "-t", "=dev-local"]]);
  // the shell executor routes upstream's quoted new-session too
  await r.tmuxExec("tmux new-session -d -P -F '#{session_id} #{session_created}' -s 'rs-a'");
  assert.deepEqual(agent.seen.at(-1)!.argv, ["tmux", "new-session", "-d", "-P", "-F", "#{session_id} #{session_created}", "-s", "rs-a"]);
});

test("routing: ids follow the server that reported them; an id seen on two servers is refused", async () => {
  const agent = fakeAgent((q) => ok(q.argv[1] === "list-panes" ? "%3\n%7\n" : ""));
  const l = fakeLocal((a) => (a[1] === "list-panes" ? "%3\n%9\n" : ""));
  const r = createSeatRouter({ routes: new Map([["rs-a", agent.transport]]), local: l.local });
  await r.argvExec(["tmux", "list-panes", "-t", "=rs-a:", "-F", "#{pane_id}"]);
  await r.argvExec(["tmux", "list-panes", "-t", "=dev:", "-F", "#{pane_id}"]);
  await r.argvExec(["tmux", "send-keys", "-t", "%7", "Enter"]);
  assert.deepEqual(agent.seen.at(-1)!.argv, ["tmux", "send-keys", "-t", "%7", "Enter"]);
  await r.argvExec(["tmux", "send-keys", "-t", "%9", "Enter"]);
  assert.deepEqual(l.argvSeen.at(-1), ["tmux", "send-keys", "-t", "%9", "Enter"]);
  await assert.rejects(r.argvExec(["tmux", "send-keys", "-t", "%3", "Enter"]), (e) => assertRouterError(e) && /seen on more than one tmux server/.test((e as Error).message));
  assert.equal(agent.seen.length + l.argvSeen.length, 4, "the ambiguous call reached neither server");
  // an id seen nowhere stays local, as today
  await r.argvExec(["tmux", "send-keys", "-t", "%42", "Enter"]);
  assert.deepEqual(l.argvSeen.at(-1), ["tmux", "send-keys", "-t", "%42", "Enter"]);
});

test("error parity: the remote tmux's own absence text classifies as absent; an unreachable agent never does", async () => {
  const gone = fakeAgent(() => ({ code: 1, stdout: "", stderr: "can't find session: rs-a\n" }));
  const l = fakeLocal();
  const absent = new TmuxAdapter(async () => "", undefined, createSeatRouter({ routes: new Map([["rs-a", gone.transport]]), local: l.local }).argvExec);
  assert.deepEqual(await absent.probeSession("rs-a"), { state: "absent" });

  const router = createSeatRouter({ routes: new Map([["rs-a", down]]), local: l.local });
  const unreachable = new TmuxAdapter(router.tmuxExec, undefined, router.argvExec);
  await assert.rejects(unreachable.probeSession("rs-a"), assertRouterError); // neither absent nor transport_unavailable
  assert.equal(await unreachable.hasSession("rs-a").catch(() => "threw"), "threw");
  const write = await unreachable.sendKeys("rs-a", ["Enter"]);
  assert.equal(write.ok, false);
  assert.equal(!write.ok && write.code, "unknown");
  const create = await unreachable.createProbeSession("rs-a");
  assert.equal(!create.ok && create.code, "unknown");
});

test("enumeration: local plus every agent once; an unreachable or failing agent throws, never a partial list", async () => {
  const a = fakeAgent(() => ok("rs-a\n"));
  const b = fakeAgent(() => ok("rs-b\n"));
  const empty = fakeAgent(() => ({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" }));
  const l = fakeLocal((argv) => (argv[1] === "list-sessions" ? "dev\n" : ""));
  const r = createSeatRouter({ routes: new Map([["rs-a", a.transport], ["rs-a2", a.transport], ["rs-b", b.transport], ["rs-c", empty.transport]]), local: l.local });
  assert.equal(await r.argvExec(["tmux", "list-sessions", "-F", "#{session_name}"]), "dev\nrs-a\nrs-b\n");
  assert.equal(a.seen.length, 1, "an agent holding two routes is asked once");

  const failing = fakeAgent(() => ({ code: 2, stdout: "", stderr: "plantworks seat-agent: list-sessions not allowed\n" }));
  for (const bad of [down, failing.transport]) {
    const partial = createSeatRouter({ routes: new Map([["rs-a", a.transport], ["rs-x", bad]]), local: l.local });
    await assert.rejects(partial.argvExec(["tmux", "list-sessions", "-F", "#{session_name}"]), assertRouterError);
    await assert.rejects(new TmuxAdapter(partial.tmuxExec, undefined, partial.argvExec).listSessions(), assertRouterError);
  }
  // no local server: the agents' lines alone
  const noLocal = fakeLocal(() => { throw new Error("Command failed: tmux list-sessions\nno server running on /tmp/tmux-1000/default"); });
  const r2 = createSeatRouter({ routes: new Map([["rs-a", a.transport]]), local: noLocal.local });
  assert.equal(await r2.argvExec(["tmux", "list-sessions", "-F", "#{session_name}"]), "rs-a\n");
});

test("temp files: a routed paste ships the loaded buffer as stdin; a routed local temp path is refused", async () => {
  const agent = fakeAgent(() => ok());
  const l = fakeLocal();
  const path = `${tmpdir()}/openrig-send-test.txt`;
  const r = createSeatRouter({ routes: new Map([["rs-a", agent.transport]]), local: l.local, readFile: () => "hello; world" });
  await r.argvExec(["tmux", "load-buffer", "-b", "buf1", path]);
  await r.argvExec(["tmux", "paste-buffer", "-t", "rs-a", "-b", "buf1", "-d", "-r", "-p"]);
  assert.deepEqual(agent.seen.map((q) => [q.argv, q.stdin]), [
    [["tmux", "load-buffer", "-b", "buf1", "-"], "hello; world"],
    [["tmux", "paste-buffer", "-t", "rs-a", "-b", "buf1", "-d", "-r", "-p"], undefined],
  ]);
  assert.deepEqual(l.argvSeen.at(-1), ["tmux", "delete-buffer", "-b", "buf1"], "the unpasted local copy is removed");
  await assert.rejects(r.argvExec(["tmux", "send-keys", "-t", "rs-a", `sh ${tmpdir()}/openrig-send-x.sh`, "Enter"]), assertRouterError);
  await assert.rejects(r.argvExec(["tmux", "paste-buffer", "-t", "rs-a", "-b", "never-loaded"]), assertRouterError);

  // source-file: the staged command decides; a scoped launch naming a local env file is refused
  const staged = createSeatRouter({ routes: new Map([["rs-a", agent.transport]]), local: l.local,
    readFile: (p) => (p.endsWith("plain") ? "new-session -d -s 'rs-a' -P -F '#{pane_id}'\n" : `new-session -d -s 'rs-a' /bin/sh -c x sh ${tmpdir()}/env\n`) });
  await staged.argvExec(["tmux", "start-server", ";", "source-file", "/x/plain"]);
  assert.deepEqual(agent.seen.at(-1), { argv: ["tmux", "start-server", ";", "source-file", "-"], stdin: "new-session -d -s 'rs-a' -P -F '#{pane_id}'\n" });
  await assert.rejects(staged.argvExec(["tmux", "start-server", ";", "source-file", "/x/scoped"]), assertRouterError);
});

test("shell commands that don't parse strictly are refused when they name a remote seat, and run locally otherwise", async () => {
  const agent = fakeAgent(() => ok());
  const l = fakeLocal();
  const r = createSeatRouter({ routes: new Map([["rs-a", agent.transport]]), local: l.local });
  await assert.rejects(r.tmuxExec("tmux has-session -t rs-a && echo yes"), assertRouterError);
  await r.tmuxExec("tmux -D </dev/null >/dev/null 2>&1 &");
  await r.tmuxExec("tmux has-session -t dev $(true)");
  assert.deepEqual(l.shellSeen, ["tmux -D </dev/null >/dev/null 2>&1 &", "tmux has-session -t dev $(true)"]);
  assert.equal(agent.seen.length, 0);
});

test("kill guard: only a routed #{pane_pid} field marks a remote pid; other numbers in that output don't block a local kill", { skip: process.platform !== "linux" && "uses /proc" }, async () => {
  const format = "#{pane_id}\t#{pane_width}x#{pane_height}\t#{pane_pid}";
  const agent = fakeAgent(() => ok(`%3\t${process.pid}x24\t4242\n`));
  const l = fakeLocal((argv) => (argv[1] === "list-panes" ? `${process.pid}\n` : ""));
  const r = createSeatRouter({ routes: new Map([["rs-a", agent.transport]]), local: l.local });
  await r.argvExec(["tmux", "list-panes", "-t", "=rs-a:", "-F", format]);
  // this process stands in for a local pane process whose pid equals the remote pane's width
  await r.tmuxExec(`kill -TERM ${process.pid}`); // the local shell is a fake: nothing is signalled
  assert.deepEqual(l.shellSeen, [`kill -TERM ${process.pid}`]);
  await assert.rejects(r.tmuxExec("kill -TERM 4242"), (e) => assertRouterError(e) && /refusing to signal pid 4242/.test((e as Error).message));
});
