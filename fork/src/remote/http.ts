// SPDX-License-Identifier: Apache-2.0
// The seat agent over HTTP (PW-32): `POST /exec` with a bearer token. The agent side serves one
// allowlisted seat agent (seat-agent.ts); the router side is a SeatTransport. The token is never
// written in config: both sides name the environment variable that holds it (a secret reference).
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isLoopbackBind } from "../../../packages/daemon/dist/middleware/auth-bearer-token.js";
import type { SeatRequest, SeatResponse, SeatTransport } from "./transport.ts";

/** A request body carries one tmux command and at most a staged buffer or config text. */
export const MAX_EXEC_BYTES = 4 * 1024 * 1024;
const TOKEN_ENV = /^[A-Z_][A-Z0-9_]*$/;

/** The token a secret reference names, or a thrown error: an unset, blank or badly named reference never means "no auth". */
export function tokenFrom(tokenEnv: string, env: Record<string, string | undefined> = process.env): string {
  if (!TOKEN_ENV.test(tokenEnv)) throw new Error(`token reference must be an environment variable name, not ${JSON.stringify(tokenEnv)}`);
  const token = env[tokenEnv]?.trim();
  if (!token) throw new Error(`${tokenEnv} is not set: the seat agent's bearer token is required`);
  return token;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export interface ServeOptions {
  agent: { handle(req: SeatRequest): Promise<SeatResponse> };
  /** The environment variable that holds the bearer token. */
  tokenEnv: string;
  host?: string;
  port?: number;
  env?: Record<string, string | undefined>;
}

/** Serves `POST /exec` on host:port (loopback and an OS-chosen port by default). Every request needs the bearer. */
export async function serveSeatAgent(opts: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const want = digest(tokenFrom(opts.tokenEnv, opts.env));
  const host = opts.host ?? "127.0.0.1";
  // An empty or wildcard host listens on every interface. A seat agent runs tmux commands: it binds only an address
  // the operator names (loopback, or the one interface the daemon reaches it on).
  if (!host.trim()) throw new Error("seat agent bind host is empty; name an address, for example 127.0.0.1");
  if (["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"].includes(host.trim())) throw new Error(`seat agent bind host ${host} is a wildcard; name the one address to listen on`);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const got = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!got || !timingSafeEqual(digest(got), want)) return send(401, { error: "unauthorized" });
    if (req.url !== "/exec") return send(404, { error: "not_found" });
    if (req.method !== "POST") return send(405, { error: "method_not_allowed" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_EXEC_BYTES) return send(413, { error: "too_large" });
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "invalid_json" }); }
    const { argv, stdin } = (body ?? {}) as { argv?: unknown; stdin?: unknown };
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string") || (stdin !== undefined && typeof stdin !== "string")) {
      return send(400, { error: "invalid_request" });
    }
    send(200, await opts.agent.handle({ argv, ...(stdin === undefined ? {} : { stdin }) }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 0, host, () => resolve()); });
  const { port } = server.address() as { port: number };
  const shown = isLoopbackBind(host) || !host.includes(":") ? host : `[${host}]`;
  return { url: `http://${shown}:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/**
 * The router's side: one agent's `/exec`. Resolves only with a well-formed 200 answer. Anything else (a wrong token,
 * a timeout, a refused connection, a redirect, a malformed reply) rejects, which the router reports as an
 * unreachable agent: fail closed, never read as absence.
 */
export function httpTransport(opts: { url: string; tokenEnv: string; timeoutMs?: number; env?: Record<string, string | undefined>; fetch?: typeof fetch }): SeatTransport {
  const token = tokenFrom(opts.tokenEnv, opts.env);
  const base = new URL(opts.url);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error(`seat agent URL must be http(s): ${opts.url}`);
  const exec = new URL("exec", base.href.endsWith("/") ? base : `${base.href}/`).href;
  const doFetch = opts.fetch ?? fetch;
  return async (req) => {
    const res = await doFetch(exec, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(req),
    });
    if (res.status !== 200) throw new Error(`seat agent answered ${res.status}`);
    const r = await res.json() as Partial<SeatResponse>;
    if (!Number.isInteger(r.code) || typeof r.stdout !== "string" || typeof r.stderr !== "string") throw new Error("seat agent sent a malformed reply");
    return { code: r.code!, stdout: r.stdout, stderr: r.stderr };
  };
}
