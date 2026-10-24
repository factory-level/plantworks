// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  JOB_PRIORITIES,
  DNS_NAME, INITIAL_STATES, JOB_ID, JOB_STATES, MAX_PROMPT, MAX_TITLE,
  canTransition, isTerminal, parseJobId, transition, validateEnvelope,
} from "./job.ts";

const schema = JSON.parse(readFileSync(new URL("../../schema/job-envelope.schema.json", import.meta.url), "utf8"));
const good = { jobId: "kb-board1-card9-a1", team: "social-media", task: { prompt: "Draft the weekly post" } };

test("the normal path, approval, cancel and retry are the only legal moves", () => {
  const legal = new Set([
    "held>queued", "held>cancelled", "queued>claimed", "queued>cancelled",
    "claimed>running", "claimed>failed", "running>done", "running>failed", "failed>retried",
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
  assert.deepEqual(transition("claimed", "failed", { reason: "error" }), { reason: "error" });
});

test("jobId parses into board, card and attempt", () => {
  assert.deepEqual(parseJobId("kb-board1-card9-a12"), { board: "board1", cardId: "card9", attempt: 12 });
  assert.deepEqual(parseJobId("kb-social-media-t_3fa9c01e-a1"), { board: "social-media", cardId: "t_3fa9c01e", attempt: 1 });
  assert.deepEqual(parseJobId("kb-team_ops-x-t_00ff00ff-a2"), { board: "team_ops-x", cardId: "t_00ff00ff", attempt: 2 });
  for (const bad of [
    "kb-board-card-a0", "kb-board-card", "x-board-card-a1", "kb-board--a1", "kb-Board-t_1-a1", "kb-_b-t_1-a1",
    `kb-${"b".repeat(65)}-c-a1`, `kb-b-${"c".repeat(65)}-a1`,
  ]) {
    assert.equal(parseJobId(bad), null, bad);
  }
});

test("valid envelopes pass unchanged; the broker resolves an absent class", () => {
  assert.deepEqual(validateEnvelope(good), { ok: true, envelope: good });
  const full = { ...good, class: "long", task: { prompt: "x", title: "t" }, timeoutSeconds: 900, repo: "factory-level/plantworks", contextBudget: 8192, origin: { kind: "card", ref: "PW-09" } };
  assert.deepEqual(validateEnvelope(full), { ok: true, envelope: full });
  assert.deepEqual(validateEnvelope({ ...good, repo: "o/r", origin: { kind: "opaque", ref: "anything" } }).ok, true);
});

test("published envelope examples pass the runtime validator", () => {
  const examples = new URL("../../schema/examples/", import.meta.url);
  const names = readdirSync(examples).filter((name) => name.endsWith(".json"));
  assert.ok(names.length > 0, "publish at least one JSON envelope example");
  for (const name of names) {
    const envelope = JSON.parse(readFileSync(new URL(name, examples), "utf8"));
    assert.equal(validateEnvelope(envelope).ok, true, name);
  }
});

test("invalid envelopes are rejected with every reason", () => {
  assert.deepEqual(validateEnvelope(null), { ok: false, errors: ["envelope must be an object"] });
  const r = validateEnvelope({ jobId: "card9", team: "Social_Media", task: { prompt: " ", extra: 1 }, timeoutSeconds: 0, callback: { url: "http://127.0.0.1/" } });
  assert.ok(!r.ok);
  assert.deepEqual(r.errors.sort(), [
    "jobId must match kb-<board>-<cardId>-a<attempt>",
    `task.prompt must be a non-empty string of at most ${MAX_PROMPT} characters`,
    "team must be a DNS-safe name",
    "timeoutSeconds must be a positive integer",
    "unknown field callback",
    "unknown field task.extra",
  ]);
  const long = validateEnvelope({ ...good, task: { prompt: "x".repeat(MAX_PROMPT + 1), title: "t".repeat(MAX_TITLE + 1) } });
  assert.ok(!long.ok);
  assert.equal(long.errors.length, 2);
  for (const envelope of [
    { ...good, contextBudget: 0 },
    { ...good, contextBudget: 1.5 },
    { ...good, repo: "" },
    { ...good, repo: "o/" },
    { ...good, repo: "/r" },
    { ...good, repo: { owner: "o", name: "r" } },
    { ...good, origin: { kind: "card", ref: "x", url: "https://untrusted.example" } },
    { ...good, callback: { url: "http://127.0.0.1", auth: { token: "inline" } } },
  ]) assert.equal(validateEnvelope(envelope).ok, false, JSON.stringify(envelope));
});

const stripDescriptions = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stripDescriptions)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "description").map(([k, x]) => [k, stripDescriptions(x)]))
  : v;

test("the published JSON Schema matches the validator", () => {
  const dns = { type: "string", pattern: DNS_NAME.source };
  assert.deepEqual(stripDescriptions(schema), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/factory-level/plantworks/blob/main/fork/schema/job-envelope.schema.json",
    title: "Plantworks job envelope (v1)",
    type: "object",
    additionalProperties: false,
    required: ["jobId", "team", "task"],
    properties: {
      jobId: { type: "string", pattern: JOB_ID.source },
      team: dns,
      class: dns,
      task: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT, pattern: "\\S" },
          title: { type: "string", maxLength: MAX_TITLE },
        },
      },
      timeoutSeconds: { type: "integer", minimum: 1 },
      repo: { type: "string", pattern: "^[^/]+/[^/]+$" },
      contextBudget: { type: "integer", minimum: 1 },
      origin: { type: "object", additionalProperties: false, required: ["kind", "ref"], properties: { kind: { type: "string", minLength: 1 }, ref: { type: "string", minLength: 1 } } },
      priority: { enum: Object.keys(JOB_PRIORITIES) },
    },
  });
});
