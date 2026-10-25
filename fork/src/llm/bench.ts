// SPDX-License-Identifier: Apache-2.0
// `plantworks pw llm bench` (PW-30): replay Pi-shaped traffic at 1/2/4/8/... concurrent sessions and
// report throughput, latency and the knee, the input HarnessHG needs to size a slotBudgetKey.
// It puts real load on whatever it points at, so anything off loopback needs --i-have-a-window.
import { isLoopbackBind } from "../../../packages/daemon/dist/middleware/auth-bearer-token.js";
import type { Endpoint } from "./endpoint.ts";

/**
 * One model call: append `add` prompt tokens (a tool result when the previous call asked for a tool,
 * else a user message), ask for `maxTokens`, then record the reply: a tool call when `tool` is set,
 * else text. A compaction call then keeps only `keep` tokens of history.
 */
export type Step = { add: number; maxTokens: number; tool?: boolean; keep?: number };
export type Profile = { name: string; steps: (window: number) => Step[] };

/** The system prompt every Pi call starts with, shared across sessions (prefix-cacheable). */
export const SYSTEM_TOKENS = 3000;

/** Pi's default tools, sent with every call as Pi does: their definitions are part of each prefill. */
const param = (name: string) => ({ type: "object", properties: { [name]: { type: "string" } }, required: [name] });
export const TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file", parameters: param("path") } },
  { type: "function", function: { name: "edit", description: "Replace text in a file", parameters: param("path") } },
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: param("command") } },
];

/**
 * SYNTHETIC profiles, derived from the PW-30 card text ("prefill-heavy, tool-call turns, compaction"),
 * not from measured Pi traffic. Replace the numbers here when real ones exist (architecture-21-pis.md §4.6).
 * Compaction follows the worker's Pi settings: a quarter of the window reserved, three eighths kept.
 */
export const PROFILES: Profile[] = [
  // Ask, read a large file (its contents come back as a tool result), answer.
  { name: "prefill-heavy", steps: () => [{ add: 200, maxTokens: 100, tool: true }, { add: 9000, maxTokens: 300 }] },
  // Seven short tool calls, each answered by a tool result, then the answer.
  { name: "tool-calls", steps: () => [{ add: 300, maxTokens: 150, tool: true }, ...Array.from({ length: 6 }, () => ({ add: 700, maxTokens: 150, tool: true })), { add: 700, maxTokens: 150 }] },
  {
    name: "compaction",
    steps: (window) => {
      const steps: Step[] = [{ add: 300, maxTokens: 200, tool: true }];
      let context = SYSTEM_TOKENS + 500;
      while (context + 2200 <= window * 0.75) { steps.push({ add: 2000, maxTokens: 200, tool: true }); context += 2200; }
      // The last tool result arrives and the context is summarised, then work goes on from the summary.
      steps.push({ add: 2000, maxTokens: 1000, keep: Math.floor(window * 3 / 8) });
      steps.push({ add: 300, maxTokens: 200, tool: true }, { add: 2000, maxTokens: 200 });
      return steps;
    },
  },
];

/** Refuses a non-loopback endpoint unless the operator says a quiet window is open: bench load lands on everyone sharing it. */
export function checkBenchTarget(url: string, iHaveAWindow: boolean): string | undefined {
  const host = new URL(url).hostname;
  if (isLoopbackBind(host) || iHaveAWindow) return undefined;
  return `${host} is not loopback: bench puts real load on a shared endpoint; run it only in an agreed quiet window, with --i-have-a-window`;
}

const WORDS = ["the", "build", "file", "test", "read", "edit", "run", "code"];
/** About `tokens` tokens of text; `seed` keeps each session's history its own. */
const filler = (tokens: number, seed: string) => `${seed}:` + Array.from({ length: tokens }, (_, i) => WORDS[i % WORDS.length]).join(" ");

type Call = { ms: number; promptTokens: number; completionTokens: number };
export type LevelResult = {
  concurrency: number; calls: number; errors: number; firstError?: string; wallSeconds: number;
  outputTokensPerSecond: number; totalTokensPerSecond: number; p50Ms: number; p95Ms: number;
  /** completed sessions per hour over this run's wall time */
  jobsPerHourMeasured: number;
  /** concurrency × 3600 / mean session seconds: the steady state this level would hold */
  jobsPerHourEstimated: number;
};

type Message = { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] };

