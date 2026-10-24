// SPDX-License-Identifier: Apache-2.0
// The seat agent: the remote half of PW-32. It runs on the host that holds the seats, takes one
// tmux command at a time from the router, checks it against what upstream's tmux adapter actually
// sends, and runs it with argv (no shell). The answer is tmux's own exit code, stdout and stderr.
//
// The allowlist narrows the verbs; it is not a sandbox. new-session, respawn-pane and send-keys
// run commands in the seats by design, so whoever can reach the agent can run code there. The
// transport's auth is that boundary, and no real transport exists yet.
import { spawn } from "node:child_process";
import type { SeatRequest, SeatResponse } from "./transport.ts";
import { TMUX_ID, commandTarget, configCommands, isEnumeration, targetSession } from "./words.ts";

/** The tmux subcommands upstream's adapter sends to a seat, minus server-wide and local-only verbs. */
export const AGENT_ALLOWLIST = new Set([
  "has-session", "new-session", "kill-session", "display-message", "capture-pane", "send-keys", "load-buffer",
  "paste-buffer", "delete-buffer", "list-panes", "list-windows", "list-sessions", "list-clients", "set-option",
  "show-option", "show-options", "set-environment", "show-environment", "respawn-pane", "resize-window", "pipe-pane",
  "if-shell", "source-file",
]);
/** What a staged source-file may hold: upstream writes only these through runEnvironmentCommand. */
const SOURCE_FILE_COMMANDS = new Set(["new-session", "set-environment"]);
const OPTION_COMMANDS = new Set(["set-option", "show-option", "show-options", "set-environment", "show-environment"]);
const BUFFER = /^[A-Za-z0-9_.-]+$/;

/** Runs tmux with argv (argv[0] is "tmux") and resolves with its exit code and output, never rejecting on failure. */
export type TmuxRunner = (argv: string[], stdin?: string) => Promise<SeatResponse>;

export const runTmux: TmuxRunner = (argv, stdin) => new Promise((resolve) => {
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}\n` }));
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  // tmux may exit without reading its stdin (EPIPE): its exit code and stderr are the answer, so the write error is dropped.
  child.stdin.on("error", () => {});
  child.stdin.end(stdin ?? "");
});

export interface SeatAgentOptions {
  /** The agent touches only sessions whose name starts with this, for example "rs-". */
  prefix: string;
  run?: TmuxRunner;
}

const refuse = (why: string): SeatResponse => ({ code: 2, stdout: "", stderr: `plantworks seat-agent: ${why}\n` });

export function createSeatAgent({ prefix, run = runTmux }: SeatAgentOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(prefix)) throw new Error("seat-agent prefix must be a plain session-name prefix");
  const outOfScope = refuse("target outside this agent's scope");

  /** Null when the target is in scope; a refusal, or tmux's own failure for an unknown id, otherwise. */
  async function scope(target: string | undefined): Promise<SeatResponse | null> {
    if (target === undefined) return outOfScope;
    const t = target.startsWith("=") ? target.slice(1) : target;
    if (TMUX_ID.test(t.split(":")[0]!)) {
      const owner = await run(["tmux", "display-message", "-p", "-t", target, "#{session_name}"]);
      if (owner.code !== 0) return owner;
      return owner.stdout.trim().startsWith(prefix) ? null : outOfScope;
    }
    return targetSession(target)!.startsWith(prefix) ? null : outOfScope;
  }

  /** Checks one command (argv without "tmux"). Returns the argv to run, or a refusal. */
  async function check(cmd: string[], staged: boolean): Promise<string[] | SeatResponse> {
    const sub = cmd[0] ?? "";
    if (!AGENT_ALLOWLIST.has(sub) || (staged && !SOURCE_FILE_COMMANDS.has(sub))) return refuse(`${sub || "(none)"} not allowed`);
    if (cmd.some((a) => a.endsWith(";"))) return refuse("command separators not allowed");
    if (sub === "source-file" || sub === "load-buffer" || sub === "delete-buffer") return refuse(`${sub} not allowed in this form`);
    if (sub === "pipe-pane" && cmd.length !== 3) return refuse("pipe-pane is allowed only to stop a pipe");
    if (sub === "if-shell") {
      const id = cmd[3] ?? "";
      const upstreamForm = cmd.length === 7 && cmd[1] === "-F" && cmd[2] === "-t" && /^\$\d+$/.test(id)
        && cmd[5] === `kill-session -t '${id}'` && cmd[6] === "display-message -p kept";
      if (!upstreamForm) return refuse("if-shell is allowed only in upstream's guarded kill form");
    }
    if (sub === "new-session" && cmd.includes("-t")) return refuse("new-session -t not allowed");
    // -g and -s reach every session on the server, whatever the target.
    if (OPTION_COMMANDS.has(sub) && cmd.some((a) => /^-[A-Za-z]*[gs]/.test(a))) return refuse(`${sub} -g/-s not allowed`);
    if (isEnumeration(cmd)) {
      if (cmd.includes("-f")) return refuse("enumeration filters not allowed");
      return [...cmd, "-f", `#{m:${prefix}*,#{session_name}}`];
    }
    return (await scope(commandTarget(cmd))) ?? cmd;
  }

  return {
    async handle(req: SeatRequest): Promise<SeatResponse> {
      const { argv, stdin } = req;
      if (argv[0] !== "tmux") return refuse(`${argv[0] ?? "(none)"} not allowed`);
      const cmd = argv.slice(1);
      // Upstream's staged forms, with the temp file's contents on stdin.
      if (cmd.length === 4 && cmd[0] === "load-buffer" && cmd[1] === "-b" && BUFFER.test(cmd[2]!) && cmd[3] === "-") return run(argv, stdin);
      if (cmd.length === 3 && cmd[0] === "delete-buffer" && cmd[1] === "-b" && BUFFER.test(cmd[2]!)) return run(argv);
      const source = cmd.join(" ") === "start-server ; source-file -" || cmd.join(" ") === "source-file -";
      if (source) {
        const staged = configCommands(stdin ?? "");
        if (!staged || staged.length !== 1) return refuse("source-file must hold exactly one command upstream writes");
        const checked = await check(staged[0]!, true);
        return Array.isArray(checked) ? run(argv, stdin) : checked;
      }
      const checked = await check(cmd, false);
      return Array.isArray(checked) ? run(["tmux", ...checked], stdin) : checked;
    },
  };
}
