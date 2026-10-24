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

export function classByName(name: string): WorkerClass {
  if (!Object.hasOwn(CLASSES, name)) throw new Error(`unknown worker class "${name}" (known: ${Object.keys(CLASSES).join(", ")})`);
  return CLASSES[name as ClassName];
}

/** Problems with a class against the platform ceilings; empty means it is within them. */
export function ceilingProblems(c: WorkerClass): string[] {
  const outputCap = c.maxContextTokens <= 16384 ? CEILINGS.outputTokensUpTo16K : CEILINGS.outputTokensAbove16K;
  const problems: string[] = [];
  if (c.maxContextTokens > CEILINGS.maxContextTokens) problems.push(`context ${c.maxContextTokens} > ${CEILINGS.maxContextTokens}`);
  if (c.deadlineSeconds > CEILINGS.deadlineSeconds) problems.push(`deadline ${c.deadlineSeconds}s > ${CEILINGS.deadlineSeconds}s`);
  if (c.maxOutputTokens > outputCap) problems.push(`output ${c.maxOutputTokens} > ${outputCap} tokens`);
  return problems;
}
