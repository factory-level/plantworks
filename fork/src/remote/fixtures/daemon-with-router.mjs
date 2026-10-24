// SPDX-License-Identifier: Apache-2.0
// Test fixture: the unmodified upstream daemon, started through the PW-31 seam with the PW-32 router
// injected. "Local" tmux is a private socket; the one remote seat's agent drives a second private
// socket in this process. The agent is unreachable while the file <home>/agent-down exists.
// argv: <port> <local socket> <remote socket> <remote session>
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execArgvCommand, execCommand } from "../../../../packages/daemon/dist/adapters/tmux-exec.js";
import { createSeatRouter } from "../router.ts";
import { createSeatAgent, runTmux } from "../seat-agent.ts";
import { inProcessTransport } from "../transport.ts";

// This starts a real daemon. Run from inside an OpenRig seat with a copied environment, it would open that seat's
// live database (OPENRIG_DB wins over OPENRIG_HOME) and could reach its daemon and tmux server. So it refuses unless
// its environment is the test's own: no inherited identity, and a database inside its own home.
const inherited = ["OPENRIG_URL", "OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_URL", "TMUX", "TMUX_PANE"].filter((k) => process.env[k] !== undefined);
/** Null when OPENRIG_HOME is a real temp directory and OPENRIG_DB a plain file directly in it, resolved through every
 *  symlink; the reason otherwise. */
function dbOutsideHome(home, db) {
  if (!home || !db) return "OPENRIG_HOME and OPENRIG_DB must both be set";
  let realHome, realDir;
  try {
    realHome = realpathSync(home);
    realDir = realpathSync(dirname(resolve(db)));
  } catch {
    return "OPENRIG_HOME or OPENRIG_DB's directory does not resolve";
  }
  // The home itself must be a real directory under the temp dir: a linked home could name a live one.
  if (lstatSync(home).isSymbolicLink() || !realHome.startsWith(`${realpathSync(tmpdir())}/`)) return "OPENRIG_HOME must be a real directory under the temp dir";
  if (realDir !== realHome || basename(db) !== basename(resolve(db)) || /^\.\.?$/.test(basename(db))) return "OPENRIG_DB must be a file directly inside OPENRIG_HOME";
  // The file and SQLite's companions must not be links out of the home (lstat: the link itself, not its target).
  for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) {
    try { if (lstatSync(f).isSymbolicLink()) return "OPENRIG_DB or a companion file is a symlink"; } catch { /* absent is fine */ }
  }
  return null;
}
const outside = dbOutsideHome(process.env.OPENRIG_HOME, process.env.OPENRIG_DB);
if (inherited.length || outside) {
  console.error(`daemon-with-router: refusing to start: ${inherited.length ? `inherited ${inherited.join(", ")}` : outside}`);
  process.exit(2);
}

const [port, localSocket, remoteSocket, session] = process.argv.slice(2);
const onSocket = (socket, argv) => (argv[0] === "tmux" ? ["tmux", "-L", socket, ...argv.slice(1)] : argv);
const agent = createSeatAgent({ prefix: "rs-", run: (argv, stdin) => runTmux(onSocket(remoteSocket, argv), stdin) });
const wire = inProcessTransport(agent);
const transport = (req) => (existsSync(join(process.env.OPENRIG_HOME, "agent-down")) ? Promise.reject(new Error("agent down")) : wire(req));
const router = createSeatRouter({
  routes: new Map([[session, transport]]),
  local: {
    argv: (argv) => execArgvCommand(onSocket(localSocket, argv)),
    shell: (cmd) => execCommand(cmd.startsWith("tmux ") ? `tmux -L ${localSocket} ${cmd.slice(5)}` : cmd),
  },
});
const { startServer } = await import("../../../../packages/daemon/dist/index.js");
// A daemon build from before the PW-31 seam ignores the options, and with them the router: it would drive the
// default tmux server. Refuse rather than run without the router.
if (startServer.length < 2) {
  console.error("daemon-with-router: refusing to start: packages/daemon/dist predates the PW-31 startServer(port, options) seam; rebuild it");
  process.exit(3);
}
await startServer(Number(port), { argvExec: router.argvExec, tmuxExec: router.tmuxExec });
console.log("ready");
