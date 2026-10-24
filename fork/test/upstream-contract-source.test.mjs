// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { piSeatPaths } from "../../packages/daemon/dist/adapters/pi-runner-protocol.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (path) => readFileSync(join(root, path), "utf8");

test("daemon options at packages/daemon/src/startup.ts:199-230 and startServer at packages/daemon/src/index.ts:249 stay pinned", () => {
  const startup = source("packages/daemon/src/startup.ts");
  const index = source("packages/daemon/src/index.ts");
  const options = startup.match(/interface DaemonOptions\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(options, "upstream packages/daemon/src/startup.ts:199 declares DaemonOptions");
  for (const name of [
    "dbPath", "bindPlan", "tmuxExec", "argvExec", "cmuxExec", "cmuxFactory", "cmuxTimeoutMs",
    "tmuxOptionPlatform", "slowOpRecorder", "bearerToken", "terminalBearerToken", "webUiEnabled",
  ]) assert.match(options, new RegExp(`\\b${name}\\??:`), `DaemonOptions.${name}`);
  assert.match(index, /export async function startServer\(port\?: number, options\?: Parameters<typeof createDaemon>\[0\]\)/,
    "upstream packages/daemon/src/index.ts:249 accepts the createDaemon options as startServer's second argument");
});

test("daemon queue create/claim/unclaim and sender identity stay pinned to routes/queue.ts:511-638", () => {
  const routes = source("packages/daemon/src/routes/queue.ts");
  const server = source("packages/daemon/src/server.ts");
  const identity = source("packages/daemon/src/routes/require-sender-identity.ts");
  assert.match(server, /app\.route\("\/api\/queue", queueRoutes\(\)\)/,
    "upstream packages/daemon/src/server.ts:795 mounts queueRoutes at /api/queue");
  assert.match(identity, /SENDER_IDENTITY_HEADER\s*=\s*"x-openrig-session"/,
    "upstream packages/daemon/src/routes/require-sender-identity.ts:34 defines the sender header");
  assert.match(routes, /app\.post\("\/create"/);
  for (const name of ["qitemId", "sourceSession", "destinationSession", "body", "priority", "targetRepo"])
    assert.match(routes.slice(routes.indexOf('app.post("/create"'), routes.indexOf("// POST /:qitemId/claim")), new RegExp(`\\b${name}\\??:`), `queue create ${name}`);
  assert.match(routes, /app\.post\("\/:qitemId\/claim"/);
  const claim = routes.slice(routes.indexOf('app.post("/:qitemId/claim"'), routes.indexOf('// POST /:qitemId/unclaim'));
  assert.match(claim, /json<\{ destinationSession\?: string \}>\(\)/);
  assert.match(routes, /getRepo\(c\)\.claim\(\{ qitemId, destinationSession, identityProvenance:/);
  assert.match(routes, /app\.post\("\/:qitemId\/unclaim"/);
  const unclaim = routes.slice(routes.indexOf('app.post("/:qitemId/unclaim"'), routes.indexOf("// POST /:qitemId/update"));
  assert.match(unclaim, /json<\{ destinationSession\?: string; reason\?: string \}>\(\)/);
  assert.match(routes, /getRepo\(c\)\.unclaim\(qitemId, destinationSession, body\.reason \?\? "manual",/);
  assert.match(routes, /requireSenderIdentity\(c, \{ verb: "queue (create|claim|unclaim)"/);
});

test("Pi seat directories stay pinned to packages/daemon/src/adapters/pi-runner-protocol.ts:23-42", () => {
  assert.deepEqual(piSeatPaths("/state", "worker@rig"), {
    seatRoot: "/state/worker@rig",
    agentDir: "/state/worker@rig/agent",
    sessionsDir: "/state/worker@rig/sessions",
    runnerStatePath: "/state/worker@rig/runner-state.json",
  });
});

test("managed daemon boot maps skipKernelBoot to OPENRIG_NO_KERNEL at packages/cli/src/daemon-lifecycle.ts:531-533", () => {
  const lifecycle = source("packages/cli/src/daemon-lifecycle.ts");
  assert.match(lifecycle, /if \(opts\.skipKernelBoot\)\s*\{\s*env\["OPENRIG_NO_KERNEL"\]\s*=\s*"1";/,
    "upstream packages/cli/src/daemon-lifecycle.ts:531-533 maps skipKernelBoot to OPENRIG_NO_KERNEL=1");
});
