// SPDX-License-Identifier: Apache-2.0
// PW-29 on the broker worker path: the seat's governor sends each claimed job's effective priority
// (class base + envelope offset, as the broker ordered the claim), one job at a time, and nothing
// between jobs. Stub broker and stub endpoint on 127.0.0.1; no daemon, no inference.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";

async function until(what: string, ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("worker run with PLANTWORKS_LLM_PRIORITY=1: each job's effective priority reaches the endpoint, even for a call made before the claim answer, and none goes out without a job", async (t) => {
  const teams = mkdtempSync(join(tmpdir(), "pw-wprio-teams-"));
  assert.ok("files" in emitTeam({
    team: "t", trains: 1, perTrain: { orchestrators: 1, workers: { small: 1 } },
    endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "t" }, defaultClass: "small",
    classes: { small: { slots: 1, priority: 2, model: "qwen3.5:9b", context: { maxContextTokens: 8192, thinkingTokens: 0 }, perCall: { maxOutputTokens: 700, deadlineSeconds: 5 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 } },
    events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
  }, teams, { ...PHASE_0_1, slotCaps: { t: 1 } }));

  // The broker hands out job-a (urgent), then job-b (low), then nothing; a job is done when told.
  const jobs = [{ jobId: "job-a", priority: "urgent" }, { jobId: "job-b", priority: "low" }];
  let claims = 0;
  const done = new Set<string>();
  // The first claim-next answer is held back, as when the daemon wakes Pi on qitem create before
  // the broker has answered the worker.
  let releaseFirstClaim!: () => void;
  const firstClaimHeld = new Promise<void>((r) => (releaseFirstClaim = r));
  const broker = createServer(async (req, res) => {
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "DELETE") return json({});
    if (req.url!.endsWith("/drain")) return json({ inFlight: [] });
    if (req.url === "/plantworks/v1/claim-next") {
      const job = jobs[claims++];
      if (!job) return res.writeHead(204).end();
      if (job.jobId === "job-a") await firstClaimHeld;
      return json({ job: { jobId: job.jobId }, envelope: { jobId: job.jobId, team: "t", priority: job.priority, task: { prompt: "p" } } });
    }
    const id = decodeURIComponent(req.url!.split("/").pop()!);
    json({ state: done.has(id) ? "done" : "running" });
  });
  const seen: (number | undefined)[] = [];
  const llm = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push(raw ? JSON.parse(raw).priority : undefined);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  });
  for (const s of [broker, llm]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  t.after(() => { broker.close(); llm.closeAllConnections(); llm.close(); });
  const port = (s: typeof broker) => (s.address() as { port: number }).port;

  const home = mkdtempSync(join(tmpdir(), "pw-wprio-home-"));
  const platform = join(home, "platform.json");
  writeFileSync(platform, JSON.stringify({ ...PHASE_0_1, slotCaps: { t: 1 } }));
  const env: Record<string, string> = {
    PLANTWORKS_BROKER_URL: `http://127.0.0.1:${port(broker)}`, PLANTWORKS_TEAMS_DIR: teams, PLANTWORKS_PLATFORM_FILE: platform,
    PLANTWORKS_LLM_URL: `http://127.0.0.1:${port(llm)}/v1`, PLANTWORKS_GOVERNOR_PORT: "0", OPENRIG_HOME: home, PLANTWORKS_LLM_PRIORITY: "1",
  };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const oldArgv = process.argv;
  process.argv = ["node", "plantworks", "worker", "run", "--team", "t", "--seat", "worker-0@t", "--poll-ms", "250"];
  t.after(() => {
    process.argv = oldArgv;
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const program = new Command();
  const [{ workerVerb }, { runProgram }] = await Promise.all([import("./worker.ts"), import("../../../packages/cli/dist/index.js")]);
  workerVerb(program);
  const running = runProgram(program, process.argv);

  let baseUrl: string | undefined;
  while (!baseUrl) {
    try { baseUrl = (Object.values(JSON.parse(readFileSync(join(home, "state", "pi", "worker-0@t", "agent", "models.json"), "utf8")).providers)[0] as { baseUrl: string }).baseUrl; } catch { await new Promise((r) => setTimeout(r, 20)); }
  }
  const pi = () => fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.5:9b", messages: [] }) });

  await until("job-a's claim in flight", () => claims >= 1);
  // Pi was woken by the qitem and calls before the worker has job-a's priority: the call is held.
  const early = pi();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, [], "no model call reaches the endpoint before the job's priority is known");
  releaseFirstClaim();
  await early;
  done.add("job-a");
  await until("job-b claimed", () => claims >= 2);
  await pi();
  done.add("job-b");
  await until("the next claim finds nothing", () => claims >= 3);
  // Between jobs nothing should call; one that does waits for the next job's priority.
  const stray = pi();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, [2 + -3, 2 + 2], "class base 2 + urgent -3, then base 2 + low +2; nothing without a job");
  void stray.catch(() => {});

  process.emit("SIGTERM" as NodeJS.Signals);
  await running;
});
