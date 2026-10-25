// SPDX-License-Identifier: Apache-2.0
// Wave 3 outcome check as a regression test: the standalone runner's behaviours together, through the
// real `plantworks` bin. Preflight over team specs (PW-11), the governor absorbing 503s, priority hints,
// usage and artifacts on pw/<jobId> (PW-13), the job lock and Ctrl-C, and the host-default lock (D14).
// Sealed: every child gets an environment built from scratch with a temp HOME and PLANTWORKS_HOME, any
// daemon address points at a sentinel that must see no request, and git reads no system or global
// config. The model and the front door are stubs on 127.0.0.1, and Pi is the fake (fixtures/fake-pi.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_0_1 } from "../team/spec.ts";

const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const hasGit = spawnSync("git", ["--version"]).status === 0;

async function serve(handler: (req: IncomingMessage, res: ServerResponse, raw: string) => void) {
  const s = createServer((req, res) => { let raw = ""; req.on("data", (c) => (raw += c)).on("end", () => handler(req, res, raw)); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

async function until(what: string, ok: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

test("the standalone runner's wave 3 behaviours work together through the real bin", { skip: !hasGit && "needs git" }, async (t) => {
  const T = mkdtempSync(join(tmpdir(), "pw-e2e-"));
  let sentinelHits = 0;
  const sentinel = await serve((_q, res) => { sentinelHits++; res.writeHead(599).end(); });
  /** The model endpoint: a models list, `busy` 503s, then answers that report 10/2 usage. */
  const model = { models: ["qwen3.5:9b"], busy: 0, posts: [] as any[] };
  const llm = await serve((req, res, raw) => {
    if (req.method === "GET" && req.url!.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: model.models.map((id) => ({ id, object: "model" })) }));
    const b = raw ? JSON.parse(raw) : {};
    model.posts.push(b);
    if (model.busy > 0) { model.busy--; return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "queue full" } })); }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: `c-${model.posts.length}`, object: "chat.completion", created: 0, model: b.model,
      choices: [{ index: 0, message: { role: "assistant", content: "hello from the stub" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }));
  });
  const events: any[] = [];
  const fd = await serve((_q, res, raw) => { events.push(JSON.parse(raw)); res.writeHead(204).end(); });
  t.after(async () => { await Promise.all([sentinel.close(), llm.close(), fd.close()]); });

  const lock = join(T, "lock", "job.lock");
  mkdirSync(join(T, "lock"));
  /** Built from scratch: nothing from this process's environment but PATH. `undefined` drops a name. */
  const env = (extra: Record<string, string | undefined>) => {
    const e: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: T, PLANTWORKS_HOME: join(T, "pw-home"), OPENRIG_URL: sentinel.url,
      PLANTWORKS_LLM_URL: `${llm.url}/v1`, PLANTWORKS_FRONTDOOR_CALLBACK: `${fd.url}/events`, PLANTWORKS_JOB_LOCK: lock, ...extra,
    };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e as NodeJS.ProcessEnv;
  };
  const running = new Set<ChildProcess>();
  t.after(() => { for (const c of running) c.kill("SIGKILL"); });
  const run = (args: string[], extra: Record<string, string | undefined> = {}) => {
    const child = spawn(process.execPath, [bin, ...args], { env: env(extra), cwd: T });
    running.add(child);
    let out = "", err = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (err += c));
    const done = new Promise<{ code: number | null; out: string; err: string }>((r) => child.on("exit", (code) => { running.delete(child); r({ code, out, err }); }));
    return { child, done };
  };
  const envelope = (id: string, extra: object = {}) => {
    const f = join(T, `${id}.json`);
    writeFileSync(f, JSON.stringify({ jobId: id, team: "social-media", task: { prompt: "Say hi" }, ...extra }));
    return f;
  };

  // A git work tree with a born HEAD and `.env` ignored.
  const work = mkdtempSync(join(T, "work-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", work, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: T, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, ".gitignore"), ".env\n");
  writeFileSync(join(work, "README"), "base\n");
  git("add", ".gitignore", "README");
  git("-c", "user.name=qa", "-c", "user.email=qa@example.invalid", "commit", "-q", "-m", "base");
  const head = git("rev-parse", "HEAD");
  const secret = ".env=SECRET_TOKEN=do-not-commit";
  /** pw/<jobId> off HEAD with `file` at its sha256; the ignored secret written but absent; the user's checkout untouched. */
  const checkArtifacts = (jobId: string, result: any, file: string, content: string) => {
    const a = result.artifacts;
    assert.equal(a.branch, `pw/${jobId}`);
    assert.equal(git("rev-parse", `refs/heads/pw/${jobId}`), a.commit);
    assert.equal(git("rev-parse", `${a.commit}^`), head, "the commit's parent is HEAD");
    assert.deepEqual(a.files.find((f: any) => f.path === file), { path: file, sha256: sha256(content) });
    assert.match(readFileSync(join(work, ".env"), "utf8"), /SECRET_TOKEN/, "the job did write the ignored secret");
    assert.ok(!a.files.some((f: any) => f.path === ".env"));
    assert.ok(!git("ls-tree", "-r", "--name-only", a.commit).split("\n").includes(".env"), "the ignored secret isn't committed");
    assert.equal(git("show", `${a.commit}:${file}`), content);
    assert.deepEqual([git("symbolic-ref", "--short", "HEAD"), git("rev-parse", "HEAD"), git("diff", "--cached", "--name-only")], ["main", head, ""], "the user's branch, HEAD and index are unchanged");
  };

  // Team specs for preflight, emitted by the real bin.
  const cls = { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 };
  writeFileSync(join(T, "def.json"), JSON.stringify({ team: "social-media", trains: 1, perTrain: { orchestrators: 1, workers: { quick: 1 } }, endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" }, defaultClass: "quick", classes: { quick: cls }, events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" } }));
  writeFileSync(join(T, "platform.json"), JSON.stringify({ ...PHASE_0_1, slotCaps: { "social-media": 1 } }));
  const emitted = await run(["pw", "team", "emit", join(T, "def.json"), "--out", join(T, "teams"), "--platform", join(T, "platform.json")]).done;
  assert.equal(emitted.code, 0, emitted.err);
  const preflight = ["pw", "llm", "preflight", "--teams", join(T, "teams"), "--platform", join(T, "platform.json")];

  await t.test("preflight --teams passes when every model the specs name is served, and refuses when one is missing", async () => {
    const ok = await run([...preflight, "--json"]).done;
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.deepEqual(JSON.parse(ok.out).checked, ["qwen3.5:9b"]);
    model.models = ["some-other-model"];
    const missing = await run(preflight).done;
    model.models = ["qwen3.5:9b"];
    assert.notEqual(missing.code, 0);
    assert.match(missing.out + missing.err, /not served: qwen3\.5:9b/);
  });

  await t.test("503, 503, 200: done, with usage and the work on pw/<jobId> without the ignored secret; no priority field by default", async () => {
    const id = "kb-social-media-t_e2e503-a1";
    model.busy = 2;
    model.posts.length = 0;
    events.length = 0;
    const r = await run(["pw", "job", "run", envelope(id, { priority: "high" }), "--cwd", work, "--pi", fakePi], { PI_FAKE_WRITE: `out.txt=hello work;${secret}` }).done;
    assert.equal(r.code, 0, r.err);
    const result = JSON.parse(r.out);
    assert.deepEqual([result.state, result.detail, result.text], ["done", { outcome: "succeeded" }, "hello from the stub"]);
    assert.equal(model.posts.length, 3, "the governor waited out two 503s behind Pi's one call");
    assert.ok(model.posts.every((p) => !("priority" in p)), "no priority without PLANTWORKS_LLM_PRIORITY");
    assert.deepEqual([result.usage.promptTokens, result.usage.completionTokens], [10, 2]);
    assert.ok(result.usage.wallSeconds > 0);
    checkArtifacts(id, result, "out.txt", "hello work");
    await until("the done event", () => events.length === 4);
    assert.deepEqual(events.map((e) => e.data.state), ["queued", "claimed", "running", "done"]);
    const last = events.at(-1).data;
    assert.deepEqual(last.usage, { promptTokens: 10, completionTokens: 2 }, "the event's D11 usage has no wall time");
    assert.ok(last.artifacts.some((a: any) => a.name === "out.txt" && a.uri === `git:${result.artifacts.commit}:out.txt`));
    assert.ok(!JSON.stringify([result, events]).includes("SECRET_TOKEN"));
    assert.equal(existsSync(lock), false, "the lock is released");
  });

  await t.test("PLANTWORKS_LLM_PRIORITY=1 sends the envelope's priority (high is -1)", async () => {
    model.posts.length = 0;
    const r = await run(["pw", "job", "run", envelope("kb-social-media-t_e2eprio-a1", { priority: "high" }), "--cwd", work, "--pi", fakePi], { PLANTWORKS_LLM_PRIORITY: "1" }).done;
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(model.posts.map((p) => p.priority), [-1]);
  });

  /** Holds the lock with a hanging Pi, checks a second run is refused naming `lockAt`, then interrupts the first. */
  const contend = async (card: string, lockAt: string, extra: Record<string, string | undefined>) => {
    const pidfile = join(T, `${card}.pid`);
    const id = `kb-social-media-${card}-a1`;
    const first = run(["pw", "job", "run", envelope(id), "--cwd", work, "--pi", fakePi], { ...extra, PI_FAKE_MODE: "hang", PI_FAKE_SELF_PIDFILE: pidfile, PI_FAKE_WRITE: `partial.txt=work in progress;${secret}` });
    await until("Pi running under the lock", () => existsSync(pidfile) && existsSync(lockAt) && events.some((e) => e.subject === id && e.data.state === "running"));
    const second = await run(["pw", "job", "run", envelope(`kb-social-media-${card}2-a1`), "--cwd", work, "--pi", fakePi], extra).done;
    assert.equal(second.code, 2, second.out + second.err);
    assert.ok(second.err.includes(`one job at a time on this host: ${lockAt}`), second.err);
    assert.ok(!events.some((e) => e.subject === `kb-social-media-${card}2-a1`), "the refused run emits nothing");
    first.child.kill("SIGINT");
    const r = await first.done;
    assert.equal(r.code, 1, r.err);
    assert.equal(alive(Number(readFileSync(pidfile, "utf8"))), false, "Pi has exited");
    assert.equal(existsSync(lockAt), false, "the lock is released");
    return { id, result: JSON.parse(r.out) };
  };

  await t.test("lock and Ctrl-C: a second run is refused (exit 2); the first ends failed/interrupted after Pi exits, and its work is committed", async () => {
    events.length = 0;
    const { id, result } = await contend("t_e2ehang", lock, {});
    assert.deepEqual([result.state, result.detail.reason], ["failed", "interrupted"]);
    checkArtifacts(id, result, "partial.txt", "work in progress");
    assert.deepEqual([result.usage.promptTokens, result.usage.completionTokens], [null, null]);
    await until("the failed event", () => events.some((e) => e.data.state === "failed"));
    assert.deepEqual(events.map((e) => e.data.state), ["queued", "claimed", "running", "failed"]);
  });

  await t.test("without PLANTWORKS_JOB_LOCK the host default is $XDG_RUNTIME_DIR/plantworks/job.lock, in a mode 700 directory", async () => {
    const xdg = join(T, "xdg");
    mkdirSync(xdg, { mode: 0o700 });
    const lockAt = join(xdg, "plantworks", "job.lock");
    await until("nothing left from the previous step", () => !existsSync(lock));
    const pending = contend("t_e2exdg", lockAt, { PLANTWORKS_JOB_LOCK: undefined, XDG_RUNTIME_DIR: xdg });
    await until("the default lock directory", () => existsSync(join(xdg, "plantworks")));
    assert.equal(statSync(join(xdg, "plantworks")).mode & 0o777, 0o700);
    await pending;
    assert.equal(existsSync(lock), false, "the explicit path was not used");
  });

  assert.equal(sentinelHits, 0, "nothing reached a daemon");
  assert.equal(existsSync(join(T, ".openrig")), false, "no default OpenRig home was created");
});
