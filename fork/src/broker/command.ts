// SPDX-License-Identifier: Apache-2.0
// `plantworks pw broker serve`: the broker for a set of teams, with its own SQLite file.
import { join } from "node:path";
import type { Command } from "commander";
import { loadPlatform } from "../team/command.ts";
import { loadTeams, startBroker } from "./server.ts";
import { openStore } from "./store.ts";
import { claimNextRoutes, daemonQueue } from "./claim.ts";
import { parseSlotCaps, slotCapProblems } from "./slots.ts";
import { callCeilingsFromEnv } from "../llm/classes.ts";
import { createReconciler } from "./reconcile.ts";
import { runtimeRoutes } from "./runtime.ts";

/** The daemon's port is 7533 (PW-16); the broker sits next to it. */
export const BROKER_DEFAULTS = { host: "127.0.0.1", port: 7534, daemonUrl: "http://127.0.0.1:7533", session: "plantworks-broker" } as const;

export function brokerVerb(pw: Command): void {
  const broker = pw.command("broker").description("The Plantworks job broker (ADR 0204)");
  broker
    .command("serve")
    .description("Serve the jobs API for every team spec under --teams. Refuses to start if any spec is invalid")
    .option("--teams <dir>", "directory of emitted <team>/team.json (default: $PLANTWORKS_TEAMS_DIR)")
    .option("--platform <file>", "platform file the specs are validated against, as for `pw team validate`")
    .option("--db <path>", "broker SQLite file (default: $OPENRIG_HOME/plantworks/broker.sqlite)")
    .option("--host <host>", "bind address; anything but loopback needs PLANTWORKS_BROKER_TOKEN", BROKER_DEFAULTS.host)
    .option("--port <port>", "port", String(BROKER_DEFAULTS.port))
    .option("--public-url <url>", "the broker's address as callers reach it, for approval decision URLs (default: $PLANTWORKS_BROKER_PUBLIC_URL, else the listen address)")
    .action(async (opts: { teams?: string; platform?: string; db?: string; host: string; port: string; publicUrl?: string }) => {
      const dir = opts.teams ?? process.env.PLANTWORKS_TEAMS_DIR;
      let store;
      try {
        if (!dir) throw new Error("no team specs: pass --teams or set PLANTWORKS_TEAMS_DIR");
        // PW-19: PLANTWORKS_SLOT_CAP per slotBudgetKey, 1 in flight per key when unset; the per-call
        // ceilings come from PLANTWORKS_MAX_CALL_SECONDS and PLANTWORKS_MAX_CALL_OUTPUT. A bad value,
        // a class over a ceiling, or classes asking for more slots than the cap refuse to start.
        const slotCaps = parseSlotCaps(process.env.PLANTWORKS_SLOT_CAP);
        const teams = loadTeams(dir, { ...loadPlatform(opts.platform), callCeilings: callCeilingsFromEnv(process.env) });
        const over = slotCapProblems(teams, slotCaps);
        if (over.length) throw new Error(`team specs exceed the runtime slot cap:\n  ${over.join("\n  ")}`);
        store = openStore(opts.db ?? join(process.env.OPENRIG_HOME!, "plantworks", "broker.sqlite"));
        // claim-next (PW-18) hands jobs to seats through the daemon's queue: PLANTWORKS_DAEMON_URL, with
        // the daemon's own OPENRIG_AUTH_BEARER_TOKEN when it has one.
        const daemon = daemonQueue({ url: process.env.PLANTWORKS_DAEMON_URL?.trim() || BROKER_DEFAULTS.daemonUrl, token: process.env.OPENRIG_AUTH_BEARER_TOKEN?.trim() || undefined });
        const brokerSession = process.env.PLANTWORKS_BROKER_SESSION?.trim() || BROKER_DEFAULTS.session;
        const routes = [claimNextRoutes({ daemon, slotCaps, brokerSession }), runtimeRoutes({ slotCaps })];
        const server = await startBroker({ store, teams, routes, token: process.env.PLANTWORKS_BROKER_TOKEN?.trim() || undefined, host: opts.host, port: Number(opts.port), publicUrl: opts.publicUrl ?? (process.env.PLANTWORKS_BROKER_PUBLIC_URL?.trim() || undefined), onListen: ({ store, emit }) => {
          let reconciling = false;
          const run = createReconciler(store, daemon, emit, (line) => console.error(line), undefined, { brokerSession });
          const timer = setInterval(async () => {
            if (reconciling) return;
            reconciling = true;
            try { await run(); } finally { reconciling = false; }
          }, 2_000);
          return () => clearInterval(timer);
        } });
        console.log(`plantworks broker listening on ${server.url} for ${[...teams.keys()].join(", ")}`);
        const stop = async () => { await server.close(); store!.close(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      } catch (e) {
        store?.close();
        console.error(`broker: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
