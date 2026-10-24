// SPDX-License-Identifier: Apache-2.0
// How the `plantworks` binary boots the unmodified upstream daemon: a Pi-only daemon (no kernel,
// so no Claude or Codex operator and advisor) in its own home and port, so it can run next to an
// OpenRig install, and never on a non-loopback address without a bearer token.
// Everything here is environment the upstream CLI and daemon already read; nothing upstream changes.
import { homedir } from "node:os";
import { join } from "node:path";
import { isLoopbackBind } from "../../../packages/daemon/dist/middleware/auth-bearer-token.js";

/** Upstream's defaults are ~/.openrig and 7433. */
export const DAEMON_DEFAULTS = { home: join(homedir(), ".plantworks"), port: 7533, host: "127.0.0.1" } as const;

type Env = Record<string, string | undefined>;

/**
 * Step 1, before any upstream module loads: upstream reads OPENRIG_HOME once, at import.
 * The kernel is always off: Plantworks seats are Pi workers, started by the broker.
 */
export function applyHomeDefaults(env: Env): void {
  if (!env.OPENRIG_HOME?.trim()) env.OPENRIG_HOME = DAEMON_DEFAULTS.home;
  env.OPENRIG_NO_KERNEL = "1";
}

/** Values the home's config file sets (`plantworks config set daemon.port ...`); they win over our defaults. */
export interface FileConfig { port?: unknown; host?: unknown }

/**
 * Step 2: the port and bind defaults, and the bearer rule. Throws if the daemon would bind a
 * non-loopback address without OPENRIG_AUTH_BEARER_TOKEN. Upstream exempts Tailscale addresses
 * and, by default, also binds the Tailscale interface with no token; Plantworks does neither.
 */
export function applyDaemonDefaults(env: Env, argv: string[], file: FileConfig = {}): void {
  if (!env.OPENRIG_PORT?.trim() && file.port === undefined) env.OPENRIG_PORT = String(DAEMON_DEFAULTS.port);
  // The same order upstream resolves bind intent in: --host, OPENRIG_BIND_HOST, the config file.
  const host = hostFlag(argv) ?? (env.OPENRIG_BIND_HOST?.trim() || undefined) ?? (typeof file.host === "string" ? file.host : undefined);
  if (host === undefined) {
    env.OPENRIG_BIND_HOST = DAEMON_DEFAULTS.host;
    return;
  }
  if (isLoopbackBind(host)) return;
  const token = env.OPENRIG_AUTH_BEARER_TOKEN?.trim();
  if (!token) {
    throw new Error(`refusing to bind the daemon on ${host} without a bearer token: set OPENRIG_AUTH_BEARER_TOKEN, or bind 127.0.0.1`);
  }
  // Upstream leaves the terminal routes open on Tailscale binds; close them with the same token.
  if (!env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim()) env.OPENRIG_TERMINAL_BEARER_TOKEN = token;
}

/** `daemon start --host <h>` is the only upstream command whose --host is a bind address. */
function hostFlag(argv: string[]): string | undefined {
  const args = argv.slice(2);
  if (args[0] !== "daemon" || args[1] !== "start") return undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--host") return args[i + 1];
    if (args[i]!.startsWith("--host=")) return args[i]!.slice("--host=".length);
  }
  return undefined;
}
