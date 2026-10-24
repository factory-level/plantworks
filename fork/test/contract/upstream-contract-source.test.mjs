// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { piSeatPaths } from "../../../packages/daemon/dist/adapters/pi-runner-protocol.js";
import { seatAgentDir } from "../../src/seat/pi-seat-files.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path) => readFileSync(join(root, path), "utf8");

test("DaemonOptions/createDaemon at packages/daemon/src/startup.ts:199-230,310 and startServer at packages/daemon/src/index.ts:249 stay pinned", () => {
  const startup = source("packages/daemon/src/startup.ts");
  const index = source("packages/daemon/src/index.ts");
  const options = startup.match(/interface DaemonOptions\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(options, "upstream packages/daemon/src/startup.ts:199 declares DaemonOptions");
  assert.match(startup, /export async function createDaemon\(opts\?: DaemonOptions\)/,
    "upstream packages/daemon/src/startup.ts:310 exports createDaemon with DaemonOptions");
  for (const name of [
    "dbPath", "bindPlan", "tmuxExec", "argvExec", "cmuxExec", "cmuxFactory", "cmuxTimeoutMs",
    "tmuxOptionPlatform", "slowOpRecorder", "bearerToken", "terminalBearerToken", "webUiEnabled",
  ]) assert.match(options, new RegExp(`\\b${name}\\??:`), `DaemonOptions.${name}`);
  assert.match(index, /export async function startServer\(port\?: number, options\?: Parameters<typeof createDaemon>\[0\]\)/,
    "upstream packages/daemon/src/index.ts:249 accepts the createDaemon options as startServer's second argument");
});

test("daemon queue create/claim/unclaim wire shapes stay pinned to packages/daemon/src/routes/queue.ts:533-643", () => {
  const routes = source("packages/daemon/src/routes/queue.ts");
  const server = source("packages/daemon/src/server.ts");
  const identity = source("packages/daemon/src/routes/require-sender-identity.ts");
  assert.match(server, /app\.route\("\/api\/queue", queueRoutes\(\)\)/,
    "upstream packages/daemon/src/server.ts:795 mounts queueRoutes at /api/queue");
  assert.match(identity, /SENDER_IDENTITY_HEADER\s*=\s*"x-openrig-session"/,
    "upstream packages/daemon/src/routes/require-sender-identity.ts:34 defines the sender header");
  assert.match(routes, /app\.post\("\/create"/);
  const create = routes.slice(routes.indexOf('app.post("/create"'), routes.indexOf("// POST /:qitemId/claim"));
  const createRequest = create.slice(create.indexOf("c.req.json<{"), create.indexOf("}>().catch"));
  for (const name of ["qitemId", "sourceSession", "classificationBinding", "destinationSession", "body", "priority", "tier", "tags", "expiresAt", "chainOfRecord", "targetRepo", "humanIntent", "humanAlert", "humanDetail", "replyTo", "humanQuestions", "summary", "evidenceRef", "nudge", "hostId"])
    assert.match(createRequest, new RegExp(`\\b${name}\\??:`), `queue create request ${name}`);
  assert.match(create, /return c\.json\(\{ \.\.\.item, \.\.\.\(advisory \? \{ advisories: \[advisory\] \} : \{\}\) \}, 201\)/,
    "create returns the persisted item, optional advisories, and HTTP 201");
  assert.match(routes, /app\.post\("\/:qitemId\/claim"/);
  const claim = routes.slice(routes.indexOf('app.post("/:qitemId/claim"'), routes.indexOf('// POST /:qitemId/unclaim'));
  assert.match(claim, /json<\{ destinationSession\?: string \}>\(\)/);
  assert.match(claim, /return c\.json\(item\)/, "claim returns the claimed item with HTTP 200");
  assert.match(claim, /requireSenderIdentity\(c, \{ verb: "queue claim", bodyClaim: body\.destinationSession \}\)/,
    "claim uses the shared sender identity resolver");
  assert.match(claim, /getRepo\(c\)\.claim\(\{ qitemId, destinationSession, identityProvenance:/);
  assert.match(routes, /app\.post\("\/:qitemId\/unclaim"/);
  const unclaim = routes.slice(routes.indexOf('app.post("/:qitemId/unclaim"'), routes.indexOf("// POST /:qitemId/update"));
  assert.match(unclaim, /json<\{ destinationSession\?: string; reason\?: string \}>\(\)/);
  assert.match(unclaim, /getRepo\(c\)\.unclaim\(qitemId, destinationSession, body\.reason \?\? "manual",/);
  assert.match(unclaim, /return c\.json\(item\)/, "unclaim returns the updated item with HTTP 200");
  assert.match(create, /requireSenderIdentity\(c, \{ verb: "queue create", bodyClaim: body\.sourceSession \}\)/,
    "create uses the shared sender identity resolver");
  assert.match(unclaim, /requireSenderIdentity\(c, \{ verb: "queue unclaim", bodyClaim: body\.destinationSession \}\)/,
    "unclaim uses the shared sender identity resolver");
  assert.match(identity, /if \(session\)\s*\{[\s\S]*?return \{ ok: true, session, provenance: transportProvenance\(c\) \};/,
    "a transport session takes precedence over the body claim");
  assert.match(identity, /if \(claim\) return \{ ok: true, session: claim, provenance: "claimed:v1" \};/,
    "without transport identity, the body claim is recorded as claimed:v1");
  assert.match(identity, /error: "actor_required"[\s\S]*?\}, 400\)/,
    "without either identity source the route returns actor_required / HTTP 400");
  assert.match(identity, /parts\[2\] !== selfId\) return session;[\s\S]*?return `\$\{parts\[0\]\}@\$\{parts\[1\]\}`;/,
    "only this daemon's own host suffix is canonicalized away");
});

test("Pi seat directories stay pinned to packages/daemon/src/adapters/pi-runner-protocol.ts:23-42", () => {
  assert.deepEqual(piSeatPaths("/state", "worker@rig"), {
    seatRoot: "/state/worker@rig",
    agentDir: "/state/worker@rig/agent",
    sessionsDir: "/state/worker@rig/sessions",
    runnerStatePath: "/state/worker@rig/runner-state.json",
  });
});

test("the fork's seat agent dir is upstream's: OPENRIG_HOME/state/pi (startup.ts:693) joined by piSeatPaths", () => {
  // Upstream's daemon roots Pi seat state at OPENRIG_HOME/state/pi and hands that root to the Pi adapters.
  assert.match(source("packages/daemon/src/startup.ts"), /const piStateRoot = nodePath\.join\(OPENRIG_HOME, "state", "pi"\);/,
    "upstream packages/daemon/src/startup.ts:693 roots Pi seat state at OPENRIG_HOME/state/pi");
  // fork/src/seat/pi-seat-files.ts builds the same directory itself; if upstream moves it, the fork's seat files go unread.
  for (const session of ["worker@rig", "pw-kb-b-t_1-a1", "dev-worker.0@team"]) {
    const home = "/srv/home";
    assert.equal(seatAgentDir(home, session), piSeatPaths(join(home, "state", "pi"), session).agentDir, session);
  }
});

test("daemon start --no-kernel reaches the OPENRIG_NO_KERNEL spawn env via daemon.ts:238-254 and daemon-lifecycle.ts:531-533", () => {
  const command = source("packages/cli/src/commands/daemon.ts");
  const lifecycle = source("packages/cli/src/daemon-lifecycle.ts");
  const kernelBoot = source("packages/daemon/src/domain/kernel-boot.ts");
  assert.match(command, /const skipKernel = opts\.kernel === false;[\s\S]*?await startDaemon\([\s\S]*?skipKernelBoot: skipKernel,/,
    "daemon CLI --no-kernel sets skipKernelBoot on the startDaemon call");
  assert.match(lifecycle, /if \(opts\.skipKernelBoot\)\s*\{\s*env\["OPENRIG_NO_KERNEL"\]\s*=\s*"1";/,
    "upstream packages/cli/src/daemon-lifecycle.ts:531-533 maps skipKernelBoot to OPENRIG_NO_KERNEL=1");
  assert.match(lifecycle, /deps\.spawn\(process\.execPath, \[daemonEntry\], \{[\s\S]*?env: buildDaemonEnv\(/,
    "the generated environment is passed to the daemon child process");
  assert.match(kernelBoot, /process\.env\["OPENRIG_NO_KERNEL"\] === "1"[\s\S]*?tracker\.setSkipped\(reason\)/,
    "upstream packages/daemon/src/domain/kernel-boot.ts:77-101 honors OPENRIG_NO_KERNEL=1");
  assert.match(source("fork/src/daemon/boot.test.ts"), /OPENRIG_NO_KERNEL=1 — skipping kernel auto-boot/,
    "fork boot test exercises the daemon's no-kernel consumer behavior");
});
