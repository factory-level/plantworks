// SPDX-License-Identifier: Apache-2.0
// The Hermes integration kit's MCP server (PW-24): job_submit, job_inspect, job_cancel and job_stats for
// one team, as a thin client of the broker. It runs beside upstream's `rig mcp serve`, never
// inside it, and shares nothing with it. Contract: ./README.md.
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { parseJobId, validateEnvelope } from "../contract/job.ts";

/** Result text per job_inspect call, about 4K tokens (README "Result retrieval limits"). */
export const RESULT_PAGE_CHARS = 16_000;
/** The most of a failed or cancelled job's message that is passed on. */
export const MESSAGE_CHARS = 2_000;
/** What job_inspect says about a held job: nothing in this kit or in Hermes can approve it. */
export const HELD_NOTE = "Waiting for an approval decision from outside this kit. Neither this kit nor Hermes can approve or deny it; without an external decision it expires or stays held.";
/** An MCP request body: a largest envelope (65,536-character prompt) is well under this. */
export const MAX_BODY_BYTES = 512 * 1024;
const BROKER_TIMEOUT_MS = 10_000;

export interface KitOptions {
  /** The team's broker, for example http://127.0.0.1:7534. Its token is sent nowhere else. */
  brokerUrl: string;
  /** The one team this server acts for. No tool takes a team. */
  team: string;
  brokerToken?: string;
  fetch?: typeof fetch;
}

type Reply = { status: number; body: Record<string, unknown> };
type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown>; isError?: true };

