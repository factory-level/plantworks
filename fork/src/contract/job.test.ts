// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DNS_NAME, INITIAL_STATES, JOB_ID, JOB_STATES,
  canTransition, isTerminal, parseJobId, transition, validateEnvelope,
} from "./job.ts";

const schema = JSON.parse(readFileSync(new URL("../../schema/job-envelope.schema.json", import.meta.url), "utf8"));
const good = { jobId: "kb-board1-card9-a1", team: "social-media", task: { prompt: "Draft the weekly post" } };

test("the normal path, approval, cancel and retry are the only legal moves", () => {
  const legal = new Set([
    "held>queued", "held>cancelled", "queued>claimed", "queued>cancelled",
    "claimed>running", "running>done", "running>failed", "failed>retried",
  ]);
  for (const from of JOB_STATES) for (const to of JOB_STATES) {
    assert.equal(canTransition(from, to), legal.has(`${from}>${to}`), `${from} -> ${to}`);
  }
  assert.deepEqual(JOB_STATES.filter(isTerminal), ["done", "cancelled", "retried"]);
  assert.deepEqual([...INITIAL_STATES], ["queued", "held"]);
});

test("terminal transitions require their detail", () => {
  assert.deepEqual(transition("running", "done", { outcome: "succeeded" }), { outcome: "succeeded" });
  assert.deepEqual(transition("running", "done", { outcome: "succeeded", closure: "handoff-sre" }), { outcome: "succeeded", closure: "handoff-sre" });
  assert.throws(() => transition("running", "done"), /needs outcome/);
  assert.throws(() => transition("running", "done", { outcome: "succeeded", closure: "other" }), /handoff-sre/);
  assert.deepEqual(transition("running", "failed", { reason: "call-deadline" }), { reason: "call-deadline" });
  assert.throws(() => transition("running", "failed", { reason: "denied" }), /needs reason/);
  assert.deepEqual(transition("held", "cancelled", { reason: "approval-expired" }), { reason: "approval-expired" });
  assert.throws(() => transition("queued", "claimed", { outcome: "succeeded" }), /does not take outcome/);
  assert.throws(() => transition("done", "running"), /illegal job transition done -> running/);
  assert.throws(() => transition("claimed", "failed", { reason: "error" }), /illegal/);
});

test("jobId parses into board, card and attempt", () => {
  assert.deepEqual(parseJobId("kb-board1-card9-a12"), { board: "board1", cardId: "card9", attempt: 12 });
  for (const bad of ["kb-board-card-a0", "kb-board-card", "x-board-card-a1", "kb-bo-ard-card-a1"]) assert.equal(parseJobId(bad), null, bad);
});

test("valid envelopes get the default class", () => {
  const r = validateEnvelope(good);
  assert.ok(r.ok);
  assert.equal(r.envelope.class, "quick");
  const full = { ...good, class: "long", task: { prompt: "x", title: "t" }, callback: { url: "https://frontdoor.example.invalid/cb" }, timeoutSeconds: 900 };
  assert.deepEqual(validateEnvelope(full), { ok: true, envelope: full });
});

test("invalid envelopes are rejected with every reason", () => {
  assert.deepEqual(validateEnvelope(null), { ok: false, errors: ["envelope must be an object"] });
  const r = validateEnvelope({ jobId: "card9", team: "Social_Media", task: { prompt: " ", extra: 1 }, callback: { url: "ftp://x" }, timeoutSeconds: 0, more: true });
  assert.ok(!r.ok);
  assert.deepEqual(r.errors.sort(), [
    "callback.url must be an http(s) URL",
    "jobId must match kb-<board>-<cardId>-a<attempt>",
    "task.prompt must be a non-empty string",
    "team must be a DNS-safe name",
    "timeoutSeconds must be a positive integer",
    "unknown field more",
    "unknown field task.extra",
  ]);
});

test("the published JSON Schema matches the validator", () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["jobId", "team", "task"]);
  assert.deepEqual(Object.keys(schema.properties), ["jobId", "team", "class", "task", "callback", "timeoutSeconds"]);
  assert.equal(schema.properties.jobId.pattern, JOB_ID.source);
  assert.equal(schema.properties.team.pattern, DNS_NAME.source);
  assert.equal(schema.properties.class.pattern, DNS_NAME.source);
  assert.equal(schema.properties.class.default, "quick");
  assert.deepEqual(schema.properties.task.required, ["prompt"]);
  assert.deepEqual(Object.keys(schema.properties.task.properties), ["prompt", "title"]);
  assert.deepEqual(schema.properties.callback.required, ["url"]);
});
