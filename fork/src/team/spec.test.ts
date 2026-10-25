// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealedEnv } from "../test-support/sealed-env.ts";
import { promisify } from "node:util";
import { emitTeam } from "./command.ts";
import { PHASE_0_1, buildSpec, hermesProfileConfig, validateSpec, type TeamSpec } from "./spec.ts";

// The ADR 0204 sample (Phase 0–1 values), as a team definition. The Hermes profile is derived.
const definition = () => ({
  team: "social-media",
  trains: 1,
  perTrain: { orchestrators: 1, workers: { quick: 1, long: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" },
  defaultClass: "quick",
  classes: {
    quick: { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, toolProfile: "default", approval: "never", timeoutSeconds: 900, maxAttempts: 2 },
    long: { slots: 0, model: "qwen3.5:9b", context: { maxContextTokens: 32768, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1024, deadlineSeconds: 60 }, approval: "per-job", timeoutSeconds: 3600, maxAttempts: 1 },
  },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
});
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 1 } };
const spec = (edit: (d: any) => void = () => {}) => { const d: any = definition(); edit(d); return buildSpec(d) as any; };
const problems = (edit: (d: any) => void, p = platform) => validateSpec(spec(edit), p);

// The kit's references stay literal: Hermes resolves them, and refuses to connect while one is unset.
const PROFILE_CONFIG = "kanban:\n  max_in_progress_per_profile: 1\n" +
  'mcp_servers:\n  plantworks:\n    url: "${PLANTWORKS_MCP_URL}"\n    headers:\n      Authorization: "Bearer ${PLANTWORKS_MCP_TOKEN}"\n' +
  "    tools:\n      include: [job_submit, job_inspect, job_cancel, job_stats]\n";

test("the ADR sample is valid, and its profile carries trains × orchestrators as an integer", () => {
  const s = spec();
  assert.deepEqual(validateSpec(s, platform), []);
  assert.deepEqual(s.hermesProfile, { name: "social-media", kanban: { max_in_progress_per_profile: 1 } });
  assert.equal(buildSpec({ ...definition(), trains: 3 }).hermesProfile.kanban.max_in_progress_per_profile, 3);
  assert.equal(hermesProfileConfig(s as TeamSpec), PROFILE_CONFIG);
});

test("callback auth accepts only an optional configured secret reference", () => {
  assert.deepEqual(problems((d) => { d.events.auth = { secretRef: "FRONTDOOR_TOKEN" }; }), []);
  assert.match(problems((d) => { d.events.auth = { secretRef: "missing-lowercase" }; }).join("\n"), /secretRef must name a configured credential/);
  assert.match(problems((d) => { d.events.auth = { secretRef: "FRONTDOOR_TOKEN", token: "inline-secret" }; }).join("\n"), /unknown field events\.auth\.token/);
  assert.match(problems((d) => { d.events.callbackDefault = "https://untrusted.invalid/events"; }).join("\n"), /callbackDefault must be exactly one operator callback reference/);
  assert.match(problems((d) => { d.events.callbackDefault = "${FRONTDOOR_CALLBACK}/events"; }).join("\n"), /callbackDefault must be exactly one operator callback reference/);
});

test("the ADR's map form of max_in_progress_per_profile is rejected (Hermes 0.22.5 would read it as no cap)", () => {
  const s = spec();
  s.hermesProfile.kanban.max_in_progress_per_profile = { "social-media": 1 };
  assert.match(validateSpec(s, platform).join("\n"), /hermesProfile must be .*"max_in_progress_per_profile":1/);
  s.hermesProfile = { name: "other", kanban: { max_in_progress_per_profile: 1 } };
  assert.equal(validateSpec(s, platform).length, 1, "a profile name other than the team is rejected too");
  s.hermesProfile = { name: "social-media", kanban: { max_in_progress_per_profile: 1, extra: 2 } };
  assert.equal(validateSpec(s, platform).length, 1, "an extra kanban key is rejected");
});

test("key order in the spec does not matter (JSON objects are unordered)", () => {
  const s = spec();
  s.hermesProfile = { kanban: { max_in_progress_per_profile: 1 }, name: "social-media" };
  assert.deepEqual(validateSpec(s, platform), []);
  const reversed = Object.fromEntries(Object.entries(spec()).reverse());
  assert.deepEqual(validateSpec(reversed, platform), []);
});

