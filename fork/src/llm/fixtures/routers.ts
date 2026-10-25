// SPDX-License-Identifier: Apache-2.0
// PW-28: stand-ins for the two candidate routers in front of vLLM, on 127.0.0.1, for contract tests.
// Each models only behaviour the router's own source shows, pinned below; fork/docs/router-compat.md
// lists them with what is unverified. Nothing here talks to a real router or model.
//   V = vllm-project/production-stack@cd5c5fc2e87ede3ea6f1c97a0120560bbf697e36 src/vllm_router/
//   L = BerriAI/litellm@de5dc5b238b6e972869d7dedc6ba3c4fb8d931fe
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

async function listen(handler: (req: IncomingMessage, res: ServerResponse, raw: Buffer) => unknown) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    // An upstream that fails mid-request (or is closed under a hung call) drops the client connection.
    await Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = () => new Promise<void>((r) => { if (!server.listening) return r(); server.closeAllConnections(); server.close(() => r()); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

/** Relays an upstream response: status, headers (less hop-by-hop), and the body as it streams. */
async function relay(res: ServerResponse, upstream: Response, extra: Record<string, string>) {
  const headers: Record<string, string> = { ...extra };
  upstream.headers.forEach((v, k) => { if (!["content-length", "content-encoding", "transfer-encoding", "connection", "server"].includes(k)) headers[k] = v; });
  res.writeHead(upstream.status, headers);
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

/**
 * vLLM production-stack router, roundrobin over one backend per model.
 * - GET /models: the backends' models, deduplicated by id, owned_by "vllm" (V routers/main_router.py:134-181).
 * - POST: routed by the body's `model`. Unknown: 404 with a plain-string `error`
 *   (V services/request_service/request.py:503-588). The body bytes are forwarded unchanged, so
 *   `priority` and tool calls reach vLLM (request.py:330-335). The backend's status, headers and body come
 *   back as they are, with no retry on any HTTP status (request.py:336-342, 641-703, 715-720), and
 *   streamed bytes are relayed unparsed (request.py:344-353). No upstream timeout (request.py:334).
 *   X-Request-Id is kept from the request or minted (request.py:211-227, 682-688).
 */
export async function vllmRouter(backends: Record<string, string>) {
  return listen(async (req, res, raw) => {
    const path = (req.url ?? "").replace(/^\/v1/, "");
    if (req.method === "GET" && path === "/models") {
      const seen = new Map<string, unknown>();
      for (const url of new Set(Object.values(backends))) {
        const list = await (await fetch(`${url}/models`)).json() as { data: { id: string }[] };
        for (const m of list.data) if (!seen.has(m.id)) seen.set(m.id, { id: m.id, object: "model", created: 0, owned_by: "vllm", root: m.id, parent: null });
      }
      return json(res, 200, { object: "list", data: [...seen.values()] });
    }
    const model = (JSON.parse(raw.toString() || "{}") as { model?: string }).model;
    if (!model) return json(res, 400, { error: "Invalid request: missing 'model' in request body." });
    const backend = backends[model];
    if (!backend) return json(res, 404, { error: `Model '${model}' not found. Available models can be listed at /v1/models.` });
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const upstream = await fetch(`${backend}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: raw });
    await relay(res, upstream, { "x-request-id": requestId });
  });
}

export interface LiteLLMOptions {
  /** Proxy master key: every route then needs `Authorization: Bearer <key>` (L litellm/proxy/auth/user_api_key_auth.py). */
  masterKey?: string;
  /** Router num_retries, default 2 (L litellm/router.py:1512-1517). */
  numRetries?: number;
  /** Router timeout, which also bounds the scheduler queue; the default is 6000 s (L litellm/constants.py:654-663). */
  requestTimeoutMs?: number;
}

/**
 * LiteLLM proxy with one `hosted_vllm` deployment per model name.
 * - GET /models: the configured model names, behind the master key (L proxy/utils.py:9697-9719).
 * - Unknown model: 400 "Invalid model name passed in model=…" (L proxy/route_llm_request.py:218-226); the
 *   error envelope shape is medium confidence (L proxy/_types.py:3850-3860).
 * - `priority` is taken by the router and stripped from the request (L router.py:5278-5290), so the backend
 *   never sees it; a non-integer is a 400 on `param: "priority"` (L router_utils/request_priority.py). A
 *   prioritised response carries x-litellm-request-prioritization-used (L router.py:5306-5310).
 * - A backend 429/503 is retried up to numRetries (L router.py:9139-9200). After allowed_fails (3) the
 *   deployment cools down for 5 s (L constants.py:151-153); with none healthy the answer is 429 "No deployments
 *   available for selected model" with retry-after = the cooldown (L types/router.py:909, 1145-1146;
 *   proxy/common_request_processing.py:4132-4134). The final status for this path is medium confidence.
 * - The scheduler queues a prioritised request only while no deployment is healthy, until the router timeout,
 *   then 408 "Request timed out while polling queue" (L scheduler.py:58-108, exceptions.py:379).
 * - Responses carry x-litellm-call-id and x-litellm-model-id (L proxy/common_request_processing.py:1531-1543).
 */
export async function liteLLMProxy(deployments: Record<string, string>, opts: LiteLLMOptions = {}) {
  const numRetries = opts.numRetries ?? 2;
  const timeoutMs = opts.requestTimeoutMs ?? 6_000_000;
  const COOLDOWN_MS = 5000, ALLOWED_FAILS = 3;
  const fails = new Map<string, number>();
  const coolUntil = new Map<string, number>();
  const healthy = (m: string) => (coolUntil.get(m) ?? 0) <= Date.now();
  const fail = (m: string) => {
    const n = (fails.get(m) ?? 0) + 1;
    fails.set(m, n);
    if (n >= ALLOWED_FAILS) { coolUntil.set(m, Date.now() + COOLDOWN_MS); fails.set(m, 0); }
  };
  const proxy = await listen(async (req, res, raw) => {
    if (opts.masterKey && req.headers.authorization !== `Bearer ${opts.masterKey}`) {
      return json(res, 401, { error: { message: "Authentication Error, No api key passed in.", type: "auth_error", param: "None", code: "401" } });
    }
    const path = (req.url ?? "").replace(/^\/v1/, "");
    if (req.method === "GET" && path === "/models") {
      return json(res, 200, { object: "list", data: Object.keys(deployments).map((id) => ({ id, object: "model", created: 1677610602, owned_by: "openai" })) });
    }
    const body = JSON.parse(raw.toString() || "{}") as Record<string, unknown>;
    const model = body.model as string;
    const backend = deployments[model];
    if (!backend) return json(res, 400, { error: { message: `/chat/completions: Invalid model name passed in model=${model}. Call \`/v1/models\` to view available models for your key.`, type: "None", param: "None", code: "400" } });
    const prioritised = "priority" in body;
    if (prioritised && !Number.isInteger(body.priority)) return json(res, 400, { error: { message: "priority must be an integer", type: "invalid_request_error", param: "priority", code: "400" } });
    delete body.priority;
    const headers = { "x-litellm-call-id": randomUUID(), "x-litellm-model-id": `${model}-deployment`, ...(prioritised ? { "x-litellm-request-prioritization-used": "true" } : {}) };
    if (prioritised) {
      const deadline = Date.now() + timeoutMs;
      while (!healthy(model)) {
        if (Date.now() > deadline) return json(res, 408, { error: { message: "litellm.Timeout: Request timed out while polling queue", type: "None", param: "None", code: "408" } }, headers);
        await new Promise((r) => setTimeout(r, 30)); // polling interval (L constants.py:587)
      }
    }
    for (let attempt = 0; attempt <= numRetries; attempt++) {
      if (!healthy(model)) break;
      const upstream = await fetch(`${backend}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (upstream.status !== 429 && upstream.status !== 503) return relay(res, upstream, headers);
      await upstream.body?.cancel();
      fail(model);
    }
    const retryAfter = String(Math.ceil(Math.max(0, (coolUntil.get(model) ?? Date.now()) - Date.now()) / 1000) || 1);
    return json(res, 429, { error: { message: `No deployments available for selected model, Try again in ${retryAfter} seconds. Passed model=${model}.`, type: "None", param: "None", code: "429" } }, { ...headers, "retry-after": retryAfter });
  });
  return { ...proxy, coolDown: (model: string) => coolUntil.set(model, Date.now() + COOLDOWN_MS) };
}

/**
 * A vLLM backend in front of the stub model: `plan(n)` answers the n-th chat completion with a status
 * (for example 503, vLLM's answer when it can't take the request), "hang", or "forward". Records the
 * request bodies that reach it.
 */
export async function vllmBackend(model: { url: string }, plan: (n: number) => number | "hang" | "forward" = () => "forward") {
  const bodies: Record<string, unknown>[] = [];
  let n = 0;
  const server = await listen(async (req, res, raw) => {
    const path = (req.url ?? "").replace(/^\/v1/, "");
    if (req.method === "POST") {
      bodies.push(JSON.parse(raw.toString()));
      const step = plan(++n);
      if (step === "hang") return;
      if (step !== "forward") return json(res, step, { error: { message: `backend ${step}`, type: "stub" } });
    }
    await relay(res, await fetch(`${model.url}${path}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? raw : undefined }), {});
  });
  return { ...server, bodies };
}
