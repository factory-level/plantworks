// SPDX-License-Identifier: Apache-2.0
// The seat agent's HTTP transport against an in-process fake agent: bearer, request checks and the
// client's fail-closed answers. Loopback, OS-chosen ports, no tmux.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MAX_EXEC_BYTES, httpTransport, serveSeatAgent, tokenFrom } from "./http.ts";
import { createSeatRouter, ROUTER_ERROR } from "./router.ts";
import type { SeatRequest } from "./transport.ts";

const env = { SEAT_TOKEN: "s3cret-token" };
const fakeAgent = () => {
  const seen: SeatRequest[] = [];
  return { seen, handle: async (req: SeatRequest) => { seen.push(req); return { code: 0, stdout: `ran ${req.argv.join(" ")}\n`, stderr: "" }; } };
};

test("token references: a variable name only; an unset, blank or malformed reference refuses instead of meaning no auth", () => {
  assert.equal(tokenFrom("SEAT_TOKEN", env), "s3cret-token");
  for (const [ref, e] of [["SEAT_TOKEN", {}], ["SEAT_TOKEN", { SEAT_TOKEN: "  " }], ["s3cret-token", env], ["", env]] as const) {
    assert.throws(() => tokenFrom(ref, e as Record<string, string>), ref);
  }
});

test("/exec needs the bearer; other routes, methods and malformed bodies are refused before the agent runs", async () => {
  const agent = fakeAgent();
  const server = await serveSeatAgent({ agent, tokenEnv: "SEAT_TOKEN", env });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, "loopback and an OS-chosen port by default");
    const post = (path: string, body: string, auth?: string, method = "POST") =>
      fetch(`${server.url}${path}`, { method, body: method === "GET" ? undefined : body, headers: auth ? { authorization: auth } : {} }).then((r) => r.status);
    const ok = JSON.stringify({ argv: ["tmux", "list-sessions"] });
    assert.equal(await post("/exec", ok), 401);
    assert.equal(await post("/exec", ok, "Bearer wrong"), 401);
    assert.equal(await post("/exec", ok, "s3cret-token"), 401, "the scheme is required");
    assert.equal(await post("/other", ok, "Bearer s3cret-token"), 404);
    assert.equal(await post("/exec", ok, "Bearer s3cret-token", "GET"), 405);
    assert.equal(await post("/exec", "{not json", "Bearer s3cret-token"), 400);
    assert.equal(await post("/exec", JSON.stringify({ argv: "tmux ls" }), "Bearer s3cret-token"), 400);
    assert.equal(await post("/exec", JSON.stringify({ argv: ["tmux"], stdin: 5 }), "Bearer s3cret-token"), 400);
    assert.equal(await post("/exec", JSON.stringify({ argv: ["tmux"], stdin: "x".repeat(MAX_EXEC_BYTES) }), "Bearer s3cret-token"), 413);
    assert.equal(agent.seen.length, 0, "nothing refused reached the agent");
    assert.equal(await post("/exec", ok, "Bearer s3cret-token"), 200);
    assert.deepEqual(agent.seen, [{ argv: ["tmux", "list-sessions"] }]);
  } finally {
    await server.close();
  }
  await assert.rejects(serveSeatAgent({ agent, tokenEnv: "SEAT_TOKEN", env: {} }), /SEAT_TOKEN is not set/);
});

test("the transport answers only a well-formed 200; a wrong token, redirect, malformed reply or timeout rejects, and the router fails closed", async () => {
  const agent = fakeAgent();
  const server = await serveSeatAgent({ agent, tokenEnv: "SEAT_TOKEN", env });
  const odd = http.createServer((req, res) => {
    if (req.url === "/redirect/exec") return void res.writeHead(307, { location: `${server.url}/exec` }).end();
    if (req.url === "/slow/exec") return; // never answers
    if (req.url === "/error/exec") return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code: 0, stdout: "", stderr: "" }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: "0", stdout: 1 }));
  });
  await new Promise<void>((r) => odd.listen(0, "127.0.0.1", () => r()));
  const oddUrl = `http://127.0.0.1:${(odd.address() as { port: number }).port}`;
  try {
    const good = httpTransport({ url: server.url, tokenEnv: "SEAT_TOKEN", env });
    assert.deepEqual(await good({ argv: ["tmux", "has-session", "-t", "rs-a"] }), { code: 0, stdout: "ran tmux has-session -t rs-a\n", stderr: "" });

    const failing = {
      "wrong token": httpTransport({ url: server.url, tokenEnv: "SEAT_TOKEN", env: { SEAT_TOKEN: "wrong" } }),
      "redirect": httpTransport({ url: `${oddUrl}/redirect`, tokenEnv: "SEAT_TOKEN", env }),
      "malformed reply": httpTransport({ url: oddUrl, tokenEnv: "SEAT_TOKEN", env }),
      "timeout": httpTransport({ url: `${oddUrl}/slow`, tokenEnv: "SEAT_TOKEN", env, timeoutMs: 300 }),
      "error status with a well-formed body": httpTransport({ url: `${oddUrl}/error`, tokenEnv: "SEAT_TOKEN", env }),
    };
    for (const [name, t] of Object.entries(failing)) {
      await assert.rejects(t({ argv: ["tmux", "has-session", "-t", "rs-a"] }), name);
      // Through the router, every one of these is "did not answer": never an absence upstream would act on.
      const router = createSeatRouter({ routes: new Map([["rs-a", t]]), local: { argv: async () => "", shell: async () => "" } });
      await assert.rejects(router.argvExec(["tmux", "has-session", "-t", "=rs-a"]), (e: Error) => e.message.startsWith(ROUTER_ERROR) && !/can't find session|no server running/.test(e.message), name);
    }
    assert.equal(agent.seen.length, 1, "only the good call reached the agent");
    assert.throws(() => httpTransport({ url: "file:///etc/passwd", tokenEnv: "SEAT_TOKEN", env }), /http\(s\)/);
  } finally {
    odd.closeAllConnections();
    odd.close();
    await server.close();
  }
});
