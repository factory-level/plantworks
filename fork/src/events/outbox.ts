// SPDX-License-Identifier: Apache-2.0
import type { JobRow, Store, TransitionRow } from "../broker/store.ts";
import { jobStateEvent, type CloudEvent } from "./job-state.ts";

const BATCH_SIZE = 100;
const MAX_DELIVERY_CYCLES = 3;

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
    ...(Array.isArray(result?.artifacts) ? { artifacts: result.artifacts as { name: string; uri: string }[] } : {}),
    ...(Array.isArray(result?.evidence) ? { evidence: result.evidence as { kind: string; uri: string }[] } : {}),
    ...(result?.usage && typeof result.usage === "object" ? { usage: result.usage as { promptTokens: number; completionTokens: number } } : {}),
  }, transition.to_state, JSON.parse(transition.detail), new Date(transition.at));
}

export function transitionColumns(store: Store, transition: TransitionRow): Record<string, unknown> {
  const rows = store.db.prepare("SELECT columns FROM job_transitions WHERE job_id = ? AND id <= ? ORDER BY id")
    .all(transition.job_id, transition.id) as { columns: string }[];
  return Object.assign({}, ...rows.map((row) => JSON.parse(row.columns)));
}

/** Delivers each team's committed transitions independently; a poison event is parked after a bounded retry budget. */
export function createJobStateOutbox(
  store: Store,
  deliver: (team: string, event: CloudEvent) => Promise<void>,
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
      parked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (team, transition_id)
    );
  `);
  const readCursor = store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = ?");
  const addCursor = store.db.prepare("INSERT OR IGNORE INTO event_outbox_team_cursor (team, delivered_through) VALUES (?, 0)");
  const advance = store.db.prepare("UPDATE event_outbox_team_cursor SET delivered_through = ? WHERE team = ? AND delivered_through = ?");
  const failed = store.db.prepare("SELECT attempts, parked FROM event_outbox_failures WHERE team = ? AND transition_id = ?");
  const recordFailure = store.db.prepare(`INSERT INTO event_outbox_failures (team, transition_id, attempts, last_error, parked)
    VALUES (?, ?, 1, ?, 0) ON CONFLICT(team, transition_id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error`);
  const park = store.db.prepare("UPDATE event_outbox_failures SET parked = 1 WHERE team = ? AND transition_id = ?");
  const clearFailure = store.db.prepare("DELETE FROM event_outbox_failures WHERE team = ? AND transition_id = ?");
  let running: Promise<void> | undefined;

  async function drain() {
    const teams = store.db.prepare("SELECT DISTINCT team FROM jobs ORDER BY team").all() as { team: string }[];
    for (const { team } of teams) {
      addCursor.run(team);
      for (;;) {
        const cursor = (readCursor.get(team) as { delivered_through: number }).delivered_through;
        const rows = store.db.prepare(`SELECT t.* FROM job_transitions t JOIN jobs j ON j.job_id = t.job_id
          WHERE j.team = ? AND t.id > ? ORDER BY t.id LIMIT ?`).all(team, cursor, BATCH_SIZE) as TransitionRow[];
        if (!rows.length) break;
        let blocked = false;
        let currentCursor = cursor;
        for (const transition of rows) {
          const prior = failed.get(team, transition.id) as { attempts: number; parked: number } | undefined;
          if (prior?.parked) {
            advance.run(transition.id, team, currentCursor);
            currentCursor = transition.id;
            blocked = true;
            break;
          }
          const job = store.get(transition.job_id);
          if (!job) throw new Error(`transition ${transition.id} has no job ${transition.job_id}`);
          const event = eventForTransition(job, transition, transitionColumns(store, transition));
          try {
            await deliver(team, event);
            clearFailure.run(team, transition.id);
            if (advance.run(transition.id, team, currentCursor).changes !== 1) { blocked = true; break; }
            currentCursor = transition.id;
          } catch (error) {
            recordFailure.run(team, transition.id, (error as Error).message);
            const state = failed.get(team, transition.id) as { attempts: number; parked: number };
            if (state.attempts >= MAX_DELIVERY_CYCLES) {
              const commitPark = store.db.transaction(() => {
                park.run(team, transition.id);
                advance.run(transition.id, team, currentCursor);
              });
              commitPark();
              log(`plantworks event parked after ${state.attempts} delivery cycles: ${event.id}`);
              blocked = true;
              break;
            }
            blocked = true;
            break;
          }
          // Cursor advances are monotonic; read the value for the next row in this batch.
          // Each team is drained serially, while other teams continue after this one pauses.
          const next = readCursor.get(team) as { delivered_through: number };
          if (next.delivered_through !== transition.id) { blocked = true; break; }
        }
        if (blocked) break;
      }
    }
  }

  function pump(): Promise<void> {
    if (!running) {
      running = drain().catch((error: unknown) => {
        log(`plantworks event outbox pump failed: ${(error as Error).message}`);
      }).finally(() => { running = undefined; });
    }
    return running;
  }

  return {
    pump,
    /** The transition was already committed; waking delivery cannot hold the job request open. */
    wake: (_row?: unknown, _state?: unknown, _detail?: unknown) => { void pump(); },
  };
}
