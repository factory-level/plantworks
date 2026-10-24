// SPDX-License-Identifier: Apache-2.0
import type { JobRow, Store, TransitionRow } from "../broker/store.ts";
import { jobStateEvent, type CloudEvent } from "./job-state.ts";

const BATCH_SIZE = 100;

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

/** Replays committed job transitions until delivery succeeds, advancing only after a 2xx. */
export function createJobStateOutbox(
  store: Store,
  deliver: (team: string, event: CloudEvent) => Promise<void>,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox_cursor (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      delivered_through INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO event_outbox_cursor (singleton, delivered_through) VALUES (1, 0);
  `);
  const readCursor = store.db.prepare("SELECT delivered_through FROM event_outbox_cursor WHERE singleton = 1");
  const advance = store.db.prepare("UPDATE event_outbox_cursor SET delivered_through = ? WHERE singleton = 1 AND delivered_through = ?");
  let running: Promise<void> | undefined;

  async function drain() {
    for (;;) {
      const cursor = (readCursor.get() as { delivered_through: number }).delivered_through;
      const rows = store.transitions({ afterId: cursor, limit: BATCH_SIZE });
      if (!rows.length) return;
      let currentCursor = cursor;
      for (const transition of rows) {
        const job = store.get(transition.job_id);
        if (!job) throw new Error(`transition ${transition.id} has no job ${transition.job_id}`);
        const columns = store.db.prepare("SELECT columns FROM job_transitions WHERE job_id = ? AND id <= ? ORDER BY id").all(transition.job_id, transition.id) as { columns: string }[];
        const snapshot = Object.assign({}, ...columns.map((row) => JSON.parse(row.columns)));
        const event = eventForTransition(job, transition, snapshot);
        await deliver(job.team, event);
        if (advance.run(transition.id, currentCursor).changes !== 1) break;
        currentCursor = transition.id;
      }
    }
  }

  function pump(): Promise<void> {
    if (!running) {
      running = drain().catch((error: unknown) => {
        log(`plantworks event outbox paused: ${(error as Error).message}`);
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
