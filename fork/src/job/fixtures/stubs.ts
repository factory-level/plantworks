// SPDX-License-Identifier: Apache-2.0
// Local stand-ins for tests: an OpenAI-compatible endpoint and a job-state event consumer.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export type StubModelMode = "ok" | "error" | "hang";

/**
 * Minimal OpenAI-compatible /v1: GET /models and POST /chat/completions (JSON, or SSE when
 * `stream` is set, as Pi uses). Records each request body.
 */
export async function stubModel(reply = "stub reply", mode: { value: StubModelMode } = { value: "ok" }) {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const path = req.url ?? "";
      if (req.method === "GET" && path.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "qwen3.5:9b", object: "model" }] }));
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path, body });
      if (mode.value === "hang") return;
      if (mode.value === "error") return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad request from stub" } }));
      const id = `chatcmpl-${requests.length}`;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: "assistant", content: reply }, null));
        res.write(chunk({}, "stop"));
        if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id, object: "chat.completion", created: 0, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  const { base, close } = await listen(server);
  return { url: `${base}/v1`, requests, mode, close };
}

/** Collects plantworks.job.state events; answers each with `status` (default 204). */
export async function stubConsumer(status = 204) {
  const events: any[] = [];
  const authorization: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => { events.push(JSON.parse(raw)); authorization.push(req.headers.authorization); res.writeHead(status).end(); });
  });
  const { base, close } = await listen(server);
  return { url: `${base}/events`, events, authorization, states: () => events.map((e) => e.data.state), close };
}

/**
 * An OpenAI-compatible stub with a serving model, so load has a shape: `slots` calls are served at
 * once and the rest wait in arrival order; a call takes prompt/prefill + output/decode seconds.
 * Prompt tokens are estimated at 4 characters each; the output is `max_tokens` (default 64).
 * Throughput rises with concurrency up to `slots` and is flat after, so the knee is at `slots`.
 */
export async function stubServingModel(opts: { slots: number; prefillTokensPerSecond: number; decodeTokensPerSecond: number }) {
  const stats = { calls: 0, peakInFlight: 0 };
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", async () => {
      if (req.method === "GET" && (req.url ?? "").endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "qwen3.5:9b", object: "model" }] }));
      const body = raw ? JSON.parse(raw) : {};
      const prompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
      const output = body.max_tokens ?? 64;
      if (inFlight >= opts.slots) await new Promise<void>((r) => waiting.push(r));
      inFlight++;
      stats.calls++;
      stats.peakInFlight = Math.max(stats.peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, (prompt / opts.prefillTokensPerSecond + output / opts.decodeTokensPerSecond) * 1000));
      inFlight--;
      waiting.shift()?.();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: `chatcmpl-${stats.calls}`, object: "chat.completion", created: 0, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output },
      }));
    });
  });
  const { base, close } = await listen(server);
  return { url: `${base}/v1`, stats, close };
}
