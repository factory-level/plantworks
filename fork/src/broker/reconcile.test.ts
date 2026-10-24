// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueueObservation } from "./claim.ts";
import { seatOutcome } from "./reconcile.ts";

const seat = "dev-a@team";
/** A qitem closed `done` by `actor` with `identity`, its closing transition being the latest. */
const closed = (closureReason: string | null, closureTarget: string | null, over: { actor?: string; identity?: string } = {}): QueueObservation => {
  const closing = { transitionId: 7, state: "done", closureReason, closureTarget, actorSession: over.actor ?? seat };
  return { qitemId: "qitem-1", state: "done", destinationSession: seat, closureReason, closureTarget, closingTransition: closing,
    transitions: [{ transitionId: 6, state: "in-progress", closureReason: null, closureTarget: null, actorSession: seat, identityProvenance: "transport:v1" }, { ...closing, identityProvenance: over.identity ?? "transport:v1" }] };
};

test("only the seat's own authenticated done closure maps to a done outcome", () => {
  assert.equal(seatOutcome(closed("no-follow-on", null)), "succeeded");
  assert.equal(seatOutcome(closed("denied", "rejected-by-checks")), "rejected-by-checks");
  // Proves nothing, so the job stays in flight and keeps its slot:
  for (const [why, item] of [
    ["denied with another reason text", closed("denied", "out of scope")],
    ["canceled", closed("canceled", null)],
    ["handed off", closed("handed_off_to", "dev-b@team")],
    ["an administrative close", closed("denied", "rejected-by-checks", { actor: "admin@team" })],
    ["a claimed (not transport) identity", closed("denied", "rejected-by-checks", { identity: "claimed:v1" })],
  ] as const) assert.equal(seatOutcome(item), null, why);
  const reopened = closed("denied", "rejected-by-checks");
  reopened.transitions.push({ transitionId: 8, state: "in-progress", closureReason: null, closureTarget: null, actorSession: seat, identityProvenance: "transport:v1" });
  assert.equal(seatOutcome({ ...reopened, state: "in-progress" }), null, "a reopen voids the earlier close");
  const failed = closed(null, null);
  failed.state = "failed";
  failed.transitions.at(-1)!.state = "failed";
  assert.equal(seatOutcome(failed), null, "qitem state failed is not a terminal closure upstream, even by the seat");
  const mismatch = closed("denied", "rejected-by-checks");
  mismatch.closingTransition!.transitionId = 99;
  assert.equal(seatOutcome(mismatch), null, "the daemon's closing transition must be the one in the history");
});
