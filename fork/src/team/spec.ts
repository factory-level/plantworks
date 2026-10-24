// SPDX-License-Identifier: Apache-2.0
// The team spec (ADR 0204 "Team spec contract"): the one contract between the fork and the
// platform. It has three parts: the team (trains and their seats), its queue classes and its
// Hermes profile. The fork only reads a team definition and emits files; registration (#991)
// and deployment (#993) read them. Nothing here knows about Kubernetes or Pulumi.
import { DNS_NAME } from "../contract/job.ts";
import { ceilingProblems, type Ceilings } from "../llm/classes.ts";

export const SPEC_VERSION = "plantworks/v1";
export const APPROVALS = ["never", "per-job", "always"] as const;
export const TOOL_PROFILES = ["default", "trimmed"] as const;

export interface QueueClass {
  slots: number;
  model: string;
  context: { maxContextTokens: number; thinkingTokens: number };
  perCall: { maxOutputTokens: number; deadlineSeconds: number };
  toolProfile?: (typeof TOOL_PROFILES)[number];
  approval: (typeof APPROVALS)[number];
  /** Required when approval is `always`: how long a held job waits for a decision. */
  approvalTtlSeconds?: number;
  timeoutSeconds: number;
  maxAttempts: number;
}

/**
 * One train is one Hermes orchestrator cycle plus its worker seats, split across classes.
 * `kanban.max_in_progress_per_profile` is a single integer in Hermes 0.22.5
 * (hermes_cli/kanban_ops.py), so the profile carries trains × orchestrators as that integer.
 */
export interface TeamSpec {
  specVersion: typeof SPEC_VERSION;
  team: string;
  trains: number;
  perTrain: { orchestrators: number; workers: Record<string, number> };
  endpoint: { url: string; slotBudgetKey: string };
  defaultClass: string;
  classes: Record<string, QueueClass>;
  events: { callbackDefault: string; approvalConsumer: string };
  hermesProfile: { name: string; kanban: { max_in_progress_per_profile: number } };
}

/** What the platform allows. Phase 0–1 values; a platform file overrides any of them. */
export interface Platform {
  /** Slot caps by slotBudgetKey. A missing cap counts as 0. */
  slotCaps: Record<string, number>;
  models: string[];
  maxContextTokens: number;
  /** Measured Pi prompt baseline and a reserve, in tokens. Rule 3's second half applies once the baseline is measured. */
  piBaselineTokens?: number;
  reserveTokens?: number;
  /** Per-call ceilings delivered by the platform's environment (`pw broker serve`); not a platform-file field. Absent means the ADR values. */
  callCeilings?: Ceilings;
}
export const PHASE_0_1: Platform = { slotCaps: {}, models: ["qwen3.5:9b"], maxContextTokens: 32768 };

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, min = 0) => Number.isInteger(v) && (v as number) >= min;

function unknownFields(errors: string[], where: string, value: Record<string, unknown>, known: string[]) {
  for (const k of Object.keys(value)) if (!known.includes(k)) errors.push(`unknown field ${where}${k}`);
}

/** The full spec from a team definition: the definition with the version and Hermes profile filled in. */
export function buildSpec(definition: Record<string, unknown>): Record<string, unknown> {
  const perTrain = obj(definition.perTrain) ? definition.perTrain : {};
  const trains = definition.trains;
  return {
    specVersion: SPEC_VERSION,
    ...definition,
    hermesProfile: {
      name: definition.team,
      kanban: { max_in_progress_per_profile: int(trains, 1) && int(perTrain.orchestrators, 1) ? (trains as number) * (perTrain.orchestrators as number) : null },
    },
  };
}

