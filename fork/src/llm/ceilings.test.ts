// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { CEILINGS, callCeilingsFromEnv, ceilingProblems } from "./classes.ts";

test("PLANTWORKS_MAX_CALL_SECONDS / _OUTPUT: unset keeps the ADR ceilings; a value may only tighten them", () => {
  for (const env of [{}, { PLANTWORKS_MAX_CALL_SECONDS: "", PLANTWORKS_MAX_CALL_OUTPUT: " " }]) assert.deepEqual(callCeilingsFromEnv(env), CEILINGS);
  assert.deepEqual(callCeilingsFromEnv({ PLANTWORKS_MAX_CALL_SECONDS: "60", PLANTWORKS_MAX_CALL_OUTPUT: "1536/1024" }), CEILINGS, "the ADR values themselves");
  const tight = callCeilingsFromEnv({ PLANTWORKS_MAX_CALL_SECONDS: "30", PLANTWORKS_MAX_CALL_OUTPUT: "1024" });
  assert.deepEqual(tight, { ...CEILINGS, deadlineSeconds: 30, outputTokensUpTo16K: 1024, outputTokensAbove16K: 1024 });
  const quick = { model: "m", maxContextTokens: 16384, maxOutputTokens: 1536, deadlineSeconds: 60 };
  assert.deepEqual(ceilingProblems(quick), []);
  assert.deepEqual(ceilingProblems(quick, tight), ["deadline 60s > 30s", "output 1536 > 1024 tokens"]);
});

test("a malformed, non-positive or loosening ceiling is refused, naming the variable", () => {
  const bad: [Record<string, string>, RegExp][] = [
    [{ PLANTWORKS_MAX_CALL_SECONDS: "0" }, /MAX_CALL_SECONDS: "0" is not a positive integer/],
    [{ PLANTWORKS_MAX_CALL_SECONDS: "-5" }, /MAX_CALL_SECONDS/],
    [{ PLANTWORKS_MAX_CALL_SECONDS: "1.5" }, /MAX_CALL_SECONDS/],
    [{ PLANTWORKS_MAX_CALL_SECONDS: "90" }, /MAX_CALL_SECONDS: 90 is above the platform ceiling of 60/],
    [{ PLANTWORKS_MAX_CALL_OUTPUT: "2048/1024" }, /MAX_CALL_OUTPUT: 2048 is above the platform ceiling of 1536/],
    [{ PLANTWORKS_MAX_CALL_OUTPUT: "1536" }, /MAX_CALL_OUTPUT: 1536 is above the platform ceiling of 1024/],
    [{ PLANTWORKS_MAX_CALL_OUTPUT: "1/2/3" }, /MAX_CALL_OUTPUT/],
    [{ PLANTWORKS_MAX_CALL_OUTPUT: "lots" }, /MAX_CALL_OUTPUT/],
    [{ PLANTWORKS_MAX_CALL_OUTPUT: "1024/" }, /MAX_CALL_OUTPUT/],
  ];
  for (const [env, re] of bad) assert.throws(() => callCeilingsFromEnv(env), re, JSON.stringify(env));
});
