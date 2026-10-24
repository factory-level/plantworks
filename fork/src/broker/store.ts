// SPDX-License-Identifier: Apache-2.0
// The broker's own SQLite store: one jobs table in its own file, never the daemon's database.
// better-sqlite3 is the driver upstream's daemon already ships; nothing new is installed.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { transition as checkTransition, type JobEnvelope, type JobState, type TransitionDetail } from "../contract/job.ts";

/** How long a claim-next reservation (PW-18) holds a queued job before another seat may take it. */
export const RESERVATION_LEASE_MS = 60_000;

export interface JobRow {
  seq: number;
  job_id: string;
  team: string;
  class: string;
  state: JobState;
  detail: string;
  envelope: string;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  qitem_id: string | null;
  reserved_by: string | null;
  reserved_at: string | null;
  reserved_qitem_id: string | null;
  result: string | null;
}

/** Extra columns a transition may set alongside the state (PW-18 sets claimed_by, claimed_at and qitem_id). */
export type TransitionColumns = Partial<Pick<JobRow, "claimed_by" | "claimed_at" | "qitem_id" | "result">>;
const TRANSITION_COLUMNS = ["claimed_by", "claimed_at", "qitem_id", "result"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  team TEXT NOT NULL,
  class TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  qitem_id TEXT,
  reserved_by TEXT,
  reserved_at TEXT,
  reserved_qitem_id TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (team, class, state, seq);
`;

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string, now: () => Date = () => new Date()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  const iso = () => now().toISOString();
  const tx = <T>(fn: () => T): T => db.transaction(fn)();
  const get = (jobId: string) => db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;

  return {
    db,
    tx,
    get,

    /** Inserts a new job, or returns the existing row for that jobId (`created` says which). */
    insert(envelope: JobEnvelope, cls: string, state: JobState): { row: JobRow; created: boolean } {
      return tx(() => {
        const at = iso();
        const r = db.prepare("INSERT OR IGNORE INTO jobs (job_id, team, class, state, envelope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(envelope.jobId, envelope.team, cls, state, JSON.stringify(envelope), at, at);
        return { row: get(envelope.jobId)!, created: r.changes === 1 };
      });
    },

    /** Applies one PW-09 transition and its row update atomically. Throws on an illegal transition. */
    transition(jobId: string, to: JobState, detail: Record<string, unknown> = {}, columns: TransitionColumns = {}): { row: JobRow; detail: TransitionDetail } {
      return tx(() => {
        const row = get(jobId);
        if (!row) throw new Error(`no job ${jobId}`);
        const checked = checkTransition(row.state, to, detail);
        const names = Object.keys(columns);
        const bad = names.filter((c) => !TRANSITION_COLUMNS.includes(c));
        if (bad.length) throw new Error(`transition cannot set ${bad.join(", ")}`);
        const sets = names.map((c) => `, ${c} = @${c}`).join("");
        db.prepare(`UPDATE jobs SET state = @to, detail = @detail, updated_at = @at, reserved_by = NULL, reserved_at = NULL, reserved_qitem_id = NULL${sets} WHERE job_id = @jobId`)
          .run({ ...columns, to, detail: JSON.stringify(checked), at: iso(), jobId });
        return { row: get(jobId)!, detail: checked };
      });
    },

    /**
     * PW-18's claim-next reservation: the oldest queued job for (team, class) that is unreserved
     * or whose lease has run out. The state stays queued and nothing is emitted.
     */
    reserve(team: string, cls: string, seat: string, qitemId: string, leaseMs = RESERVATION_LEASE_MS): JobRow | undefined {
      return tx(() => {
        const at = now();
        const expired = new Date(at.getTime() - leaseMs).toISOString();
        const row = db.prepare("SELECT * FROM jobs WHERE team = ? AND class = ? AND state = 'queued' AND (reserved_at IS NULL OR reserved_at <= ?) ORDER BY seq LIMIT 1")
          .get(team, cls, expired) as JobRow | undefined;
        if (!row) return undefined;
        db.prepare("UPDATE jobs SET reserved_by = ?, reserved_at = ?, reserved_qitem_id = ? WHERE job_id = ?").run(seat, at.toISOString(), qitemId, row.job_id);
        return get(row.job_id);
      });
    },

    /** Drops a reservation, if it is still the given seat's. */
    release(jobId: string, seat: string): void {
      db.prepare("UPDATE jobs SET reserved_by = NULL, reserved_at = NULL, reserved_qitem_id = NULL WHERE job_id = ? AND reserved_by = ?").run(jobId, seat);
    },

    close: () => db.close(),
  };
}
