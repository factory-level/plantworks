// SPDX-License-Identifier: Apache-2.0
// PW-22: a Pi seat's liveness, read from the runner-state.json sidecar that upstream's pi-runner
// writes in the seat's state directory. Only runner-authored state is read, as the daemon does
// (pi-runner-protocol.ts BR-1): never Pi's TUI. Upstream's own path and parser are used, so a
// layout change upstream shows up here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePiRunnerState, piSeatPaths } from "../../../packages/daemon/dist/adapters/pi-runner-protocol.js";
import { seatAgentDir } from "./pi-seat-files.ts";

/**
 * - `live`: the runner reported Pi ready, and no exit.
 * - `exited`: the runner recorded that Pi exited. This is the only verdict that says the seat is dead.
 * - `starting`: no sidecar yet, or a launch the runner hasn't reported ready.
 * - `unknown`: the sidecar can't be read or parsed (for example mid-write).
 *
 * The sidecar is written on runner events, not on a timer, so `live` can't tell a hung runner from
 * an idle one. And `exited` is about the Pi process only: it says nothing about a broker job's state.
 */
export type SeatLiveness = { verdict: "live" | "exited" | "starting" | "unknown"; detail: string };

export function seatLiveness(openrigHome: string, seat: string): SeatLiveness {
  seatAgentDir(openrigHome, seat); // the same session-name check the seat files use
  const path = piSeatPaths(join(openrigHome, "state", "pi"), seat).runnerStatePath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { verdict: "starting", detail: `no ${path} yet: the seat has not been launched` };
    return { verdict: "unknown", detail: `cannot read ${path}: ${(e as Error).message}` };
  }
  const state = parsePiRunnerState(raw);
  if (!state) return { verdict: "unknown", detail: `${path} is not a runner state` };
  if (state.exited) return { verdict: "exited", detail: `Pi exited (code ${state.exited.code ?? "unknown"}) at ${state.exited.at}` };
  if (!state.ready) return { verdict: "starting", detail: `launch ${state.launchId ?? "?"} not ready yet (updated ${state.updatedAt})` };
  return { verdict: "live", detail: `ready, launch ${state.launchId ?? "?"} (updated ${state.updatedAt})` };
}
