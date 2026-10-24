#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// A stand-in for `pi --mode rpc` in tests: just enough of the RPC protocol, and real model calls
// to the baseUrl in $PI_CODING_AGENT_DIR/models.json (the governor), the way Pi makes them.
// FAKE_PI_MODE: "ok" (default), "calls=N" (N calls, then settle), "hang" (never settle), "crash".
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_PI_MODE ?? "ok";
const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = Object.values(models.providers)[0];
const out = (rec) => process.stdout.write(`${JSON.stringify(rec)}\n`);
let lastText = null;

async function run(message) {
  if (mode === "hang") return;
  if (mode === "crash") process.exit(3);
  const calls = mode.startsWith("calls=") ? Number(mode.slice(6)) : 1;
  let message_ = { role: "assistant", stopReason: "stop" };
  for (let i = 0; i < calls; i++) {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.models[0].id, messages: [{ role: "user", content: message }], max_tokens: 99999, num_ctx: 99999 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) message_ = { role: "assistant", stopReason: "error", errorMessage: `${res.status} ${body.error?.message ?? ""}`.trim() };
    else { message_ = { role: "assistant", stopReason: "stop" }; lastText = body.choices[0].message.content; }
  }
  out({ type: "message_end", message: message_ });
  out({ type: "agent_end", messages: [message_], willRetry: false });
  out({ type: "agent_settled", aborted: false });
}

let buf = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const cmd = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (cmd.type === "prompt") { out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }); run(cmd.message); }
    else if (cmd.type === "get_last_assistant_text") out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { text: lastText } });
    else out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unsupported in fake pi" });
  }
});
process.stdin.on("end", () => process.exit(0));
