// SPDX-License-Identifier: Apache-2.0
// The per-seat call governor: a localhost proxy between one Pi seat and PLANTWORKS_LLM_URL.
// Pi is pointed at the governor, never at the endpoint, so the budget holds without editing Pi:
// - caps max_tokens to the class, and strips Ollama's num_ctx/options, so a seat can't resize the shared context;
// - aborts each call at the class deadline;
// - on 503 (the endpoint's queue is full), backs off and retries without counting an attempt;
// - logs each call's hold time on the endpoint and its own wait;
// - after N consecutive deadline aborts, reports `call-deadline` so the runner can fail the job.
// The endpoint's API key lives only here, so seat files never hold it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ceilingProblems, type WorkerClass } from "./classes.ts";
import type { Endpoint } from "./endpoint.ts";

export type CallRecord = { method: string; path: string; status: number; holdMs: number; waitMs: number; retries503: number; deadline: boolean };

export type GovernorOptions = {
  endpoint: Endpoint;
  workerClass: WorkerClass;
  /** Called once, after `maxConsecutiveDeadlines` aborts in a row. */
  onFail?: (reason: "call-deadline") => void;
  log?: (record: CallRecord) => void;
  maxConsecutiveDeadlines?: number;
  backoffMs?: { first: number; max: number };
};

export type Governor = { url: string; close: () => Promise<void> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host", "authorization"]);

/** Rewrites a chat/completions request body to the class budget. Non-JSON bodies pass through. */
export function governBody(body: Buffer, c: WorkerClass): Buffer {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return body;
  delete json.options;
  delete json.num_ctx;
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const asked = json[key];
    if (typeof asked === "number" && asked < c.maxOutputTokens) continue;
    if (key === "max_tokens" || asked !== undefined) json[key] = c.maxOutputTokens;
  }
  return Buffer.from(JSON.stringify(json));
}

export async function startGovernor(opts: GovernorOptions): Promise<Governor> {
  const c = opts.workerClass;
  const problems = ceilingProblems(c);
  if (problems.length) throw new Error(`worker class exceeds the platform ceilings: ${problems.join("; ")}`);
  const log = opts.log ?? ((r) => process.stderr.write(`${JSON.stringify({ governor: r })}\n`));
  const limit = opts.maxConsecutiveDeadlines ?? 3;
  const backoff = opts.backoffMs ?? { first: 1000, max: 30_000 };
  let consecutiveDeadlines = 0;
  let failed = false;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Buffer | undefined = chunks.length ? Buffer.concat(chunks) : undefined;
    const path = req.url ?? "/";
    if (body && req.method === "POST" && /\/(chat\/)?completions$/.test(path.split("?")[0])) body = governBody(body, c);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && typeof v === "string") headers[k] = v;
    if (opts.endpoint.apiKey) headers.authorization = `Bearer ${opts.endpoint.apiKey}`;

    const record: CallRecord = { method: req.method ?? "GET", path, status: 0, holdMs: 0, waitMs: 0, retries503: 0, deadline: false };
    const abort = new AbortController();
    res.on("close", () => abort.abort(new Error("client went away")));
    try {
      for (let delay = backoff.first; ; delay = Math.min(delay * 2, backoff.max)) {
        const started = Date.now();
        const timer = setTimeout(() => { record.deadline = true; abort.abort(new Error("deadline")); }, c.deadlineSeconds * 1000);
        let upstream: Response;
        try {
          upstream = await fetch(`${opts.endpoint.url}${path}`, { method: req.method, headers, body, signal: abort.signal });
          if (upstream.status !== 503) {
            const out: Record<string, string> = {};
            upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k)) out[k] = v; });
            res.writeHead(upstream.status, out);
            if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
            res.end();
            record.status = upstream.status;
            return;
          }
          await upstream.body?.cancel();
        } finally {
          clearTimeout(timer);
          record.holdMs += Date.now() - started;
        }
        // 503: the endpoint's queue is full. Wait our turn; this is not an attempt.
        record.retries503++;
        record.waitMs += delay;
        await sleep(delay);
        if (abort.signal.aborted) return;
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(record.deadline ? 504 : 502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: record.deadline ? `call exceeded the ${c.deadlineSeconds}s deadline` : `endpoint error: ${(e as Error).message}`, type: "governor" } }));
      } else {
        res.destroy();
      }
      record.status = record.deadline ? 504 : 502;
    } finally {
      log(record);
      if (record.deadline) {
        if (++consecutiveDeadlines >= limit && !failed) {
          failed = true;
          opts.onFail?.("call-deadline");
        }
      } else {
        // Any call that was not cut at the deadline, error or not, ends the run.
        consecutiveDeadlines = 0;
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
