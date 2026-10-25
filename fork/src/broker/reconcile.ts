// SPDX-License-Identifier: Apache-2.0
import { recoverHandoff, type DaemonQueue, type QueueObservation } from "./claim.ts";
import type { DoneOutcome } from "../contract/job.ts";
import type { Emit } from "./server.ts";
import type { Store } from "./store.ts";

/**
 * Reconcile at most one batch from persisted qitem ids. Ambiguity always keeps the slot. With
 * `recovery`, a stuck claim-next handoff is first finished with its own qitem id (recoverHandoff).
 * With `reportWaitMs` (W4-A), a job the seat has closed stays running until the worker's report is
 * stored or that long has passed, counted from the persisted start of the wait; 0 finishes at once.
 */
export function createReconciler(store: Store, daemon: DaemonQueue, emit: Emit, log: (line: string) => void = (line) => process.stderr.write(`${line}\n`), limit = 16, recovery?: { brokerSession: string; now?: () => number }, reportWaitMs = 0) {
  let cursor = 0;
  const lastLogged = new Map<string, number>();
  return async () => {
  let rows = store.unresolved(limit, cursor);
  if (!rows.length && cursor) { cursor = 0; rows = store.unresolved(limit); }
  if (rows.length) cursor = rows.at(-1)!.seq;
  for (const row of rows) {
    const qitemId = row.qitem_id ?? row.reserved_qitem_id;
    if (!qitemId) continue;
    try {
      if (recovery && (await recoverHandoff(store, daemon, recovery.brokerSession, row, recovery.now?.())) === "released") continue;
      const item = await daemon.inspect(qitemId);
      lastLogged.delete(qitemId);
      if (item.qitemId !== qitemId) continue;
      if (item.destinationSession !== (row.claimed_by ?? row.reserved_by)) continue;
      let current = store.get(row.job_id);
      if (!current || !["queued", "claimed", "running"].includes(current.state)) continue;
      if (current.state === "queued") {
        // A pending qitem isn't claimed upstream yet: claim-next is still handing it off, or
        // recoverHandoff claims it once the lease has passed. Confirm only once the daemon shows the claim.
        if (item.state === "pending") continue;
        const claimed = store.confirmClaim(current.job_id, item.destinationSession, qitemId);
        if (claimed === "lost") continue;
        emit(claimed.row, "claimed", claimed.detail);
        current = claimed.row;
      }
      if (item.state === "in-progress" && current.state === "claimed") {
        const running = store.transition(current.job_id, "running");
        emit(running.row, "running", running.detail);
        continue;
      }
      const closure = seatClosure(item);
      if (!closure) {
        // A reopen or handoff during the wait: the report would predate further work.
        if (current.state === "running" && current.report_wait_since !== null) store.clearReportWait(current.job_id);
        continue;
      }
      if (current.state === "claimed") {
        const running = store.transition(current.job_id, "running");
        emit(running.row, "running", running.detail);
        current = running.row;
      }
      if (current.state !== "running") continue;
      if (!reportWaitMs) {
        const { row: done, detail } = store.transition(current.job_id, "done", { outcome: closure.outcome }, { result: JSON.stringify({ text: null, artifacts: [] }) });
        emit(done, done.state, detail);
        continue;
      }
      const settled = store.settleReport(current.job_id, closure.outcome, closure.closingId, reportWaitMs);
      if (settled) emit(settled.row, settled.row.state, settled.detail);
    } catch (error) {
      const now = Date.now();
      if (now - (lastLogged.get(qitemId) ?? 0) >= 60_000) {
        log(`plantworks broker: reconciliation deferred for ${row.job_id} (${qitemId}): ${(error as Error).message}`);
        lastLogged.delete(qitemId);
        lastLogged.set(qitemId, now);
        if (lastLogged.size > 128) lastLogged.delete(lastLogged.keys().next().value!);
      }
    }
  }
  };
}

/**
 * The done outcome a qitem's closure proves, or null when it proves nothing and the job stays in
 * flight. Only the seat's own terminal closure counts: the exact qitem, `done`, closed by its
 * destination with `transport:v1` identity, where that closing transition is the latest one (no
 * reopen, handoff or later state since). Then:
 * - `no-follow-on` with no target: `succeeded`;
 * - `denied` with the target `rejected-by-checks`: `rejected-by-checks`. Upstream records `denied`
 *   as "receiver rejected the work" with the reason as its target (hot-potato-enforcer.ts); the
 *   target text is this fork's convention for the seat's checks rejecting the result.
 * Anything else, including the non-terminal qitem state `failed` and administrative closures,
 * proves nothing. This is logical completion reported by the seat, not proof that Pi stopped.
 */
export function seatOutcome(item: QueueObservation): DoneOutcome | null {
  return seatClosure(item)?.outcome ?? null;
}

/** seatOutcome, with the transitionId of the closing transition it accepted (W4-A: the report belongs to that closure). */
export function seatClosure(item: QueueObservation): { outcome: DoneOutcome; closingId: number } | null {
  if (item.state !== "done" || item.transitions.at(-1)?.state !== "done") return null;
  let first = item.transitions.length - 1;
  while (first > 0 && item.transitions[first - 1]!.state === "done") first--;
  const closing = item.transitions[first]!;
  if (closing.transitionId !== item.closingTransition?.transitionId || closing.actorSession !== item.destinationSession || closing.identityProvenance !== "transport:v1") return null;
  const reason = item.closureReason ?? null;
  const target = item.closureTarget ?? null;
  if (closing.closureReason !== reason || closing.closureTarget !== target) return null;
  if (reason === "no-follow-on" && target === null) return { outcome: "succeeded", closingId: closing.transitionId };
  if (reason === "denied" && target === "rejected-by-checks") return { outcome: "rejected-by-checks", closingId: closing.transitionId };
  return null;
}
