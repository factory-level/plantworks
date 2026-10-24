// SPDX-License-Identifier: Apache-2.0
// Worker classes and the platform's per-call ceilings (ADR 0204, "Capacity and budgets").
// One Pi call must never hold the shared single lane long enough to push other callers past
// their own timeouts, so every call is bounded in time and output.

export type WorkerClass = {
  model: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  deadlineSeconds: number;
};

/** Phase 0–1 values. `quick` (16K) is the default; `long` (32K) is opt-in. Thinking is off in both. */
export const CLASSES = {
  quick: { model: "qwen3.5:9b", maxContextTokens: 16384, maxOutputTokens: 1536, deadlineSeconds: 60 },
  long: { model: "qwen3.5:9b", maxContextTokens: 32768, maxOutputTokens: 1024, deadlineSeconds: 60 },
} as const satisfies Record<string, WorkerClass>;

export type ClassName = keyof typeof CLASSES;
export const DEFAULT_CLASS: ClassName = "quick";

export const CEILINGS = { maxContextTokens: 32768, deadlineSeconds: 60, outputTokensUpTo16K: 1536, outputTokensAbove16K: 1024 };
export type Ceilings = typeof CEILINGS;

/**
 * The per-call ceilings the platform delivers (PW-19): PLANTWORKS_MAX_CALL_SECONDS (seconds) and
 * PLANTWORKS_MAX_CALL_OUTPUT (`<up to 16K>/<above 16K>` tokens, or one number for both). Unset
 * means the ADR values above. A value may tighten a ceiling, never loosen it: anything above the
 * ADR value, malformed or not positive throws, and the broker refuses to start.
 */
export function callCeilingsFromEnv(env: Record<string, string | undefined>): Ceilings {
  const n = (name: string, raw: string, max: number) => {
    if (!/^[1-9]\d{0,6}$/.test(raw)) throw new Error(`${name}: "${raw}" is not a positive integer`);
    if (Number(raw) > max) throw new Error(`${name}: ${raw} is above the platform ceiling of ${max}; it may only lower it`);
    return Number(raw);
  };
  const c = { ...CEILINGS };
  const seconds = env.PLANTWORKS_MAX_CALL_SECONDS?.trim();
  if (seconds) c.deadlineSeconds = n("PLANTWORKS_MAX_CALL_SECONDS", seconds, CEILINGS.deadlineSeconds);
  const output = env.PLANTWORKS_MAX_CALL_OUTPUT?.trim();
  if (output) {
    const parts = output.split("/").map((p) => p.trim());
    if (parts.length > 2) throw new Error(`PLANTWORKS_MAX_CALL_OUTPUT: "${output}" is not <n> or <up to 16K>/<above 16K>`);
    c.outputTokensUpTo16K = n("PLANTWORKS_MAX_CALL_OUTPUT", parts[0]!, CEILINGS.outputTokensUpTo16K);
    c.outputTokensAbove16K = n("PLANTWORKS_MAX_CALL_OUTPUT", parts[1] ?? parts[0]!, CEILINGS.outputTokensAbove16K);
  }
  return c;
}

export function classByName(name: string): WorkerClass {
  if (!Object.hasOwn(CLASSES, name)) throw new Error(`unknown worker class "${name}" (known: ${Object.keys(CLASSES).join(", ")})`);
  return CLASSES[name as ClassName];
}

/** Problems with a class against the platform ceilings; empty means it is within them. */
export function ceilingProblems(c: WorkerClass, ceilings: Ceilings = CEILINGS): string[] {
  const outputCap = c.maxContextTokens <= 16384 ? ceilings.outputTokensUpTo16K : ceilings.outputTokensAbove16K;
  const problems: string[] = [];
  if (c.maxContextTokens > ceilings.maxContextTokens) problems.push(`context ${c.maxContextTokens} > ${ceilings.maxContextTokens}`);
  if (c.deadlineSeconds > ceilings.deadlineSeconds) problems.push(`deadline ${c.deadlineSeconds}s > ${ceilings.deadlineSeconds}s`);
  if (c.maxOutputTokens > outputCap) problems.push(`output ${c.maxOutputTokens} > ${outputCap} tokens`);
  return problems;
}