test("each ADR validator rule rejects what it should", () => {
  const cases: [string, (d: any) => void, RegExp, typeof platform?][] = [
    ["1 slot cap", () => {}, /1 slots, over the platform cap of 0 for slot budget "social-media"/, PHASE_0_1],
    ["1 slot cap", (d) => { d.classes.long.slots = 1; d.trains = 1; }, /2 slots, over the platform cap of 1/],
    ["2 served model", (d) => { d.classes.quick.model = "big:70b"; }, /classes\.quick\.model must be a served model/],
    ["3 context max", (d) => { d.classes.long.context.maxContextTokens = 65536; }, /context 65536 > 32768/],
    ["3 baseline", () => {}, /Pi baseline \+ output \+ reserve \(16384\) must be below the context \(16384\)/, { ...platform, piBaselineTokens: 14000, reserveTokens: 848 }],
    ["4 seats >= slots", (d) => { d.perTrain.workers.quick = 0; }, /1 slots but only 0 worker seats/],
    ["6 always needs TTL", (d) => { d.classes.long.approval = "always"; }, /approval "always" needs approvalTtlSeconds/],
    ["7 DNS names", (d) => { d.team = "Social_Media"; }, /team must be a DNS-safe name/],
    ["7 DNS names", (d) => { d.classes.Quick = d.classes.quick; delete d.classes.quick; d.defaultClass = "Quick"; d.perTrain.workers = { Quick: 1, long: 1 }; }, /classes\.Quick: class names must be DNS-safe/],
    ["8 perCall set", (d) => { delete d.classes.quick.perCall; }, /classes\.quick\.perCall must set/],
    ["8 perCall ceilings", (d) => { d.classes.long.perCall.maxOutputTokens = 1536; d.classes.quick.perCall.deadlineSeconds = 90; }, /long exceeds a platform ceiling: output 1536 > 1024[\s\S]*quick exceeds a platform ceiling: deadline 90s > 60s|quick exceeds a platform ceiling: deadline 90s > 60s[\s\S]*long exceeds a platform ceiling: output 1536 > 1024/],
    ["thinking off", (d) => { d.classes.quick.context.thinkingTokens = 512; }, /thinkingTokens must be 0/],
    ["default class", (d) => { d.defaultClass = "huge"; }, /defaultClass must name one of the classes/],
    ["default class 16K", (d) => { d.defaultClass = "long"; }, /defaultClass long has a 32768-token context; the default class is at most 16384/],
    ["one orchestrator", (d) => { d.perTrain.orchestrators = 2; }, /perTrain\.orchestrators must be 1/],
    ["unknown field", (d) => { d.classes.quick.perCall.temperature = 0; d.extra = 1; }, /unknown field extra[\s\S]*unknown field classes\.quick\.perCall\.temperature/],
    ["worker class", (d) => { d.perTrain.workers.ghost = 1; }, /perTrain\.workers\.ghost is not a class/],
  ];
  for (const [rule, edit, expected, p] of cases) assert.match(problems(edit, p).join("\n"), expected, rule);
});

test("emit writes the spec and an unmodified Hermes profile file, or nothing when invalid", () => {
  const out = mkdtempSync(join(tmpdir(), "pw-team-"));
  const result = emitTeam(definition(), out, platform);
  assert.ok("files" in result);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "social-media", "team.json"), "utf8")), spec());
  assert.equal(readFileSync(join(out, "social-media", "hermes-profile", "config.yaml"), "utf8"), PROFILE_CONFIG);
  const skill = readFileSync(join(out, "social-media", "hermes-profile", "skills", "plantworks-bridge", "SKILL.md"), "utf8");
  assert.match(skill, /^---\n[\s\S]*\nname: plantworks-bridge\n/);

  const bad = mkdtempSync(join(tmpdir(), "pw-team-"));
  assert.ok("errors" in emitTeam({ ...definition(), trains: 0 }, bad, platform));
  assert.ok("errors" in emitTeam({ ...definition(), hermesProfile: {} }, bad, platform));
  assert.equal(existsSync(join(bad, "social-media")), false);
});

test("`plantworks pw team emit` and `validate` work end to end with a platform file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-team-cli-"));
  writeFileSync(join(dir, "def.json"), JSON.stringify(definition()));
  writeFileSync(join(dir, "platform.json"), JSON.stringify(platform));
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [bin, "pw", "team", ...args], { env: sealedEnv() });
  await run("emit", join(dir, "def.json"), "--out", join(dir, "out"), "--platform", join(dir, "platform.json"));
  assert.match((await run("validate", join(dir, "out", "social-media", "team.json"), "--platform", join(dir, "platform.json"))).stdout, /team spec ok/);
  // Without a platform file there are no slot caps, so a team that wants a slot is refused.
  await assert.rejects(run("validate", join(dir, "out", "social-media", "team.json")), (e: { code: number; stderr: string }) => e.code === 1 && /platform cap of 0/.test(e.stderr));
});

test("the published fleet.schema.json names exactly the validator's fields", () => {
  const schema = JSON.parse(readFileSync(new URL("../../schema/fleet.schema.json", import.meta.url), "utf8"));
  const keys = (o: any) => Object.keys(o.properties).sort();
  const s = spec();
  assert.deepEqual(keys(schema), Object.keys(s).sort());
  assert.deepEqual(schema.required.sort(), Object.keys(s).sort());
  const cls = schema.properties.classes.additionalProperties;
  assert.deepEqual(keys(cls), ["approval", "approvalTtlSeconds", "context", "maxAttempts", "model", "perCall", "priority", "slots", "timeoutSeconds", "toolProfile", "workspace"]);
  assert.deepEqual(keys(cls.properties.context), Object.keys(s.classes.quick.context).sort());
  assert.deepEqual(keys(cls.properties.perCall), Object.keys(s.classes.quick.perCall).sort());
  assert.equal(schema.properties.hermesProfile.properties.kanban.properties.max_in_progress_per_profile.type, "integer");
  for (const part of ["perTrain", "endpoint", "hermesProfile"]) assert.deepEqual(keys(schema.properties[part]), Object.keys(s[part]).sort(), part);
  assert.deepEqual(keys(schema.properties.events), [...Object.keys(s.events), "auth"].sort());
  assert.deepEqual(schema.properties.events.required, ["callbackDefault", "approvalConsumer"]);
});

test("W4-A: a class's optional workspace must be an absolute path", () => {
  assert.deepEqual(problems((d) => { d.classes.quick.workspace = "/srv/seats/quick"; }), []);
  for (const bad of ["relative/dir", "", 42, "~/repo"]) {
    assert.ok(problems((d) => { d.classes.quick.workspace = bad; }).some((e) => e.includes("classes.quick.workspace must be an absolute path")), JSON.stringify(bad));
  }
});
