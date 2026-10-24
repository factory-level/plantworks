// SPDX-License-Identifier: Apache-2.0
// PW-19: the platform slot cap. At most N jobs are in flight per slotBudgetKey, across every team
// that shares the key. In flight means claimed or running, or queued under a claim-next
// reservation of any age: once the daemon may have created and delivered the qitem, Pi may be
// working, so the reservation holds its slot until confirmClaim or a verified release. claim-next counts and
// reserves in one immediate transaction, so concurrent claims can't both slip under the cap.
// This runtime cap is separate from the team spec's validation caps and from Hermes' kanban
// setting; neither one changes it.
import type { TeamSpec } from "../team/spec.ts";
import type { Store } from "./store.ts";

/** Phase 0–1: one job in flight per slot budget key when PLANTWORKS_SLOT_CAP doesn't say otherwise. */
export const DEFAULT_SLOT_CAP = 1;

export type SlotCaps = { fallback: number; byKey: Record<string, number> };

/**
 * PLANTWORKS_SLOT_CAP: comma-separated `key=n` entries, optionally with one bare `n` for every
 * other key, for example `social-media=1,support=2` or `2,social-media=1`. Unset or empty means
 * 1 per key. `0` stops claims for a key. Anything else throws: the broker refuses to start.
 */
export function parseSlotCaps(value: string | undefined): SlotCaps {
  const caps: SlotCaps = { fallback: DEFAULT_SLOT_CAP, byKey: {} };
  if (!value?.trim()) return caps;
  let bare = false;
  for (const part of value.split(",").map((p) => p.trim())) {
    const m = /^(?:([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)=)?(\d{1,6})$/.exec(part);
    if (!m) throw new Error(`PLANTWORKS_SLOT_CAP: "${part}" is not <key>=<n> or <n>`);
    const n = Number(m[3]);
    if (m[1] === undefined) {
      if (bare) throw new Error("PLANTWORKS_SLOT_CAP: more than one bare default");
      bare = true;
      caps.fallback = n;
    } else {
      if (Object.hasOwn(caps.byKey, m[1])) throw new Error(`PLANTWORKS_SLOT_CAP: ${m[1]} given twice`);
      caps.byKey[m[1]] = n;
    }
  }
  return caps;
}

export const capFor = (caps: SlotCaps, key: string): number => (Object.hasOwn(caps.byKey, key) ? caps.byKey[key] : caps.fallback);

/** Jobs in flight for a slot budget key: claimed, running, or queued under a reservation of any age. */
export function inFlight(store: Store, teams: Map<string, TeamSpec>, key: string): number {
  const sharing = [...teams.values()].filter((t) => t.endpoint.slotBudgetKey === key).map((t) => t.team);
  if (!sharing.length) return 0;
  const row = store.db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE team IN (${sharing.map(() => "?").join(",")}) AND (state IN ('claimed', 'running') OR (state = 'queued' AND reserved_by IS NOT NULL))`)
    .get(...sharing) as { n: number };
  return row.n;
}
