// SPDX-License-Identifier: Apache-2.0
// `plantworks pw seat-agent serve` (the remote half, on the host that holds the seats) and
// `plantworks pw remote daemon` (upstream's daemon with the PW-32 router, from a routes file).
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { createSeatRouter } from "./router.ts";
import { createSeatAgent, runTmux } from "./seat-agent.ts";
import { httpTransport, serveSeatAgent } from "./http.ts";
import type { SeatTransport } from "./transport.ts";

/** `{"routes": {"<tmux session>": {"url": "http://host:port", "tokenEnv": "NAME"}}}`. Sessions on one agent share its transport. */
export function routesFromFile(path: string, env: Record<string, string | undefined> = process.env): Map<string, SeatTransport> {
  const file = JSON.parse(readFileSync(path, "utf8")) as { routes?: unknown };
  if (!file.routes || typeof file.routes !== "object" || Array.isArray(file.routes)) throw new Error(`${path}: expected {"routes": {"<session>": {"url", "tokenEnv"}}}`);
  const agents = new Map<string, SeatTransport>();
  const routes = new Map<string, SeatTransport>();
  for (const [session, r] of Object.entries(file.routes as Record<string, { url?: unknown; tokenEnv?: unknown }>)) {
    if (typeof r?.url !== "string" || typeof r.tokenEnv !== "string") throw new Error(`${path}: route ${session} needs a url and a tokenEnv`);
    const key = `${r.url} ${r.tokenEnv}`;
    if (!agents.has(key)) agents.set(key, httpTransport({ url: r.url, tokenEnv: r.tokenEnv, env }));
    routes.set(session, agents.get(key)!);
  }
  if (!routes.size) throw new Error(`${path}: no routes`);
  return routes;
}

export function remoteVerbs(pw: Command): void {
  pw.command("seat-agent")
    .description("Serve this host's tmux seats to a remote daemon's router (PW-32)")
    .command("serve")
    .description("Serve POST /exec, allowlisted and scoped to --prefix. The bearer token is read from the variable --token-env names")
    .requiredOption("--prefix <prefix>", "the only tmux sessions this agent touches, for example rs-")
    .option("--bind <host:port>", "where to listen", "127.0.0.1:0")
    .option("--token-env <name>", "environment variable holding the bearer token", "PLANTWORKS_SEAT_AGENT_TOKEN")
    .option("--socket <name>", "tmux -L socket name (default: the user's default tmux server)")
    .action(async (opts: { prefix: string; bind: string; tokenEnv: string; socket?: string }) => {
      try {
        const m = /^(.*):(\d+)$/.exec(opts.bind);
        if (!m) throw new Error(`--bind must be host:port, not ${opts.bind}`);
        const run = opts.socket ? (argv: string[], stdin?: string) => runTmux(["tmux", "-L", opts.socket!, ...argv.slice(1)], stdin) : runTmux;
        const server = await serveSeatAgent({ agent: createSeatAgent({ prefix: opts.prefix, run }), tokenEnv: opts.tokenEnv, host: m[1]!.replace(/^\[|\]$/g, ""), port: Number(m[2]) });
        console.log(`seat agent listening on ${server.url}`);
        const stop = () => void server.close();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      } catch (e) {
        console.error(`seat-agent: ${(e as Error).message}`);
        process.exitCode = 2;
      }
    });

  pw.command("remote")
    .description("Remote seats (PW-32)")
    .command("daemon")
    .description("Run upstream's daemon in the foreground with tmux calls for the routed sessions sent to their seat agents")
    .requiredOption("--routes <file>", 'JSON: {"routes": {"<session>": {"url": "http://host:port", "tokenEnv": "NAME"}}}')
    .option("--port <port>", "daemon port (default: $OPENRIG_PORT)")
    .action(async (opts: { routes: string; port?: string }) => {
      let router;
      try {
        router = createSeatRouter({ routes: routesFromFile(opts.routes) });
      } catch (e) {
        console.error(`remote daemon: ${(e as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const { startServer } = await import("../../../packages/daemon/dist/index.js");
      // A daemon build without the PW-31 options would ignore the router and drive the local tmux for every seat.
      if (startServer.length < 2) {
        console.error("remote daemon: packages/daemon/dist predates the PW-31 startServer(port, options) seam; rebuild it");
        process.exitCode = 3;
        return;
      }
      const server = await startServer(opts.port ? Number(opts.port) : undefined, { argvExec: router.argvExec, tmuxExec: router.tmuxExec });
      // startServer returns before its listener is bound: announce readiness only once it is.
      if (!server.listening) await once(server, "listening");
      console.log("remote daemon ready");
    });
}
