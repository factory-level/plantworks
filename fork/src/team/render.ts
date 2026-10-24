// SPDX-License-Identifier: Apache-2.0
// PW-20: `plantworks pw team render`, the fleet view of a set of team specs. For each team: per
// class workers.max (trains × perTrain.workers[class]), its seat names (<class>-NN@<team>) and each
// seat's Pi files through PW-12's writeSeatFiles. Output goes only to a fresh --out directory: it
// never writes into a live OpenRig home and never touches a file it did not create.
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { classFromSpec } from "../llm/classes.ts";
import { seatAgentDir, writeSeatFiles } from "../seat/pi-seat-files.ts";
import type { TeamSpec } from "./spec.ts";

export interface FleetClass { workersMax: number; seats: string[] }
export interface FleetTeam { team: string; classes: Record<string, FleetClass> }

/** Seat names of a class: <class>-01@<team> … <class>-NN@<team>, NN at least two digits. */
export function seatNames(team: string, cls: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${cls}-${String(i + 1).padStart(2, "0")}@${team}`);
}

export function fleetFor(spec: TeamSpec): FleetTeam {
  const classes: Record<string, FleetClass> = {};
  for (const name of Object.keys(spec.classes)) {
    const workersMax = spec.trains * (spec.perTrain.workers[name] ?? 0);
    classes[name] = { workersMax, seats: seatNames(spec.team, name, workersMax) };
  }
  return { team: spec.team, classes };
}

/**
 * Homes a render must never write into: $OPENRIG_HOME, the directory of $OPENRIG_DB (a live home
 * at a custom path, even with OPENRIG_HOME unset), ~/.openrig and the PW-16 default ~/.plantworks.
 */
function liveHomes(env: Record<string, string | undefined>): string[] {
  return [env.OPENRIG_HOME, env.OPENRIG_DB && dirname(env.OPENRIG_DB), join(homedir(), ".openrig"), join(homedir(), ".plantworks")].filter((h): h is string => !!h).map(real);
}

/** Whether anything, a dangling symlink included, is at p. */
const present = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

/** The real path of p, or of its nearest existing ancestor joined with the rest. */
function real(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(real(parent), abs.slice(parent.length + 1));
}

/**
 * Writes, for every team: <out>/<team>/fleet.json, and the seat files at
 * <out>/<team>/state/pi/<seat>/agent (the layout writeSeatFiles uses under a home). Refuses, before
 * writing anything, an --out inside a live home, or a team directory that already exists.
 */
export function renderFleet(teams: Map<string, TeamSpec>, out: string, governorUrl: string, env: Record<string, string | undefined> = process.env): string[] {
  const target = real(out);
  for (const home of liveHomes(env)) {
    if (target === home || target.startsWith(home + sep)) throw new Error(`refusing to render into ${out}: it is inside the live home ${home}; pass a fresh --out`);
  }
  if (!/^https?:\/\/\S+$/.test(governorUrl)) throw new Error(`--governor-url must be an http(s) URL, got ${JSON.stringify(governorUrl)}`);
  for (const team of teams.keys()) if (present(join(out, team))) throw new Error(`refusing to render: ${join(out, team)} already exists; render into a fresh --out`);

  const files: string[] = [];
  for (const spec of teams.values()) {
    const home = join(out, spec.team);
    const fleet = fleetFor(spec);
    mkdirSync(home, { recursive: true });
    for (const [name, c] of Object.entries(fleet.classes)) {
      for (const seat of c.seats) {
        writeSeatFiles({ openrigHome: home, session: seat, className: name, governorUrl, workerClass: classFromSpec(spec.classes[name]!) });
        files.push(join(seatAgentDir(home, seat), "models.json"), join(seatAgentDir(home, seat), "settings.json"));
      }
    }
    const fleetFile = join(home, "fleet.json");
    writeFileSync(fleetFile, `${JSON.stringify(fleet, null, 2)}\n`, { flag: "wx" });
    files.push(fleetFile);
  }
  return files;
}
