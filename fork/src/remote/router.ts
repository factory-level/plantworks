// SPDX-License-Identifier: Apache-2.0
// The routing exec (PW-32): injected into the unmodified upstream daemon as both tmux executors
// through the PW-31 seam, `startServer(port, { argvExec, tmuxExec })`. A tmux call aimed at a
// configured remote session goes to that session's seat agent; everything else runs locally,
// exactly as upstream's own executors run it. When the router can't reproduce local semantics it
// throws, so upstream's guards fail closed. It never signals a remote process.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execArgvCommand } from "../../../packages/daemon/dist/adapters/tmux-exec.js";
import { execPreflightCommand } from "../../../packages/daemon/dist/adapters/preflight-exec.js";
import type { SeatResponse, SeatTransport } from "./transport.ts";
import { TMUX_ID, commandTarget, configCommands, flagValue, isEnumeration, shellWords, targetSession } from "./words.ts";

export type ArgvExecFn = (argv: string[]) => Promise<string>;
export type ExecFn = (cmd: string) => Promise<string>;

export interface RouterOptions {
  /** Exact tmux session name -> the transport of the agent that holds it. Sessions may share a transport. */
  routes: Map<string, SeatTransport>;
  /** Upstream's own executors by default: execArgvCommand and execPreflightCommand. */
  local?: { argv?: ArgvExecFn; shell?: ExecFn };
  /** Reads a staged temp file (tests replace it). */
  readFile?: (path: string) => string;
}

/** Every router error starts with this, and never contains a tmux absence text (see ABSENCE_TEXTS in the tests). */
export const ROUTER_ERROR = "plantworks remote seat:";
export class RemoteSeatError extends Error {}
const fail = (why: string, cause?: unknown) => new RemoteSeatError(`${ROUTER_ERROR} ${why}`, cause === undefined ? undefined : { cause });

/** A routed non-zero exit, shaped as upstream's withExecOutput shapes a local one, so upstream classifies tmux's own text. */
function tmuxFailure(argv: string[], r: SeatResponse): Error {
  const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
  return Object.assign(new Error(`Command failed: ${argv.join(" ")}${output ? `\n${output}` : ""}`), { execStderr: r.stderr });
}

// An id token in tmux output: `%3`, `@1`, `$2`, not inside a word such as a session named `dev@3`.
const ID_IN_TEXT = /(?<![\w@%$])[$@%]\d+(?!\w)/g;
/** No tmux server there, read as upstream reads it (isNoServerError, isTmuxTransportAbsentError): a permission error is not. */
const noServer = (text: string) => text.includes("no server running")
  || (text.includes("error connecting to") && /No such file or directory|Connection refused/.test(text) && !/permission denied|operation not permitted|EACCES|EPERM/i.test(text));