const ok = (data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const err = (code: string, message: string, extra: Record<string, unknown> = {}): ToolResult => {
  const data = { ok: false, code, message, ...extra };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
};

const COUNT_FIELDS = ["active", "held", "queued", "reserved", "claimed", "running"] as const;
type Counts = Record<(typeof COUNT_FIELDS)[number], number>;
/** The six lifecycle counts, copied one by one, or null when any is missing or not a whole number ≥ 0. */
function counts(v: unknown): Counts | null {
  if (!v || typeof v !== "object") return null;
  const out = {} as Counts;
  for (const f of COUNT_FIELDS) {
    const n = (v as Record<string, unknown>)[f];
    if (!Number.isInteger(n) || (n as number) < 0) return null;
    out[f] = n as number;
  }
  return out;
}

export function createKit(opts: KitOptions): McpServer {
  const { team } = opts;
  const base = opts.brokerUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function broker(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply | ToolResult> {
    let res: Response;
    try {
      res = await doFetch(`${base}/plantworks/v1${path}`, {
        method,
        // A redirect could carry the token elsewhere: never follow one.
        redirect: "error",
        signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(opts.brokerToken ? { authorization: `Bearer ${opts.brokerToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return err("broker_unavailable", "the broker could not be reached; repeat the call later");
    }
    if (res.status === 401) return err("broker_auth_failed", "the broker refused this server's credential; this is a setup fault, repeating will not help");
    if (res.status >= 500 || res.status < 200 || (res.status >= 300 && res.status < 400)) {
      return err("broker_unavailable", `the broker answered ${res.status}; repeat the call later`);
    }
    let parsed: unknown;
    try { parsed = await res.json(); } catch { return err("broker_unavailable", "the broker sent an unreadable reply"); }
    return { status: res.status, body: (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown> };
  }

  const isReply = (r: Reply | ToolResult): r is Reply => "status" in r;
  // The same answer for an unknown job and another team's, so neither can be told apart.
  const notFound = (jobId: string) => err("not_found", `no job ${jobId} in team ${team}`, { jobId });
  const ours = (record: Record<string, unknown>) => record.team === team;
  const rejected = (r: Reply) => err("broker_rejected", String(r.body.message ?? "the broker refused the request"), { brokerError: String(r.body.error ?? "unknown") });

  /** Reads one of this team's jobs: the record, or a not_found that says nothing about any other team. */
  async function own(jobId: string): Promise<Record<string, unknown> | ToolResult> {
    // A malformed jobId names no job; never send it on, or an odd path reads as a broker fault.
    if (!parseJobId(jobId)) return notFound(jobId);
    const r = await broker("GET", `/jobs/${encodeURIComponent(jobId)}`);
    if (!isReply(r)) return r;
    if (r.status === 404 || (r.status === 200 && !ours(r.body))) return notFound(jobId);
    if (r.status !== 200) return rejected(r);
    return r.body;
  }

  const server = new McpServer({ name: "plantworks", version: "0.1.0" });

  server.registerTool("job_submit", {
    description: `Submit a job to team ${team}'s Plantworks queue. Idempotent: the same board, card and attempt return the existing job.`,
    inputSchema: {
      board: z.string().describe("Hermes kanban board slug"),
      cardId: z.string().describe("Hermes kanban task ID, for example t_3fa9c01e"),
      attempt: z.number().int().positive().describe("1 for a new card; the next number only to retry a failed job"),
      prompt: z.string().describe("Everything the worker needs: goal, inputs, what done means. At most 65,536 characters"),
      title: z.string().optional().describe("Short label, at most 200 characters"),
      class: z.string().optional().describe("Queue class; omit for the team's default"),
      timeoutSeconds: z.number().int().positive().optional(),
    },
    annotations: { idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    const envelope = {
      jobId: `kb-${a.board}-${a.cardId}-a${a.attempt}`,
      team,
      ...(a.class === undefined ? {} : { class: a.class }),
      task: { prompt: a.prompt, ...(a.title === undefined ? {} : { title: a.title }) },
      ...(a.timeoutSeconds === undefined ? {} : { timeoutSeconds: a.timeoutSeconds }),
    };
    const v = validateEnvelope(envelope);
    if (!v.ok) return err("invalid_envelope", v.errors.join("; "));
    const r = await broker("POST", "/jobs", v.envelope);
    if (!isReply(r)) return r;
    // A 409 body carries the existing record, which may be another team's: pass on nothing of it.
    const conflict = () => err("job_conflict", `job ${envelope.jobId} already exists with a different envelope`, { jobId: envelope.jobId });
    if (r.status === 409) return conflict();
    if (r.status !== 200 && r.status !== 201) return rejected(r);
    if (!ours(r.body)) return conflict();
    return ok({ jobId: envelope.jobId, state: r.body.state, created: r.status === 201 });
  });

  server.registerTool("job_inspect", {
    description: `Read one of team ${team}'s jobs and, once it has ended, a page of its result.`,
    inputSchema: {
      jobId: z.string(),
      resultOffset: z.number().int().nonnegative().optional().describe("Character offset into the result text, to read the next page"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ jobId, resultOffset = 0 }) => {
    const record = await own(jobId);
    if ("content" in record) return record as ToolResult;
    const detail = { ...(record.detail as Record<string, unknown> ?? {}) };
    if (typeof detail.message === "string") detail.message = detail.message.slice(0, MESSAGE_CHARS);
    const out: Record<string, unknown> = { jobId, state: record.state, class: record.class, detail, updatedAt: record.updatedAt };
    if (record.state === "held") out.note = HELD_NOTE;
    const result = record.result as { text: string | null; artifacts?: Array<Record<string, unknown>> } | null;
    if (result) {
      const all = result.text ?? "";
      const text = result.text === null ? null : all.slice(resultOffset, resultOffset + RESULT_PAGE_CHARS);
      out.result = {
        text,
        offset: resultOffset,
        totalChars: all.length,
        truncated: resultOffset + RESULT_PAGE_CHARS < all.length,
        // Metadata only: artifact bytes never come back through the kit.
        artifacts: (result.artifacts ?? []).map(({ name, bytes, sha256, uri }) => ({ name, bytes, sha256, ...(uri === undefined ? {} : { uri }) })),
      };
    }
    return ok(out);
  });

  server.registerTool("job_cancel", {
    description: `Cancel one of team ${team}'s jobs that has not started (queued or held). A running job cannot be cancelled.`,
    inputSchema: { jobId: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    // Checked first, so another team's job is never cancelled. A job's team never changes.
    const record = await own(jobId);
    if ("content" in record) return record as ToolResult;
    const r = await broker("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
    if (!isReply(r)) return r;
    if (r.status === 404) return notFound(jobId);
    if (r.status === 409) {
      const state = (r.body.job as Record<string, unknown> | undefined)?.state ?? record.state;
      return err("not_cancellable", `a ${String(state)} job cannot be cancelled`, { jobId, state });
    }
    if (r.status !== 200) return rejected(r);
    return ok({ jobId, state: r.body.state });
  });

  server.registerTool("job_stats", {
    description: `Count team ${team}'s jobs by state, in total and per class. Lifecycle counts only, not observed execution.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const r = await broker("GET", "/stats");
    if (!isReply(r)) return r;
    if (r.status !== 200) return rejected(r);
    // Only this team's entry, field by field. The broker's other teams, its shared slot budgets and its draining
    // seats never pass. A reply of any other shape is refused, never passed on in part.
    const teams = r.body.teams as Record<string, unknown> | undefined;
    if (!teams || typeof teams !== "object" || Array.isArray(teams)) return err("broker_unavailable", "the broker sent unreadable stats");
    if (!Object.hasOwn(teams, team)) return err("team_not_served", `the broker reports no team ${team}; this server's team is misconfigured`);
    const mine = counts(teams[team]);
    if (!mine) return err("broker_unavailable", "the broker sent unreadable stats");
    const classes = (teams[team] as { classes?: unknown }).classes;
    if (!classes || typeof classes !== "object" || Array.isArray(classes)) return err("broker_unavailable", "the broker sent unreadable stats");
    const perClass: Record<string, Counts> = {};
    for (const [name, c] of Object.entries(classes)) {
      const checked = counts(c);
      if (!checked) return err("broker_unavailable", "the broker sent unreadable stats");
      perClass[name] = checked;
    }
    return ok({ team, ...mine, classes: perClass });
  });

  return server;
}

export async function serveStdio(opts: KitOptions): Promise<void> {
  await createKit(opts).connect(new StdioServerTransport());
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Streamable HTTP at /mcp. Every request needs `Authorization: Bearer <token>`, loopback
 * included: a tunnel or proxy can deliver remote traffic to loopback. Stateless: each request
 * gets its own server and transport.
 */
export async function serveHttp(opts: KitOptions & { host: string; port: number; token: string }): Promise<{ url: string; close(): Promise<void> }> {
  if (!opts.token?.trim()) throw new Error("--http needs PLANTWORKS_MCP_TOKEN");
  const want = digest(opts.token.trim());
  const reply = (res: http.ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") return reply(res, 404, { error: "not_found", message: "The MCP endpoint is /mcp." });
    const got = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!got || !timingSafeEqual(digest(got), want)) {
      return reply(res, 401, { error: "unauthenticated", message: "Send Authorization: Bearer <token>." }, { "www-authenticate": 'Bearer realm="plantworks"' });
    }
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        const tooLarge = (e as Error).message === "body_too_large";
        return reply(res, tooLarge ? 413 : 400, { jsonrpc: "2.0", error: { code: -32700, message: tooLarge ? "Request body too large" : "Parse error" }, id: null });
      }
    }
    const mcp = createKit(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) reply(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => { server.off("error", reject); resolve(); });
  });
  const { port } = server.address() as { port: number };
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}/mcp`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
