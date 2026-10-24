// SPDX-License-Identifier: Apache-2.0
// The broker's own SQLite store: one jobs table in its own file, never the daemon's database.
// better-sqlite3 is the driver upstream's daemon already ships; nothing new is installed.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { transition as checkTransition, type JobEnvelope, type JobState, type TransitionDetail } from "../contract/job.ts";

/**
 * How old a claim-next reservation must be before reconciliation (PW-21) treats it as stuck and
 * looks at it. Age never releases a reservation or lets another seat take the job: once the
 * daemon may have created and delivered the qitem, nothing short of verified evidence proves Pi
 * never started.
 */
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
  /** When a held job's approval TTL runs out (PW-23); null for no TTL. */
  approval_expires_at: string | null;
  /** approved, denied or expired, once a held job is decided (PW-23). */
  approval_decision: string | null;
}

/** Extra columns a transition may set alongside the state (PW-18 sets claimed_by, claimed_at and qitem_id). */
export type TransitionColumns = Partial<Pick<JobRow, "claimed_by" | "claimed_at" | "qitem_id" | "result" | "approval_decision">>;
const TRANSITION_COLUMNS = ["claimed_by", "claimed_at", "qitem_id", "result", "approval_decision"];

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
  result TEXT,
  approval_expires_at TEXT,
  approval_decision TEXT
);
CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (team, class, state, seq);
-- PW-22: seats told to take no new work (worker preStop). Kept across broker restarts.
CREATE TABLE IF NOT EXISTS seat_drains (seat TEXT PRIMARY KEY, since TEXT NOT NULL);
-- W3-A: every state a job enters, appended in the transaction that changes the state. Never updated.
CREATE TABLE IF NOT EXISTS job_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  columns TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_transitions_job ON job_transitions (job_id, id);
`;
/** Columns added after PW-17, for a broker file created before them. */
const ADDED_COLUMNS = ["approval_expires_at TEXT", "approval_decision TEXT"];

export type Store = ReturnType<typeof openStore>;

/** One row of a job's durable history: every state it entered, written in the same transaction as the state. */
export interface TransitionRow {
  /** Monotonic across the store: a reader can resume after the last id it saw. */
  id: number;
  job_id: string;
  /** null for the job's initial state (queued or held, at submit). */
  from_state: JobState | null;
  to_state: JobState;
  /** JSON: the checked PW-09 detail of this transition, `{}` when it carries none. */
  detail: string;
  /** JSON: the job row columns this transition set (claimed_by, claimed_at, qitem_id, result, approval_decision). */
  columns: string;
  at: string;
}

export function openStore(path: string, now: () => Date = () => new Date()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  const have = new Set((db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
  for (const col of ADDED_COLUMNS) if (!have.has(col.split(" ")[0]!)) db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);
  const iso = () => now().toISOString();
  // IMMEDIATE: the write lock is taken up front, so a read inside the transaction can't go stale
  // against another broker process on the same file. Nested calls run as savepoints.
  const tx = <T>(fn: () => T): T => db.transaction(fn).immediate();
  const get = (jobId: string) => db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  const record = (jobId: string, from: JobState | null, to: JobState, detail: unknown, columns: TransitionColumns, at: string) =>
    db.prepare("INSERT INTO job_transitions (job_id, from_state, to_state, detail, columns, at) VALUES (?, ?, ?, ?, ?, ?)").run(jobId, from, to, JSON.stringify(detail), JSON.stringify(columns), at);

  /**
   * One PW-09 transition and its row update, atomically. Throws on an illegal transition. A reserved
   * job moves only for its holder (`holder`, from confirmClaim). The check is both a read inside
   * the immediate transaction and a condition on the UPDATE itself.
   */
  const apply = (jobId: string, to: JobState, detail: Record<string, unknown>, columns: TransitionColumns, holder?: { seat: string; qitemId: string }) => tx(() => {
    const row = get(jobId);
    if (!row) throw new Error(`no job ${jobId}`);
    if (row.reserved_by && !holder) throw new Error(`job ${jobId} is reserved for a seat; settle the handoff with confirmClaim or release first`);
    const checked = checkTransition(row.state, to, detail);
    const names = Object.keys(columns);
    const bad = names.filter((c) => !TRANSITION_COLUMNS.includes(c));
    if (bad.length) throw new Error(`transition cannot set ${bad.join(", ")}`);
    const sets = names.map((c) => `, ${c} = @${c}`).join("");
    const at = iso();
    const guard = holder ? "reserved_by = @seat AND reserved_qitem_id = @qitemId" : "reserved_by IS NULL";
    const r = db.prepare(`UPDATE jobs SET state = @to, detail = @detail, updated_at = @at, reserved_by = NULL, reserved_at = NULL, reserved_qitem_id = NULL${sets} WHERE job_id = @jobId AND state = @from AND ${guard}`)
      .run({ ...columns, to, from: row.state, detail: JSON.stringify(checked), at, jobId, seat: holder?.seat ?? null, qitemId: holder?.qitemId ?? null });
    if (r.changes !== 1) throw new Error(`job ${jobId} changed while it was being moved to ${to}`);
    record(jobId, row.state, to, checked, columns, at);
    return { row: get(jobId)!, detail: checked };
  });

  const store = {
    db,
    tx,
    get,

    /** Persisted upstream work that may still own a logical slot. */
    unresolved(limit = 64, afterSeq = 0): JobRow[] {
      return db.prepare("SELECT * FROM jobs WHERE seq > ? AND state IN ('queued','claimed','running') AND (qitem_id IS NOT NULL OR reserved_qitem_id IS NOT NULL) ORDER BY seq LIMIT ?").all(afterSeq, limit) as JobRow[];
    },

    /** Inserts a new job, or returns the existing row for that jobId (`created` says which). A held job may carry its approval TTL. */
    insert(envelope: JobEnvelope, cls: string, state: JobState, approvalTtlSeconds?: number): { row: JobRow; created: boolean } {
      return tx(() => {
        const at = iso();
        const expires = approvalTtlSeconds === undefined ? null : new Date(now().getTime() + approvalTtlSeconds * 1000).toISOString();
        const r = db.prepare("INSERT OR IGNORE INTO jobs (job_id, team, class, state, envelope, created_at, updated_at, approval_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(envelope.jobId, envelope.team, cls, state, JSON.stringify(envelope), at, at, expires);
        if (r.changes === 1) record(envelope.jobId, null, state, {}, {}, at);
        return { row: get(envelope.jobId)!, created: r.changes === 1 };
      });
    },

    /**
     * Applies one PW-09 transition and its row update atomically. Throws on an illegal transition.
     * `claimed` is refused here: only confirmClaim may claim, because it checks the reservation.
     */
    transition(jobId: string, to: JobState, detail: Record<string, unknown> = {}, columns: TransitionColumns = {}): { row: JobRow; detail: TransitionDetail } {
      if (to === "claimed") throw new Error("claim through confirmClaim, which checks the reservation");
      // A reserved job is mid-handoff and its qitem may be delivered (PW-19 fail-closed): only
      // confirmClaim or a verified release may end the reservation; apply() refuses it here.
      return apply(jobId, to, detail, columns);
    },

    /**
     * PW-18's claim-next reservation: the oldest queued job for (team, class) that nobody has
     * reserved. The state stays queued and nothing is emitted. A reserved job is never taken over,
     * however old the reservation: only `confirmClaim` or a verified `release` ends it.
     */
    reserve(team: string, cls: string, seat: string, qitemId: string): JobRow | undefined {
      return tx(() => {
        const row = db.prepare("SELECT * FROM jobs WHERE team = ? AND class = ? AND state = 'queued' AND reserved_by IS NULL ORDER BY seq LIMIT 1")
          .get(team, cls) as JobRow | undefined;
        if (!row) return undefined;
        db.prepare("UPDATE jobs SET reserved_by = ?, reserved_at = ?, reserved_qitem_id = ? WHERE job_id = ?").run(seat, iso(), qitemId, row.job_id);
        return get(row.job_id);
      });
    },

    /**
     * Turns a reservation into the claim: queued -> claimed, only if the job is still reserved by
     * this seat with this qitem. Otherwise returns "lost".
     */
    confirmClaim(jobId: string, seat: string, qitemId: string): { row: JobRow; detail: TransitionDetail } | "lost" {
      return tx(() => {
        const row = get(jobId);
        if (!row || row.state !== "queued" || row.reserved_by !== seat || row.reserved_qitem_id !== qitemId) return "lost";
        return apply(jobId, "claimed", {}, { claimed_by: seat, claimed_at: iso(), qitem_id: qitemId }, { seat, qitemId });
      });
    },

    /**
     * Durable transition history, oldest first: rows after `afterId`, optionally for one job. A job
     * submitted before this table existed has no rows for its earlier states.
     */
    transitions(opts: { afterId?: number; jobId?: string; limit?: number } = {}): TransitionRow[] {
      return db.prepare(`SELECT * FROM job_transitions WHERE id > @afterId${opts.jobId === undefined ? "" : " AND job_id = @jobId"} ORDER BY id LIMIT @limit`)
        .all({ afterId: opts.afterId ?? 0, jobId: opts.jobId, limit: opts.limit ?? 1000 }) as TransitionRow[];
    },

    /** PW-22: marks a seat draining (claim-next gives it no new work), or resumes it. */
    setDraining(seat: string, draining: boolean): void {
      if (draining) db.prepare("INSERT OR IGNORE INTO seat_drains (seat, since) VALUES (?, ?)").run(seat, iso());
      else db.prepare("DELETE FROM seat_drains WHERE seat = ?").run(seat);
    },
    isDraining: (seat: string) => db.prepare("SELECT 1 FROM seat_drains WHERE seat = ?").get(seat) !== undefined,
    drainingSeats: () => (db.prepare("SELECT seat FROM seat_drains ORDER BY seat").all() as { seat: string }[]).map((r) => r.seat),

    /**
     * Jobs a seat still holds: claimed or running for it, or queued under its reservation of any
     * age (the qitem may already have been delivered). The same lifecycle rule as the PW-19 slot count.
     */
    seatInFlight(seat: string): JobRow[] {
      return db.prepare("SELECT * FROM jobs WHERE (state IN ('claimed', 'running') AND claimed_by = @seat) OR (state = 'queued' AND reserved_by = @seat) ORDER BY seq").all({ seat }) as JobRow[];
    },

    /** Live jobs by team, class and state; `reserved` counts queued jobs under a reservation. */
    liveCounts(): { team: string; class: string; state: JobState; reserved: number; n: number }[] {
      return db.prepare("SELECT team, class, state, reserved_by IS NOT NULL AS reserved, COUNT(*) AS n FROM jobs WHERE state IN ('held', 'queued', 'claimed', 'running') GROUP BY team, class, state, reserved").all() as never;
    },

    /** Held jobs whose approval TTL has run out. */
    expiredHolds(): JobRow[] {
      return db.prepare("SELECT * FROM jobs WHERE state = 'held' AND approval_expires_at IS NOT NULL AND approval_expires_at <= ? ORDER BY seq").all(iso()) as JobRow[];
    },

    /**
     * Drops a reservation, only if it is still this seat's with this qitem. Call it only on
     * evidence that the qitem was never delivered (the daemon refused to create it, or
     * reconciliation verified it doesn't exist): releasing makes the job claimable again.
     */
    release(jobId: string, seat: string, qitemId: string): void {
      db.prepare("UPDATE jobs SET reserved_by = NULL, reserved_at = NULL, reserved_qitem_id = NULL WHERE job_id = ? AND reserved_by = ? AND reserved_qitem_id = ?").run(jobId, seat, qitemId);
    },

    close: () => db.close(),
  };
  return store;
}
