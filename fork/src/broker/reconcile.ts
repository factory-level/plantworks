// SPDX-License-Identifier: Apache-2.0
import { recoverHandoff, type DaemonQueue } from "./claim.ts";
import type { Emit } from "./server.ts";
import type { Store } from "./store.ts";

/**
 * Reconcile at most one batch from persisted qitem ids. Ambiguity always keeps the slot. With
 * `recovery`, a stuck claim-next handoff is first finished with its own qitem id (recoverHandoff).
 */
export function createReconciler(store: Store, daemon: DaemonQueue, emit: Emit, log: (line: string) => void = (line) => process.stderr.write(`${line}\n`), limit = 16, recovery?: { brokerSession: string; now?: () => number }) {
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
      let closingIndex = item.transitions.length - 1;
      while (closingIndex >= 0 && item.transitions[closingIndex]!.state === "done") closingIndex--;
      const closing = item.transitions[closingIndex + 1];
      // transitions are ordered oldest-first; a later reopen invalidates an older done snapshot.
      if (item.transitions.at(-1)?.state !== "done") continue;
      if (item.state !== "done" || item.closureReason !== "no-follow-on" || item.closureTarget != null || !closing || closing.closureReason !== "no-follow-on" || closing.closureTarget != null || closing.transitionId !== item.closingTransition?.transitionId || closing.actorSession !== item.destinationSession || closing.identityProvenance !== "transport:v1") continue;
      if (current.state === "claimed") {
        const running = store.transition(current.job_id, "running");
        emit(running.row, "running", running.detail);
        current = running.row;
      }
      if (current.state !== "running") continue;
      const { row: done, detail } = store.transition(current.job_id, "done", { outcome: "succeeded" }, { result: JSON.stringify({ text: null, artifacts: [] }) });
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
