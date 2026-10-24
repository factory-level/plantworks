// SPDX-License-Identifier: Apache-2.0
import type { DaemonQueue } from "./claim.ts";
import type { Emit } from "./server.ts";
import type { Store } from "./store.ts";

/** Reconcile at most one batch from persisted qitem ids. Ambiguity always keeps the slot. */
export function createReconciler(store: Store, daemon: DaemonQueue, emit: Emit, log: (line: string) => void = (line) => process.stderr.write(`${line}\n`), limit = 16) {
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
      const item = await daemon.inspect(qitemId);
      lastLogged.delete(qitemId);
      if (item.qitemId !== qitemId) continue;
      if (item.destinationSession !== (row.claimed_by ?? row.reserved_by)) continue;
      let current = store.get(row.job_id);
      if (!current || !["queued", "claimed", "running"].includes(current.state)) continue;
      if (current.state === "queued") {
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
      const closing = item.transitions.find((t) => t.state === "done" && t.closureReason === "no-follow-on" && t.closureTarget == null && t.transitionId === item.closingTransition?.transitionId);
      if (item.state !== "done" || item.closureReason !== "no-follow-on" || item.closureTarget != null || !closing || closing.actorSession !== item.destinationSession || closing.identityProvenance !== "transport:v1") continue;
      if (current.state === "claimed") {
        const running = store.transition(current.job_id, "running");
        emit(running.row, "running", running.detail);
        current = running.row;
      }
      if (current.state !== "running") continue;
      const { row: done, detail } = store.transition(current.job_id, "done", { outcome: "succeeded" }, { result: JSON.stringify({ qitemId }) });
      emit(done, done.state, detail);
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
