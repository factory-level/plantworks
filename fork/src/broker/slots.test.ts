// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { capFor, parseSlotCaps, slotCapProblems } from "./slots.ts";
import type { TeamSpec } from "../team/spec.ts";

test("PLANTWORKS_SLOT_CAP: unset means 1 per key; key=n entries and one bare default", () => {
  for (const unset of [undefined, "", "  "]) assert.deepEqual(parseSlotCaps(unset), { fallback: 1, byKey: {} });
  const caps = parseSlotCaps("2, social-media=1 ,support=0");
  assert.deepEqual(caps, { fallback: 2, byKey: { "social-media": 1, support: 0 } });
  assert.deepEqual([capFor(caps, "social-media"), capFor(caps, "support"), capFor(caps, "other")], [1, 0, 2]);
  assert.equal(capFor(parseSlotCaps("social-media=3"), "other"), 1, "an unlisted key keeps the default 1");
});

test("a bad PLANTWORKS_SLOT_CAP is refused, so the broker never starts on a guess", () => {
  for (const bad of ["-1", "x", "social-media=", "Social=1", "1,2", "a=1,a=2", "a=1.5", "unlimited"]) {
    assert.throws(() => parseSlotCaps(bad), /PLANTWORKS_SLOT_CAP/, bad);
  }
});

test("startup: the teams sharing a key may not ask for more slots than the runtime cap claim-next enforces", () => {
  const team = (name: string, key: string, ...slots: number[]) => [name, { endpoint: { slotBudgetKey: key }, classes: Object.fromEntries(slots.map((n, i) => [`c${i}`, { slots: n }])) }] as const;
  const teams = new Map([team("a", "shared", 1, 1), team("b", "shared", 1), team("c", "solo", 1, 0)]) as unknown as Map<string, TeamSpec>;
  assert.deepEqual(slotCapProblems(teams, parseSlotCaps("shared=3")), []);
  assert.deepEqual(slotCapProblems(teams, parseSlotCaps(undefined)), ["slot budget shared: the teams' classes ask for 3 slots, over PLANTWORKS_SLOT_CAP's 1"], "unset is 1 per key, the same default claim-next uses");
  assert.deepEqual(slotCapProblems(teams, parseSlotCaps("shared=3,solo=0")), ["slot budget solo: the teams' classes ask for 1 slots, over PLANTWORKS_SLOT_CAP's 0"]);
});
