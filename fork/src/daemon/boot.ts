// SPDX-License-Identifier: Apache-2.0
// How the `plantworks` binary boots the unmodified upstream daemon: a Pi-only daemon (no kernel,
// so no Claude or Codex operator and advisor) in its own home and port, so it can run next to an
// OpenRig install, and never on a non-loopback address without a bearer token.
// Everything here is environment the upstream CLI and daemon already read; nothing upstream changes.
import { homedir } from "node:os";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isLoopbackBind } from "../../../packages/daemon/dist/middleware/auth-bearer-token.js";

/** Upstream's defaults are ~/.openrig, 7433 and a database-conflict warning. */
export const DAEMON_DEFAULTS = { home: join(homedir(), ".plantworks"), port: 7533, host: "127.0.0.1", dbConflict: "stop" } as const;

type Env = Record<string, string | undefined>;

/**
 * Step 1, before any upstream module loads: upstream reads OPENRIG_HOME once, at import.
 * PLANTWORKS_HOME, when set, wins over OPENRIG_HOME: inside an OpenRig seat OPENRIG_HOME is always the
 * seat's own (live) home, so a Plantworks-specific choice must not be silently ignored there.
 * The kernel is always off: Plantworks seats are Pi workers, started by the broker.
 */
export function applyHomeDefaults(env: Env): string[] {
  const home = env.PLANTWORKS_HOME?.trim();
  const dropped = home ? dropInheritedDaemon(env, home) : [];
  if (home) env.OPENRIG_HOME = home;
  else if (!env.OPENRIG_HOME?.trim()) env.OPENRIG_HOME = DAEMON_DEFAULTS.home;
  env.OPENRIG_NO_KERNEL = "1";
  return dropped;
}

/** Where another daemon is: its address, always dropped. */
const DAEMON_LOCATORS = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_HOST", "RIGGED_HOST", "OPENRIG_PORT", "RIGGED_PORT"];
/** Paths a daemon writes to: kept only inside the selected home. (OPENRIG_WORK_ROOT, a read-only project lookup, is left.) */
const DAEMON_PATHS = ["OPENRIG_DB", "RIGGED_DB", "OPENRIG_TRANSCRIPTS_PATH", "RIGGED_TRANSCRIPTS_PATH", "OPENRIG_SHARED_DOCS_ROOT",
  "OPENRIG_SLICES_ROOT", "OPENRIG_DOGFOOD_EVIDENCE_ROOT"];

/**
 * With PLANTWORKS_HOME set, what points at some other daemon is dropped: an OpenRig session carries its own
 * daemon's URL, host, port, database and transcripts path, and moving the home alone would still reach them.
 * The port then comes from the selected home's `daemon.port` or 7533, even an intentional OPENRIG_PORT.
 * Returns the names dropped.
 */
function dropInheritedDaemon(env: Env, home: string): string[] {
  const dropped: string[] = [];
  for (const name of DAEMON_LOCATORS) {
    if (env[name] !== undefined) { delete env[name]; dropped.push(name); }
  }
  const realHome = realPath(home);
  for (const name of DAEMON_PATHS) {
    const path = env[name]?.trim();
    if (path === undefined) continue;
    const rel = relative(realHome, realPath(path));
    if (path && rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) continue; // inside the selected home, through any symlink
    delete env[name];
    dropped.push(name);
  }
  return dropped;
}

/** Resolve missing tails AND dangling symlinks, without creating anything. Unverifiable paths fail closed. */
function realPath(path: string, seen = new Set<string>()): string {
  // Preserve parent traversal until the filesystem has resolved symlinks: link/../db can
  // name an outside file even when lexical path.resolve would place it inside the home.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  if (seen.has(absolute)) throw new Error(`symlink cycle while resolving ${path}`);
  seen.add(absolute);
  try {
    return realpathSync.native(absolute);
  } catch (realpathError) {
    if ((realpathError as NodeJS.ErrnoException).code !== "ENOENT") throw realpathError;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (lstatError) {
      // Only ENOENT means an absent tail. EACCES, ENOTDIR and other errors cannot establish containment.
      if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw realpathError;
      const parent = dirname(absolute);
      return parent === absolute ? absolute : join(realPath(parent, seen), basename(absolute));
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      return realPath(isAbsolute(target) ? target : `${dirname(absolute)}${sep}${target}`, seen);
    }
    throw realpathError;
  }
}

/** Values the home's config file sets (`plantworks config set daemon.port ...`); they win over our defaults. */
export interface FileConfig { port?: unknown; host?: unknown; dbConflict?: unknown }

/**
 * Step 2: the port and bind defaults, and the bearer rule. A non-loopback bind needs
 * OPENRIG_AUTH_BEARER_TOKEN: upstream exempts Tailscale addresses and, by default, also binds the
 * Tailscale interface with no token; Plantworks does neither. `daemon start` throws on an
 * unauthenticated non-loopback bind. Every other command only warns and pins any daemon it
 * auto-starts (`up`, `context`) to loopback, so `config set daemon.host ...` can still fix it.
 */
export function applyDaemonDefaults(env: Env, argv: string[], file: FileConfig = {}, warn = (m: string) => console.error(`plantworks: ${m}`)): void {
  if (!env.OPENRIG_PORT?.trim() && file.port === undefined) env.OPENRIG_PORT = String(DAEMON_DEFAULTS.port);
  // A second daemon on a database another daemon holds stops before opening it (upstream's daemon.db_conflict),
  // unless the env or the home's config chooses otherwise. Upstream's OPENRIG_ALLOW_DB_CONFLICT=1 still lets
  // one boot through.
  if (!env.OPENRIG_DAEMON_DB_CONFLICT?.trim() && file.dbConflict === undefined) env.OPENRIG_DAEMON_DB_CONFLICT = DAEMON_DEFAULTS.dbConflict;
  const starting = argv[2] === "daemon" && argv[3] === "start";
  // The same order upstream resolves bind intent in: --host, OPENRIG_BIND_HOST, the config file.
  const host = (starting ? hostFlag(argv) : undefined) ?? (env.OPENRIG_BIND_HOST?.trim() || undefined) ?? (typeof file.host === "string" ? file.host : undefined);
  if (host === undefined) {
    env.OPENRIG_BIND_HOST = DAEMON_DEFAULTS.host;
    return;
  }
  if (isLoopbackBind(host)) return;
  const token = env.OPENRIG_AUTH_BEARER_TOKEN?.trim();
  if (!token) {
    const why = `binding the daemon on ${host} needs a bearer token: set OPENRIG_AUTH_BEARER_TOKEN, or bind 127.0.0.1`;
    if (starting) throw new Error(`refusing: ${why}`);
    warn(`${why}; a daemon this command starts binds 127.0.0.1`);
    env.OPENRIG_BIND_HOST = DAEMON_DEFAULTS.host;
    return;
  }
  // Upstream leaves the terminal routes open on Tailscale binds; close them with the same token.
  if (!env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim()) env.OPENRIG_TERMINAL_BEARER_TOKEN = token;
}

/** `daemon start --host <h>`: the only upstream --host that is a bind address. Commander keeps the last one. */
function hostFlag(argv: string[]): string | undefined {
  let host: string | undefined;
  for (let i = 4; i < argv.length; i++) {
    if (argv[i] === "--host") host = argv[++i];
    else if (argv[i]!.startsWith("--host=")) host = argv[i]!.slice("--host=".length);
  }
  return host;
}
