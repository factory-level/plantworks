// SPDX-License-Identifier: Apache-2.0
// PW-34, the wake pause in (fork/docs/design/sre-handoff.md §2): while an SRE agent wakes, claim-next starts
// no new work. `POST /plantworks/v1/sre/wake` takes sre.wake.requested / sre.wake.ready CloudEvents. A wake
// pauses for at most 120 s; a replay never extends it; a `ready` seen first is remembered. The state is in
// memory, per broker process, so a restart resumes dispatch. Running jobs, submit, decisions, cancel,
// reconciliation and event delivery are untouched. Fork-defined event names, pending the HarnessHG ack.
import type { BrokerRoutes } from "./server.ts";
import { API } from "./server.ts";

export const WAKE_PAUSE_MS = 120_000;
const REMEMBER_MS = 10 * 60_000;
const MAX_BODY = 4096;
const WAKE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export interface WakePause {
  paused(): boolean;
  view(): { paused: boolean; wakes: { wakeId: string; agent: string; until: string }[] };
  routes: BrokerRoutes;
}

export function createWakePause(opts: { now?: () => number; log?: (line: string) => void } = {}): WakePause {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const active = new Map<string, { agent: string; until: number }>();
  /** Resolved or expired ids, and when they may be forgotten: a late or replayed `requested` for them is ignored. */
  const settled = new Map<string, number>();

  const sweep = () => {
    const t = now();
    for (const [id, w] of active) if (w.until <= t) { active.delete(id); settled.set(id, t + REMEMBER_MS); log(`plantworks broker: wake ${id} (${w.agent}) reached its ${WAKE_PAUSE_MS / 1000}s bound; dispatch resumes`); }
    for (const [id, forget] of settled) if (forget <= t) settled.delete(id);
  };

  return {
    paused: () => { sweep(); return active.size > 0; },
    view: () => {
      sweep();
      return { paused: active.size > 0, wakes: [...active].map(([wakeId, w]) => ({ wakeId, agent: w.agent, until: new Date(w.until).toISOString() })) };
    },
    routes: (app) => {
      app.post(`${API}/sre/wake`, async (c) => {
        const invalid = (message: string) => c.json({ error: "invalid_wake", message }, 400);
        const raw = await c.req.text();
        if (Buffer.byteLength(raw) > MAX_BODY) return invalid(`a wake event is at most ${MAX_BODY} bytes`);
        let e: { specversion?: unknown; type?: unknown; id?: unknown; source?: unknown; data?: { wakeId?: unknown; agent?: unknown } };
        try { e = JSON.parse(raw); } catch { return invalid("not JSON"); }
        if (!e || typeof e !== "object" || e.specversion !== "1.0" || typeof e.id !== "string" || !e.id || typeof e.source !== "string" || !e.source) return invalid("send a structured CloudEvent 1.0 with id and source");
        if (e.type !== "sre.wake.requested" && e.type !== "sre.wake.ready") return invalid("type must be sre.wake.requested or sre.wake.ready");
        const wakeId = e.data?.wakeId, agent = e.data?.agent;
        if (typeof wakeId !== "string" || !WAKE_ID.test(wakeId)) return invalid("data.wakeId must be 1..200 characters of [A-Za-z0-9._:-]");
        if (agent !== undefined && (typeof agent !== "string" || agent.length > 200)) return invalid("data.agent must be a string");
        sweep();
        const t = now();
        if (e.type === "sre.wake.requested") {
          // A replay never extends a pause, and a request for a settled id can't re-pause.
          if (!active.has(wakeId) && !settled.has(wakeId)) active.set(wakeId, { agent: (agent as string | undefined) ?? "", until: t + WAKE_PAUSE_MS });
        } else {
          active.delete(wakeId);
          settled.set(wakeId, t + REMEMBER_MS);
        }
        return c.json({ accepted: true, dispatch: active.size > 0 ? "paused" : "running" }, 202);
      });
    },
  };
}