async function session(endpoint: Endpoint, model: string, profile: Profile, window: number, seed: string, timeoutMs: number, calls: Call[]) {
  const messages: Message[] = [{ role: "system", content: filler(SYSTEM_TOKENS, "system") }];
  let pendingTool: string | undefined;
  for (const [i, step] of profile.steps(window).entries()) {
    const content = filler(step.add, `${seed}-${i}`);
    messages.push(pendingTool ? { role: "tool", tool_call_id: pendingTool, content } : { role: "user", content });
    pendingTool = undefined;
    const started = performance.now();
    const res = await fetch(`${endpoint.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, tools: TOOLS, max_tokens: step.maxTokens, stream: false }),
      // A redirect could carry the load somewhere checkBenchTarget never saw: refuse it.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`POST /chat/completions returned ${res.status}`);
    const body = (await res.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    if (typeof body.usage?.completion_tokens !== "number") throw new Error("the endpoint reported no usage; tokens/s would be a guess");
    calls.push({ ms: performance.now() - started, promptTokens: body.usage.prompt_tokens ?? 0, completionTokens: body.usage.completion_tokens });
    // The history is the profile's, not the model's reply, so every run sends the same traffic.
    const reply = filler(step.maxTokens, `${seed}-${i}-reply`);
    if (step.tool) {
      pendingTool = `call-${seed}-${i}`;
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: pendingTool, type: "function", function: { name: "read", arguments: JSON.stringify({ path: reply }) } }] });
    } else messages.push({ role: "assistant", content: reply });
    if (step.keep !== undefined) messages.splice(1, messages.length - 1, { role: "user", content: filler(step.keep, `${seed}-summary`) });
  }
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0);

/** Runs `concurrency` workers at once; each runs `sessions` sessions, cycling the profiles from its own offset. */
export async function benchLevel(endpoint: Endpoint, model: string, concurrency: number, opts: { sessions: number; window: number; callTimeoutMs: number }): Promise<LevelResult> {
  const calls: Call[] = [];
  const sessionSeconds: number[] = [];
  const errors: string[] = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
    for (let s = 0; s < opts.sessions; s++) {
      const t = performance.now();
      try {
        await session(endpoint, model, PROFILES[(w + s) % PROFILES.length], opts.window, `c${concurrency}-w${w}-s${s}`, opts.callTimeoutMs, calls);
        sessionSeconds.push((performance.now() - t) / 1000);
      } catch (e) {
        const cause = (e as Error).cause as Error | undefined;
        errors.push(cause?.message ? `${(e as Error).message}: ${cause.message}` : (e as Error).message);
      }
    }
  }));
  const wallSeconds = (performance.now() - started) / 1000;
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  const output = calls.reduce((n, c) => n + c.completionTokens, 0);
  const prompt = calls.reduce((n, c) => n + c.promptTokens, 0);
  const meanSession = sessionSeconds.reduce((a, b) => a + b, 0) / (sessionSeconds.length || 1);
  return {
    concurrency, calls: calls.length, errors: errors.length, ...(errors.length ? { firstError: errors[0] } : {}), wallSeconds,
    outputTokensPerSecond: output / wallSeconds, totalTokensPerSecond: (output + prompt) / wallSeconds,
    p50Ms: percentile(ms, 0.5), p95Ms: percentile(ms, 0.95),
    jobsPerHourMeasured: (sessionSeconds.length / wallSeconds) * 3600,
    jobsPerHourEstimated: sessionSeconds.length ? (concurrency * 3600) / meanSession : 0,
  };
}

/**
 * The knee: the last level whose next level adds less than `minGain` (fractional) output tokens/s,
 * or has errors. Null when every step up still paid off: run higher levels.
 */
export function findKnee(levels: LevelResult[], minGain = 0.1): number | null {
  for (let i = 0; i + 1 < levels.length; i++) {
    const next = levels[i + 1];
    if (next.errors || next.outputTokensPerSecond < levels[i].outputTokensPerSecond * (1 + minGain)) return levels[i].concurrency;
  }
  return null;
}

export async function runBench(endpoint: Endpoint, model: string, opts: { levels: number[]; sessions: number; window: number; callTimeoutMs: number; minGain: number }) {
  const levels: LevelResult[] = [];
  for (const c of opts.levels) levels.push(await benchLevel(endpoint, model, c, opts));
  return { url: endpoint.url, model, profiles: PROFILES.map((p) => p.name), synthetic: true, levels, knee: findKnee(levels, opts.minGain) };
}
