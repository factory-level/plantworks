// SPDX-License-Identifier: Apache-2.0
import type { JobRow, Store, TransitionRow } from "../broker/store.ts";
import { DeliveryAborted, jobStateEvent, type CloudEvent } from "./job-state.ts";
import { handoffEvent, type HandoffData } from "../broker/handoff.ts";

const BATCH_SIZE = 100;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

function summaryOf(task: { prompt: string; title?: string }): string {
  if (task.title) return task.title;
  let summary = "";
  for (const point of task.prompt) {
    if (Buffer.byteLength(summary) + Buffer.byteLength(point) > 2048) break;
    summary += point;
  }
  return summary;
}

export function eventForTransition(job: JobRow, transition: TransitionRow, columns: Record<string, unknown> = JSON.parse(transition.columns)): CloudEvent {
  const envelope = JSON.parse(job.envelope) as { task: { prompt: string; title?: string } };
  const result = typeof columns.result === "string" ? JSON.parse(columns.result) as Record<string, unknown> : undefined;
  return jobStateEvent({
    jobId: job.job_id, team: job.team, transitionSeq: transition.id,
    qitemId: typeof columns.qitem_id === "string" ? columns.qitem_id : undefined,
    seat: typeof columns.claimed_by === "string" ? columns.claimed_by : undefined,
    summary: summaryOf(envelope.task),
    // D11: artifacts only when there are some, as `pw job run` sends them (W4-A).
    ...(Array.isArray(result?.artifacts) && result.artifacts.length ? { artifacts: result.artifacts as { name: string; uri: string }[] } : {}),
    ...(Array.isArray(result?.evidence) ? { evidence: result.evidence as { kind: string; uri: string }[] } : {}),
    ...(result?.usage && typeof result.usage === "object" ? { usage: result.usage as { promptTokens: number; completionTokens: number } } : {}),
  }, transition.to_state, JSON.parse(transition.detail), new Date(transition.at));
}

/**
 * Every event one transition carries, in delivery order: its job.state and, for a handoff done (PW-34),
 * then plantworks.handoff.requested. All are derived from the persisted row, so a redelivery is identical.
 */
export function eventsForTransition(job: JobRow, transition: TransitionRow, columns: Record<string, unknown> = JSON.parse(transition.columns)): CloudEvent[] {
  const events = [eventForTransition(job, transition, columns)];
  const detail = JSON.parse(transition.detail) as { closure?: unknown };
  const result = typeof columns.result === "string" ? JSON.parse(columns.result) as { handoff?: HandoffData } : undefined;
  if (transition.to_state === "done" && detail.closure === "handoff-sre" && result?.handoff) {
    events.push(handoffEvent({
      jobId: job.job_id, team: job.team, transitionId: transition.id, at: new Date(transition.at),
      qitemId: typeof columns.qitem_id === "string" ? columns.qitem_id : undefined,
      seat: typeof columns.claimed_by === "string" ? columns.claimed_by : undefined,
    }, result.handoff));
  }
  return events;
}

export function transitionColumns(store: Store, transition: TransitionRow): Record<string, unknown> {
  const rows = store.db.prepare("SELECT columns FROM job_transitions WHERE job_id = ? AND id <= ? ORDER BY id")
    .all(transition.job_id, transition.id) as { columns: string }[];
  return Object.assign({}, ...rows.map((row) => JSON.parse(row.columns)));
}

