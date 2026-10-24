// SPDX-License-Identifier: Apache-2.0
// PLANTWORKS_LLM_URL: the one OpenAI-compatible endpoint Plantworks consumes. Plantworks manages
// no GPUs; whoever runs the endpoint owns it. The preflight only lists models, so it never puts
// load on a shared inference lane.

export type Endpoint = { url: string; apiKey?: string };

export function readEndpoint(env: NodeJS.ProcessEnv = process.env): Endpoint {
  const raw = env.PLANTWORKS_LLM_URL?.trim();
  if (!raw) throw new Error("PLANTWORKS_LLM_URL is not set (an OpenAI-compatible base URL, for example http://127.0.0.1:11434/v1)");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`PLANTWORKS_LLM_URL is not a URL: ${redact(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("PLANTWORKS_LLM_URL must be http(s)");
  if (parsed.username || parsed.password) throw new Error("PLANTWORKS_LLM_URL must not carry credentials; use PLANTWORKS_LLM_API_KEY");
  const apiKey = env.PLANTWORKS_LLM_API_KEY?.trim() || undefined;
  return { url: raw.replace(/\/+$/, ""), apiKey };
}

export type PreflightResult = { ok: boolean; url: string; models: string[]; missing: string[]; error?: string };

/** Is the endpoint reachable, and does it serve every model we need? Uses GET /models only. */
export async function preflight(endpoint: Endpoint, need: string[], timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<PreflightResult> {
  const result = { ok: false, url: endpoint.url, models: [] as string[], missing: [...new Set(need)] };
  try {
    const res = await fetchImpl(`${endpoint.url}/models`, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ...result, error: `GET /models returned ${res.status}` };
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    if (!Array.isArray(body?.data)) return { ...result, error: "GET /models did not return an OpenAI-style { data: [...] } list" };
    const models = body.data.map((m) => String(m.id));
    const missing = result.missing.filter((m) => !models.includes(m));
    return { ...result, ok: missing.length === 0, models, missing, ...(missing.length ? { error: `not served: ${missing.join(", ")}` } : {}) };
  } catch (e) {
    return { ...result, error: e instanceof Error && e.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : String((e as Error).message ?? e) };
  }
}

function redact(s: string): string {
  return s.replace(/\/\/[^/@]*@/, "//***@");
}
