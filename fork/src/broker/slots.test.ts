// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { capFor, parseSlotCaps } from "./slots.ts";

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