/** Delivers each team's committed transitions independently; only permanent failures are parked. */
export function createJobStateOutbox(
  store: Store,
  deliver: (team: string, event: CloudEvent, signal: AbortSignal) => Promise<void>,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox_team_cursor (
      team TEXT PRIMARY KEY,
      delivered_through INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_outbox_failures (
      team TEXT NOT NULL,
      transition_id INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_error TEXT NOT NULL,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      logged INTEGER NOT NULL DEFAULT 0,
      parked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team, transition_id)
    );
  `);
  const failureColumns = new Set((store.db.prepare("PRAGMA table_info(event_outbox_failures)").all() as { name: string }[]).map((column) => column.name));
  if (!failureColumns.has("next_attempt_at")) store.db.exec("ALTER TABLE event_outbox_failures ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
  if (!failureColumns.has("logged")) store.db.exec("ALTER TABLE event_outbox_failures ADD COLUMN logged INTEGER NOT NULL DEFAULT 0");
  const readCursor = store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = ?");
  const addCursor = store.db.prepare("INSERT OR IGNORE INTO event_outbox_team_cursor (team, delivered_through) VALUES (?, 0)");
  const advance = store.db.prepare("UPDATE event_outbox_team_cursor SET delivered_through = ? WHERE team = ? AND delivered_through = ?");
  const failed = store.db.prepare("SELECT attempts, parked, next_attempt_at, logged FROM event_outbox_failures WHERE team = ? AND transition_id = ?");
  const recordFailure = store.db.prepare(`INSERT INTO event_outbox_failures (team, transition_id, attempts, last_error, next_attempt_at, logged, parked)
    VALUES (?, ?, 1, ?, ?, ?, ?) ON CONFLICT(team, transition_id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at, logged = MAX(event_outbox_failures.logged, excluded.logged), parked = excluded.parked`);
  const park = store.db.prepare("UPDATE event_outbox_failures SET parked = 1 WHERE team = ? AND transition_id = ?");
  const clearFailure = store.db.prepare("DELETE FROM event_outbox_failures WHERE team = ? AND transition_id = ?");
  const running = new Map<string, Promise<void>>();
  // stop() aborts in-flight deliveries; after it, nothing reads or writes the store.
  const stopping = new AbortController();

  async function drainTeam(team: string) {
    if (stopping.signal.aborted) return;
    addCursor.run(team);
    for (;;) {
        if (stopping.signal.aborted) return;
        const cursor = (readCursor.get(team) as { delivered_through: number }).delivered_through;
        const rows = store.db.prepare(`SELECT t.* FROM job_transitions t JOIN jobs j ON j.job_id = t.job_id
          WHERE j.team = ? AND t.id > ? ORDER BY t.id LIMIT ?`).all(team, cursor, BATCH_SIZE) as TransitionRow[];
        if (!rows.length) break;
        let blocked = false;
        let currentCursor = cursor;
        for (const transition of rows) {
          const prior = failed.get(team, transition.id) as { attempts: number; parked: number; next_attempt_at: number; logged: number } | undefined;
          if (prior?.parked) {
            advance.run(transition.id, team, currentCursor);
            currentCursor = transition.id;
            blocked = true;
            break;
          }
          if (prior && prior.next_attempt_at > Date.now()) { blocked = true; break; }
          const job = store.get(transition.job_id);
          if (!job) throw new Error(`transition ${transition.id} has no job ${transition.job_id}`);
          // One transition, one cursor step: a pair (job.state, handoff.requested) advances only after both.
          // A failure of either is the transition's, and a retry redelivers both with unchanged ids.
          const events = eventsForTransition(job, transition, transitionColumns(store, transition));
          let event = events[0]!;
          if (stopping.signal.aborted) return;
          try {
            for (event of events) await deliver(team, event, stopping.signal);
            clearFailure.run(team, transition.id);
            if (advance.run(transition.id, team, currentCursor).changes !== 1) { blocked = true; break; }
            currentCursor = transition.id;
          } catch (error) {
            // An aborted delivery is not a failure: no row, no cursor move. The next start replays it with the same id.
            if (error instanceof DeliveryAborted || stopping.signal.aborted) return;
            const permanent = error instanceof Error && "permanent" in error && error.permanent === true;
            const attempts = (prior?.attempts ?? 0) + 1;
            const shouldLog = permanent || !prior?.logged;
            const nextAttemptAt = permanent ? 0 : Date.now() + Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(attempts - 1, 9));
            recordFailure.run(team, transition.id, (error as Error).message, nextAttemptAt, shouldLog ? 1 : 0, permanent ? 1 : 0);
            if (shouldLog) log(permanent
              ? `plantworks event parked after permanent delivery failure: ${event.id}`
              : `plantworks event delivery deferred: ${event.id}: ${(error as Error).message}`);
            if (permanent) {
              const commitPark = store.db.transaction(() => {
                park.run(team, transition.id);
                advance.run(transition.id, team, currentCursor);
              });
              commitPark();
              blocked = true;
              break;
            }
            blocked = true;
            break;
          }
          // Cursor advances are monotonic; read the value for the next row in this batch.
          // One delivery per team is in flight, while teams drain independently.
          const next = readCursor.get(team) as { delivered_through: number };
          if (next.delivered_through !== transition.id) { blocked = true; break; }
        }
        if (blocked) break;
    }
  }

  function pump(): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    const teams = store.db.prepare("SELECT DISTINCT team FROM jobs ORDER BY team").all() as { team: string }[];
    for (const { team } of teams) {
      if (running.has(team)) continue;
      let task: Promise<void>;
      task = drainTeam(team).catch((error: unknown) => {
        log(`plantworks event outbox pump failed for ${team}: ${(error as Error).message}`);
      }).finally(() => {
        if (running.get(team) === task) running.delete(team);
      });
      running.set(team, task);
    }
    return Promise.all(running.values()).then(() => {});
  }

  return {
    pump,
    /** Aborts in-flight deliveries and resolves once every team's drain has returned. */
    stop: async () => {
      stopping.abort();
      await Promise.all(running.values());
    },
    /** The transition was already committed; waking delivery cannot hold the job request open. */
    wake: (_row?: unknown, _state?: unknown, _detail?: unknown) => { void pump(); },
  };
}