export function createSeatRouter(opts: RouterOptions) {
  const local = { argv: opts.local?.argv ?? execArgvCommand, shell: opts.local?.shell ?? execPreflightCommand };
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const routes = opts.routes;
  for (const name of routes.keys()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(name)) throw new Error(`invalid remote session name: ${JSON.stringify(name)}`);
  }
  // Each distinct agent once, labelled by its first session, for enumeration.
  const agents = new Map<SeatTransport, string>();
  for (const [name, t] of routes) if (!agents.has(t)) agents.set(t, name);
  const tmp = `${tmpdir().replace(/\/+$/, "")}/`;

  /** Which server an id was seen on. Ids are per server, so one seen on two is ambiguous. */
  const ids = new Map<string, SeatTransport | "local" | "ambiguous">();
  /** Numbers seen in routed pane_pid output: never signalled locally, even when a local pid matches. */
  const remotePids = new Set<number>();
  /** Buffers loaded locally whose contents a routed paste ships to the agent (load-buffer has no target). */
  const buffers = new Map<string, { argv: string[]; contents: string }>();

  function learn(argv: string[], text: string, owner: SeatTransport | "local") {
    if (argv[1] === "capture-pane") return; // pane text, not tmux output
    for (const id of text.match(ID_IN_TEXT) ?? []) {
      const seen = ids.get(id);
      ids.set(id, seen === undefined || seen === owner ? owner : "ambiguous");
    }
    const format = flagValue(argv, "-F") ?? argv.at(-1)!;
    if (owner !== "local" && format.includes("#{pane_pid}")) for (const pid of panePids(format, text)) remotePids.add(pid);
  }

  /** The #{pane_pid} field of each output line, matched against the -F format. A line that doesn't match gives all its numbers. */
  function panePids(format: string, text: string): number[] {
    const fields: string[] = [];
    const pattern = new RegExp(`^${format.split(/(#\{[^}]*\})/).map((part, i) => {
      if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      fields.push(part);
      return "(.*?)";
    }).join("")}$`);
    const at = fields.indexOf("#{pane_pid}");
    return text.split("\n").filter(Boolean).flatMap((line) => {
      const pid = pattern.exec(line)?.[at + 1];
      return pid && /^\d+$/.test(pid) ? [Number(pid)] : (line.match(/\d+/g) ?? []).map(Number);
    });
  }

  /** The agent for a target, undefined for local. Throws for an ambiguous id. */
  function routeOf(target: string | undefined): SeatTransport | undefined {
    if (target === undefined) return undefined;
    const t = (target.startsWith("=") ? target.slice(1) : target).split(":")[0]!;
    if (TMUX_ID.test(t)) {
      const owner = ids.get(t);
      if (owner === "ambiguous") throw fail(`refusing ${t}: that id was seen on more than one tmux server`);
      return owner === "local" ? undefined : owner;
    }
    return routes.get(targetSession(target)!);
  }

  const mentionsRoute = (text: string) => [...routes.keys()].some((name) => text.includes(name));

  async function send(t: SeatTransport, argv: string[], stdin?: string): Promise<string> {
    let r: SeatResponse;
    try {
      r = await t({ argv, ...(stdin === undefined ? {} : { stdin }) });
    } catch (e) {
      throw fail(`the seat agent for ${agents.get(t)} did not answer`, e);
    }
    if (r.code !== 0) throw tmuxFailure(argv, r);
    learn(argv, r.stdout, t);
    return r.stdout;
  }

  async function runLocal(argv: string[]): Promise<string> {
    const out = await local.argv(argv);
    learn(argv, out, "local");
    return out;
  }

  /** list-sessions, list-panes -a, list-windows -a, list-clients: local plus every agent, or a throw. Never partial. */
  async function enumerate(argv: string[]): Promise<string> {
    const parts: string[] = [];
    try {
      parts.push(await runLocal(argv));
    } catch (e) {
      if (!noServer((e as Error).message)) throw e;
    }
    for (const [t, label] of agents) {
      let r: SeatResponse;
      try {
        r = await t({ argv });
      } catch (e) {
        throw fail(`could not list the sessions of the seat agent for ${label}`, e);
      }
      if (r.code !== 0) {
        if (noServer(r.stderr)) continue; // no tmux server there: no lines, as upstream reads it
        throw fail(`the seat agent for ${label} refused or failed to list sessions (exit ${r.code})`);
      }
      learn(argv, r.stdout, t);
      parts.push(r.stdout);
    }
    return parts.map((p) => p.replace(/\n?$/, "\n")).filter((p) => p !== "\n").join("");
  }

  /** A routed command, with any staged temp file shipped as stdin. */
  async function routed(t: SeatTransport, argv: string[]): Promise<string> {
    if (argv.some((a) => a.includes(tmp))) throw fail("refusing to send a local temp-file path to a remote seat");
    if (argv[1] === "paste-buffer") {
      const buf = flagValue(argv, "-b");
      const loaded = buf === undefined ? undefined : buffers.get(buf);
      if (loaded === undefined) throw fail("refusing a paste whose buffer was not loaded through this router");
      buffers.delete(buf!);
      await send(t, ["tmux", "load-buffer", "-b", buf!, "-"], loaded.contents);
      try {
        return await send(t, argv);
      } catch (e) {
        await send(t, ["tmux", "delete-buffer", "-b", buf!]).catch(() => {});
        throw e;
      }
    }
    return send(t, argv);
  }

  /** `tmux [start-server ;] source-file <file>`: the staged command decides where it runs. */
  async function sourceFile(argv: string[]): Promise<string> {
    const path = argv.at(-1)!;
    const text = readFile(path);
    const staged = configCommands(text);
    if (!staged) {
      if (mentionsRoute(text)) throw fail("refusing a staged command for a remote seat that does not parse strictly");
      return runLocal(argv);
    }
    const targets = new Set(staged.map((cmd) => routeOf(commandTarget(cmd))));
    if (targets.size === 1 && targets.has(undefined)) return runLocal(argv);
    if (staged.length !== 1) throw fail("refusing a staged file that mixes commands for a remote seat");
    if (text.includes(tmp)) throw fail("refusing a staged command for a remote seat that names a local temp file (scoped launch env or script)");
    return send([...targets][0]!, [...argv.slice(0, -1), "-"], text);
  }

  const argvExec: ArgvExecFn = async (argv) => {
    if (argv[0] !== "tmux") return local.argv(argv);
    const cmd = argv.slice(1);
    if (argv.at(-2) === "source-file" && (cmd.length === 2 || cmd.join(" ").startsWith("start-server ; source-file"))) return sourceFile(argv);
    if (cmd.includes(";")) {
      if (mentionsRoute(argv.join(" "))) throw fail("refusing a command chain that names a remote seat");
      return runLocal(argv);
    }
    // A buffer has no target: the paste that follows decides which server gets it. So the load is deferred to the
    // paste, and a daemon whose seats are all remote needs no local tmux server for it. (Upstream removes the staged
    // file only after the paste.) A load that can't be deferred runs as is.
    const buf = flagValue(cmd, "-b");
    if (cmd[0] === "load-buffer" && buf !== undefined && argv.at(-1) !== "-" && cmd.length === 4) {
      buffers.set(buf, { argv, contents: readFile(argv.at(-1)!) });
      return "";
    }
    if (cmd[0] === "delete-buffer" && buf !== undefined && buffers.delete(buf)) return ""; // never loaded anywhere
    if (cmd[0] === "paste-buffer" && buf !== undefined && !routeOf(commandTarget(cmd)) && buffers.has(buf)) {
      const loaded = buffers.get(buf)!;
      buffers.delete(buf);
      await runLocal(loaded.argv);
      return runLocal(argv);
    }
    if (cmd[0] === "load-buffer" || cmd[0] === "delete-buffer") return runLocal(argv);
    if (isEnumeration(cmd)) return enumerate(argv);
    const t = routeOf(commandTarget(cmd));
    return t ? routed(t, argv) : runLocal(argv);
  };

  /** Is pid a local tmux pane's process, or a descendant of one? Linux /proc only; refuses elsewhere. */
  async function isLocalPaneProcess(pid: number): Promise<boolean> {
    if (process.platform !== "linux") return false;
    let panes: Set<number>;
    try {
      panes = new Set((await local.argv(["tmux", "list-panes", "-a", "-F", "#{pane_pid}"])).split("\n").filter(Boolean).map(Number));
    } catch {
      return false;
    }
    for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
      if (panes.has(p)) return true;
      try {
        const stat = readFileSync(`/proc/${p}/stat`, "utf8");
        p = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {
        return false;
      }
    }
    return false;
  }

  const tmuxExec: ExecFn = async (cmd) => {
    const kill = /^kill -(TERM|KILL) (\d+)$/.exec(cmd);
    if (kill && routes.size > 0) {
      // getPanePid is argv-routed, so a remote pane's pid can arrive here; upstream would `kill` it locally.
      const pid = Number(kill[2]);
      if (remotePids.has(pid) || !(await isLocalPaneProcess(pid))) throw fail(`refusing to signal pid ${pid}: not a local pane process`);
      return local.shell(cmd);
    }
    if (cmd.startsWith("tmux -D")) return local.shell(cmd); // the empty local server; never routed
    const words = shellWords(cmd);
    if (!words) {
      if (mentionsRoute(cmd)) throw fail("refusing a shell command for a remote seat that does not parse strictly");
      return local.shell(cmd);
    }
    const t = words[0] === "tmux" ? routeOf(commandTarget(words.slice(1))) : undefined;
    if (t) return routed(t, words);
    const out = await local.shell(cmd);
    if (words[0] === "tmux") learn(words, out, "local");
    return out;
  };

  return { argvExec, tmuxExec };
}
