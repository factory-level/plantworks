// SPDX-License-Identifier: Apache-2.0
// Under daemon.db_conflict=stop, `plantworks daemon start` checks for another daemon on the database before
// upstream spawns its daemon. Upstream's own check (packages/daemon/src/daemon-db-path.ts:72-118) reads a slow
// or failing probe (lsof over 1 s, healthz over 500 ms) as "no holder" and starts. This one runs the same
// probes and reads such a result as inconclusive, which refuses the start. It is a best-effort check for a
// confirmed holder, not an atomic lock: a daemon that opens the database after it runs is not seen.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { realPath } from "./boot.ts";

/** A probe's answer. `lsof` exit 1 with no output means "nothing found". */
export type Lsof = (args: string[]) => Promise<{ code: number; stdout: string } | { error: string }>;
export type Healthz = (port: number) => Promise<{ pid?: unknown } | { error: string }>;

export type Verdict = { kind: "none" } | { kind: "own-home" } | { kind: "confirmed"; why: string } | { kind: "inconclusive"; why: string };

const LSOF_TIMEOUT_MS = 2000;
const HEALTHZ_TIMEOUT_MS = 2000;

export const lsofProbe: Lsof = (args) => new Promise((resolve) => {
  execFile("lsof", args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024, killSignal: "SIGKILL" }, (e, stdout) => {
    if (!e) return resolve({ code: 0, stdout });
    const err = e as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    if (err.killed) return resolve({ error: `lsof gave no answer within ${LSOF_TIMEOUT_MS} ms` });
    if (typeof err.code === "number") return resolve({ code: err.code, stdout });
    resolve({ error: `lsof could not run (${err.code ?? err.message})` });
  });
});

export const healthzProbe: Healthz = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) });
    if (!res.ok) return { error: `healthz on port ${port} answered ${res.status}` };
    return await res.json() as { pid?: unknown };
  } catch (e) {
    return { error: `healthz on port ${port}: ${(e as Error).name === "TimeoutError" ? `no answer within ${HEALTHZ_TIMEOUT_MS} ms` : (e as Error).message}` };
  }
};

/** Who holds `db`, by upstream's rule: an open-file holder whose daemon.json (same pid and db) and healthz (same pid) agree. */
export async function dbHolder(db: string, home: string, probes: { lsof?: Lsof; healthz?: Healthz; self?: number } = {}): Promise<Verdict> {
  const lsof = probes.lsof ?? lsofProbe;
  const healthz = probes.healthz ?? healthzProbe;
  let target: string;
  try { target = realPath(db); } catch (e) { return { kind: "inconclusive", why: `cannot resolve ${db}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }; }
  if (!existsSync(target)) return { kind: "none" }; // nothing holds a database that doesn't exist yet (a fresh home)
  const holders = await lsof(["-t", "--", target]);
  if ("error" in holders) return { kind: "inconclusive", why: holders.error };
  if (holders.code !== 0 && (holders.code !== 1 || holders.stdout.trim())) return { kind: "inconclusive", why: `lsof exited ${holders.code}` };
  const pids = [...new Set(holders.stdout.trim().split(/\s+/).filter(Boolean).map(Number))].filter((p) => Number.isSafeInteger(p) && p > 0 && p !== (probes.self ?? process.pid));
  const ownRecord = join(home, "daemon.json");
  for (const pid of pids) {
    const files = await lsof(["-a", "-p", String(pid), "-d", "1,2", "-Fn"]);
    if ("error" in files) return { kind: "inconclusive", why: files.error };
    const homes = new Set([dirname(target)]);
    for (const line of files.stdout.split("\n")) if (line.startsWith("n") && basename(line.slice(1)) === "daemon.log") homes.add(dirname(line.slice(1)));
    for (const candidate of homes) {
      const recordPath = join(candidate, "daemon.json");
      let record: { pid?: unknown; db?: unknown; port?: unknown };
      try { record = JSON.parse(readFileSync(recordPath, "utf8")); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { kind: "inconclusive", why: `pid ${pid} holds ${target}, and ${recordPath} is unreadable (${(e as NodeJS.ErrnoException).code ?? "not JSON"})` };
      }
      let recordDb: string | undefined;
      try { recordDb = typeof record.db === "string" ? realPath(record.db) : undefined; } catch { recordDb = undefined; }
      if (record.pid !== pid || recordDb !== target || !Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) continue;
      const health = await healthz(record.port as number);
      if ("error" in health) return { kind: "inconclusive", why: `pid ${pid} holds ${target} and ${recordPath} names it, but ${health.error}` };
      if (health.pid !== pid) continue;
      if (realPath(recordPath) === realPath(ownRecord)) return { kind: "own-home" };
      return { kind: "confirmed", why: `another live daemon (pid ${pid}, record ${recordPath}) has ${target} open` };
    }
  }
  return { kind: "none" };
}

/** The refusal for `daemon start`, or null to let upstream start. Only `stop` without the one-boot escape checks. */
export async function dbConflictRefusal(opts: { db: string; home: string; policy: unknown; allow: boolean; probes?: Parameters<typeof dbHolder>[2] }): Promise<string | null> {
  if (opts.policy !== "stop" || opts.allow) return null;
  const v = await dbHolder(opts.db, opts.home, opts.probes);
  if (v.kind === "confirmed") return `OPENRIG_DB_CONFLICT: ${v.why}; daemon start stopped before opening it (daemon.db_conflict=stop). Use separate database paths, or run daemon start --allow-db-conflict once deliberately`;
  if (v.kind === "inconclusive") return `cannot confirm that no other daemon has the database open (${v.why}); daemon start stopped (daemon.db_conflict=stop). Retry, set daemon.db_conflict=warn, or run daemon start --allow-db-conflict once deliberately`;
  return null; // none, or this home's own daemon: upstream says "already running"
}
