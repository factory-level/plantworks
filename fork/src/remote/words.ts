// SPDX-License-Identifier: Apache-2.0
// Strict tokenisers for the two quoting forms upstream's tmux adapter writes: POSIX shell strings
// (shellQuote/posixJoinArgv) and tmux config text (tmuxConfigQuote, for source-file). Each accepts
// only what upstream emits and returns null for anything else, so the router and the seat agent
// never act on a command they read differently from the shell or tmux.

/** Characters upstream leaves bare (tmux.ts SHELL_SAFE). */
const BARE = /[A-Za-z0-9_@%+=:,./-]/;

/** Shell words: bare characters, '…' and "…" without $ ` \ ". Words may join pieces. Null for anything else. */
export function shellWords(cmd: string): string[] | null {
  const words: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] === " ") { i++; continue; }
    let word = "";
    while (i < cmd.length && cmd[i] !== " ") {
      const c = cmd[i]!;
      if (c === "'" || c === '"') {
        const end = cmd.indexOf(c, i + 1);
        if (end < 0) return null;
        const body = cmd.slice(i + 1, end);
        if (c === '"' && /[$`\\]/.test(body)) return null;
        word += body;
        i = end + 1;
      } else if (BARE.test(c)) { word += c; i++; }
      else return null;
    }
    words.push(word);
  }
  return words;
}

const CONFIG_ESCAPES: Record<string, string> = { "\\": "\\", '"': '"', $: "$", n: "\n", r: "\r", t: "\t" };

/**
 * tmux config text as upstream writes it for source-file: one command per line, words bare, '…' or
 * "…" with tmuxConfigQuote's escapes. No `;`, comments, directives, variables or ~. Null otherwise.
 */
export function configCommands(text: string): string[][] | null {
  const commands: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const words: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === " ") { i++; continue; }
      let word = "";
      while (i < line.length && line[i] !== " ") {
        const c = line[i]!;
        if (c === "'") {
          const end = line.indexOf("'", i + 1);
          if (end < 0) return null;
          word += line.slice(i + 1, end);
          i = end + 1;
        } else if (c === '"') {
          i++;
          for (;;) {
            const d = line[i++];
            if (d === undefined || d === "$" || d === "`") return null;
            if (d === '"') break;
            if (d === "\\") {
              const e = CONFIG_ESCAPES[line[i++] ?? ""];
              if (e === undefined) return null;
              word += e;
            } else word += d;
          }
        } else if (BARE.test(c)) { word += c; i++; }
        else return null;
      }
      words.push(word);
    }
    commands.push(words);
  }
  return commands;
}

/** The value after the first `flag` in a tmux command's argv (no joined `-tfoo` form: upstream never writes it). */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** A tmux id ($session, @window, %pane). Ids are per server. */
export const TMUX_ID = /^[$@%]\d+$/;

/** The session name a target names: `=name`, `name:`, `name:0.0` -> `name`. Ids return null. */
export function targetSession(target: string): string | null {
  const t = target.startsWith("=") ? target.slice(1) : target;
  if (TMUX_ID.test(t)) return null;
  return t.split(":")[0]!;
}

/** The target of one tmux command (argv without the leading "tmux"): -s for new-session, else -t. */
export function commandTarget(cmd: readonly string[]): string | undefined {
  return cmd[0] === "new-session" ? flagValue(cmd, "-s") : flagValue(cmd, "-t");
}

/** Untargeted enumeration: the commands that list every session's objects. */
export function isEnumeration(cmd: readonly string[]): boolean {
  if (cmd[0] === "list-sessions") return true;
  if (cmd[0] === "list-panes" || cmd[0] === "list-windows") return cmd.includes("-a");
  return cmd[0] === "list-clients" && !cmd.includes("-t");
}
