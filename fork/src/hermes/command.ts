// SPDX-License-Identifier: Apache-2.0
// `plantworks pw mcp serve`: the Hermes integration kit's MCP server for one team (PW-24).
// Upstream's `plantworks mcp serve` (rig's own MCP server) is untouched and separate.
import type { Command } from "commander";
import { BROKER_DEFAULTS } from "../broker/command.ts";
import { serveHttp, serveStdio, type KitOptions } from "./kit.ts";

/** Next to the daemon (7533) and the broker (7534). */
export const MCP_DEFAULT_BIND = "127.0.0.1:7535";

export function kitOptions(env: Record<string, string | undefined>): KitOptions {
  const team = env.PLANTWORKS_TEAM?.trim();
  if (!team) throw new Error("PLANTWORKS_TEAM is not set: the server acts for exactly one team");
  return {
    team,
    brokerUrl: env.PLANTWORKS_BROKER_URL?.trim() || `http://${BROKER_DEFAULTS.host}:${BROKER_DEFAULTS.port}`,
    brokerToken: env.PLANTWORKS_BROKER_TOKEN?.trim() || undefined,
  };
}

export function mcpVerb(pw: Command): void {
  const mcp = pw.command("mcp").description("The Hermes integration kit: job_submit, job_inspect and job_cancel for one team");
  mcp
    .command("serve")
    .description("Serve the kit over stdio, or over Streamable HTTP at /mcp with --http (needs PLANTWORKS_MCP_TOKEN). Reads PLANTWORKS_TEAM, PLANTWORKS_BROKER_URL and PLANTWORKS_BROKER_TOKEN")
    .option("--http", "serve Streamable HTTP instead of stdio; every request needs Authorization: Bearer $PLANTWORKS_MCP_TOKEN")
    .option("--bind <host:port>", "with --http: where to listen", MCP_DEFAULT_BIND)
    .action(async (opts: { http?: boolean; bind: string }) => {
      try {
        const kit = kitOptions(process.env);
        if (!opts.http) return await serveStdio(kit);
        const m = /^(.*):(\d+)$/.exec(opts.bind);
        if (!m) throw new Error(`--bind must be host:port, not ${opts.bind}`);
        const server = await serveHttp({ ...kit, host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]), token: process.env.PLANTWORKS_MCP_TOKEN ?? "" });
        console.error(`plantworks kit for ${kit.team} listening on ${server.url}`);
        const stop = () => void server.close();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      } catch (e) {
        console.error(`mcp: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