/** Problems with a spec (untrusted input) against the platform; empty means it is valid. */
export function validateSpec(spec: unknown, platform: Platform = PHASE_0_1): string[] {
  const errors: string[] = [];
  if (!obj(spec)) return ["spec must be an object"];
  unknownFields(errors, "", spec, ["specVersion", "team", "trains", "perTrain", "endpoint", "defaultClass", "classes", "events", "hermesProfile"]);
  if (spec.specVersion !== SPEC_VERSION) errors.push(`specVersion must be ${SPEC_VERSION}`);
  // Rule 7: names are DNS-safe and unique (class names are unique as object keys).
  if (typeof spec.team !== "string" || !DNS_NAME.test(spec.team)) errors.push("team must be a DNS-safe name");
  if (!int(spec.trains, 1)) errors.push("trains must be a positive integer");

  const classes = obj(spec.classes) ? spec.classes : {};
  if (!obj(spec.classes) || Object.keys(classes).length === 0) errors.push("classes must name at least one class");
  if (typeof spec.defaultClass !== "string" || !Object.hasOwn(classes, spec.defaultClass)) errors.push("defaultClass must name one of the classes");

  const perTrain = obj(spec.perTrain) ? spec.perTrain : null;
  if (!perTrain) errors.push("perTrain must be an object");
  else {
    unknownFields(errors, "perTrain.", perTrain, ["orchestrators", "workers"]);
    if (perTrain.orchestrators !== 1) errors.push("perTrain.orchestrators must be 1 (a train is one Hermes orchestrator cycle)");
    if (!obj(perTrain.workers)) errors.push("perTrain.workers must map classes to seat counts");
    else for (const [c, n] of Object.entries(perTrain.workers)) {
      if (!Object.hasOwn(classes, c)) errors.push(`perTrain.workers.${c} is not a class`);
      if (!int(n)) errors.push(`perTrain.workers.${c} must be a non-negative integer`);
    }
  }

  const endpoint = obj(spec.endpoint) ? spec.endpoint : null;
  if (!endpoint) errors.push("endpoint must be an object");
  else {
    unknownFields(errors, "endpoint.", endpoint, ["url", "slotBudgetKey"]);
    if (typeof endpoint.url !== "string" || endpoint.url === "") errors.push("endpoint.url must be a string (for example ${PLANTWORKS_LLM_URL})");
    if (typeof endpoint.slotBudgetKey !== "string" || !DNS_NAME.test(endpoint.slotBudgetKey)) errors.push("endpoint.slotBudgetKey must be a DNS-safe name");
  }

  const events = obj(spec.events) ? spec.events : null;
  if (!events) errors.push("events must be an object");
  else {
    unknownFields(errors, "events.", events, ["callbackDefault", "approvalConsumer"]);
    for (const k of ["callbackDefault", "approvalConsumer"]) if (typeof events[k] !== "string" || events[k] === "") errors.push(`events.${k} must be a non-empty string`);
  }

  let slotTotal = 0;
  for (const [name, c] of Object.entries(classes)) {
    const at = `classes.${name}`;
    if (!DNS_NAME.test(name)) errors.push(`${at}: class names must be DNS-safe`);
    if (!obj(c)) { errors.push(`${at} must be an object`); continue; }
    unknownFields(errors, `${at}.`, c, ["slots", "model", "context", "perCall", "toolProfile", "approval", "approvalTtlSeconds", "timeoutSeconds", "maxAttempts"]);
    const ctx = obj(c.context) ? c.context : {};
    const call = obj(c.perCall) ? c.perCall : {};
    unknownFields(errors, `${at}.context.`, ctx, ["maxContextTokens", "thinkingTokens"]);
    unknownFields(errors, `${at}.perCall.`, call, ["maxOutputTokens", "deadlineSeconds"]);
    if (!int(c.slots)) errors.push(`${at}.slots must be a non-negative integer`);
    else slotTotal += c.slots as number;
    // Rule 2: every model is served.
    if (typeof c.model !== "string" || !platform.models.includes(c.model)) errors.push(`${at}.model must be a served model (${platform.models.join(", ")})`);
    if (!int(ctx.maxContextTokens, 1)) errors.push(`${at}.context.maxContextTokens must be a positive integer`);
    if (ctx.thinkingTokens !== 0) errors.push(`${at}.context.thinkingTokens must be 0 (thinking is off in every class)`);
    // Rule 8: perCall is set and within the platform ceilings. Rule 3: context within the platform maximum.
    if (!int(call.maxOutputTokens, 1) || !int(call.deadlineSeconds, 1)) errors.push(`${at}.perCall must set maxOutputTokens and deadlineSeconds`);
    else if (int(ctx.maxContextTokens, 1)) {
      const problems = ceilingProblems({ model: String(c.model), maxContextTokens: ctx.maxContextTokens as number, maxOutputTokens: call.maxOutputTokens as number, deadlineSeconds: call.deadlineSeconds as number }, platform.callCeilings);
      for (const p of problems) errors.push(`${at} exceeds a platform ceiling: ${p}`);
      if ((ctx.maxContextTokens as number) > platform.maxContextTokens) errors.push(`${at}.context.maxContextTokens exceeds the platform maximum ${platform.maxContextTokens}`);
      if (platform.piBaselineTokens !== undefined) {
        const need = platform.piBaselineTokens + (call.maxOutputTokens as number) + (platform.reserveTokens ?? 0);
        if (need >= (ctx.maxContextTokens as number)) errors.push(`${at}: Pi baseline + output + reserve (${need}) must be below the context (${ctx.maxContextTokens})`);
      }
    }
    if (c.toolProfile !== undefined && !TOOL_PROFILES.includes(c.toolProfile as never)) errors.push(`${at}.toolProfile must be one of ${TOOL_PROFILES.join(", ")}`);
    if (!APPROVALS.includes(c.approval as never)) errors.push(`${at}.approval must be one of ${APPROVALS.join(", ")}`);
    // Rule 6: an always-approval class has a TTL and a consumer.
    if (c.approval === "always" && !int(c.approvalTtlSeconds, 1)) errors.push(`${at}: approval "always" needs approvalTtlSeconds`);
    if (c.approvalTtlSeconds !== undefined && !int(c.approvalTtlSeconds, 1)) errors.push(`${at}.approvalTtlSeconds must be a positive integer`);
    if (!int(c.timeoutSeconds, 1)) errors.push(`${at}.timeoutSeconds must be a positive integer`);
    if (!int(c.maxAttempts, 1)) errors.push(`${at}.maxAttempts must be a positive integer`);
    // Rule 4: there are at least as many worker seats as slots.
    const seats = perTrain && obj(perTrain.workers) && int(spec.trains, 1) ? (spec.trains as number) * (Number(perTrain.workers[name]) || 0) : 0;
    if (int(c.slots) && seats < (c.slots as number)) errors.push(`${at}: ${c.slots} slots but only ${seats} worker seats (trains × perTrain.workers.${name})`);
  }

  // Rule 1: the sum of slots fits the platform cap for the slot budget key. A missing cap is 0.
  if (endpoint && typeof endpoint.slotBudgetKey === "string") {
    const cap = platform.slotCaps[endpoint.slotBudgetKey] ?? 0;
    if (slotTotal > cap) errors.push(`classes use ${slotTotal} slots, over the platform cap of ${cap} for slot budget "${endpoint.slotBudgetKey}"`);
  }

  // The Hermes profile is derived, so it must match the team.
  // Compared field by field: JSON objects are unordered, so key order must not matter.
  const expected = buildSpec(spec).hermesProfile as TeamSpec["hermesProfile"];
  const got = spec.hermesProfile;
  const matches = obj(got) && Object.keys(got).length === 2 && got.name === expected.name
    && obj(got.kanban) && Object.keys(got.kanban).length === 1
    && got.kanban.max_in_progress_per_profile === expected.kanban.max_in_progress_per_profile;
  if (!matches) errors.push(`hermesProfile must be ${JSON.stringify(expected)} (name = team, max_in_progress_per_profile = trains × orchestrators)`);
  return errors;
}

/**
 * The Hermes profile file, in the format of an unmodified Hermes `profiles/<name>/config.yaml`.
 * Hermes 0.22.5 reads `kanban.max_in_progress_per_profile` from the config of the home that runs
 * the dispatcher and applies it to every profile there. So this file states the team's intended
 * cap; it does not by itself enforce a cap on a shared Hermes home. Where the value is applied,
 * and how several teams' values combine, is platform integration (#991). The broker's own slot
 * cap (PW-19) is separate and does not depend on this setting.
 */
export function hermesProfileConfig(spec: TeamSpec): string {
  return `kanban:\n  max_in_progress_per_profile: ${spec.hermesProfile.kanban.max_in_progress_per_profile}\n` +
    // The Hermes integration kit (PW-24, ../hermes/README.md). The references stay literal: Hermes
    // resolves them from the profile's secret scope and refuses to connect while one is unset.
    "mcp_servers:\n" +
    "  plantworks:\n" +
    '    url: "${PLANTWORKS_MCP_URL}"\n' +
    "    headers:\n" +
    '      Authorization: "Bearer ${PLANTWORKS_MCP_TOKEN}"\n' +
    "    tools:\n" +
    "      include: [job_submit, job_inspect, job_cancel]\n";
}

export function validatePlatform(input: unknown): string[] {
  if (!obj(input)) return ["platform must be an object"];
  const errors: string[] = [];
  unknownFields(errors, "platform.", input, ["slotCaps", "models", "maxContextTokens", "piBaselineTokens", "reserveTokens"]);
  if (!obj(input.slotCaps) || !Object.values(input.slotCaps).every((n) => int(n))) errors.push("platform.slotCaps must map slot budget keys to non-negative integers");
  if (!Array.isArray(input.models) || !input.models.every((m) => typeof m === "string")) errors.push("platform.models must be a list of model names");
  if (!int(input.maxContextTokens, 1)) errors.push("platform.maxContextTokens must be a positive integer");
  for (const k of ["piBaselineTokens", "reserveTokens"]) if (input[k] !== undefined && !int(input[k])) errors.push(`platform.${k} must be a non-negative integer`);
  return errors;
}
