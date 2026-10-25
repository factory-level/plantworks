// SPDX-License-Identifier: Apache-2.0
// PW-20 render and team removal. Disposable directories and a disposable broker SQLite file only:
// no daemon, and the spawned CLI gets a temporary OPENRIG_HOME and no OPENRIG_DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { emitTeam } from "./command.ts";
import { PHASE_0_1 } from "./spec.ts";
import { fleetFor, renderFleet, seatNames } from "./render.ts";
import { TRIMMED_SYSTEM_MD, TRIMMED_TOOLS } from "../seat/pi-seat-files.ts";
import { API, createBroker, loadTeams } from "../broker/server.ts";
import { openStore } from "../broker/store.ts";
import { sealedEnv } from "../test-support/sealed-env.ts";

const cls = (o: Record<string, unknown>) => ({ model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1, ...o });
const definition = (team: string) => ({
  team,
  trains: 2,
  perTrain: { orchestrators: 1, workers: { quick: 2, long: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: team },
  defaultClass: "quick",
  classes: { quick: cls({ slots: 1 }), long: cls({ slots: 0, toolProfile: "trimmed", context: { maxContextTokens: 32768, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1024, deadlineSeconds: 45 } }) },
  events: { callbackDefault: "${PLANTWORKS_FRONTDOOR_CALLBACK}", approvalConsumer: "frontdoor" },
});
const platform = (...teams: string[]) => ({ ...PHASE_0_1, slotCaps: Object.fromEntries(teams.map((t) => [t, 1])) });
const GOVERNOR = "http://127.0.0.1:7999/v1";
const env = { OPENRIG_HOME: undefined };

function teamsDir(...teams: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pw-render-teams-"));
  for (const t of teams) assert.ok("files" in emitTeam(definition(t), dir, platform(...teams)));
  return dir;
}
const fresh = () => join(mkdtempSync(join(tmpdir(), "pw-render-out-")), "out");

test("fleet: workers.max = trains × perTrain.workers[class], with seat names <class>-NN@<team>", () => {
  const teams = loadTeams(teamsDir("social-media"), platform("social-media"));
  assert.deepEqual(fleetFor(teams.get("social-media")!), {
    team: "social-media",
    classes: {
      quick: { workersMax: 4, seats: ["quick-01@social-media", "quick-02@social-media", "quick-03@social-media", "quick-04@social-media"] },
      long: { workersMax: 2, seats: ["long-01@social-media", "long-02@social-media"] },
    },
  });
  assert.equal(seatNames("t", "c", 12).at(-1), "c-12@t");
});

test("render writes fleet.json and each seat's Pi files from the team's class, under a fresh --out only", () => {
  const teams = loadTeams(teamsDir("social-media"), platform("social-media"));
  const out = fresh();
  const files = renderFleet(teams, out, GOVERNOR, env);
  assert.equal(files.length, 4 * 2 + 2 * 3 + 1, "trimmed long seats also get SYSTEM.md");
  assert.deepEqual(JSON.parse(readFileSync(join(out, "social-media", "fleet.json"), "utf8")), fleetFor(teams.get("social-media")!));
  const models = JSON.parse(readFileSync(join(out, "social-media", "state", "pi", "long-02@social-media", "agent", "models.json"), "utf8"));
  const [model] = models.providers.plantworks.models;
  assert.deepEqual([models.providers.plantworks.baseUrl, model.contextWindow, model.maxTokens], [GOVERNOR, 32768, 1024], "the spec class, not the built-in one");
  // The class's toolProfile reaches the seat files: trimmed long seats, default quick seats.
  const agent = (seat: string) => join(out, "social-media", "state", "pi", seat, "agent");
  assert.deepEqual(JSON.parse(readFileSync(join(agent("long-01@social-media"), "settings.json"), "utf8")).defaultTools, TRIMMED_TOOLS);
  assert.equal(readFileSync(join(agent("long-01@social-media"), "SYSTEM.md"), "utf8"), TRIMMED_SYSTEM_MD);
  assert.equal(JSON.parse(readFileSync(join(agent("quick-01@social-media"), "settings.json"), "utf8")).defaultTools, undefined);
  assert.equal(existsSync(join(agent("quick-01@social-media"), "SYSTEM.md")), false);
  assert.deepEqual(readdirSync(join(out, "social-media", "state", "pi")).sort(), [...fleetFor(teams.get("social-media")!).classes.long.seats, ...fleetFor(teams.get("social-media")!).classes.quick.seats].sort());

  // An existing team directory, with a user's file in it, is refused and left exactly as it was.
  const user = join(out, "social-media", "notes.txt");
  writeFileSync(user, "mine");
  assert.throws(() => renderFleet(teams, out, GOVERNOR, env), /already exists; render into a fresh --out/);
  assert.equal(readFileSync(user, "utf8"), "mine");
});

test("render refuses a live home, inside or exactly, and a bad governor URL, before writing anything", () => {
  const teams = loadTeams(teamsDir("social-media"), platform("social-media"));
  const home = mkdtempSync(join(tmpdir(), "pw-render-home-"));
  for (const out of [home, join(home, "fleet"), join(home, "a", "..", "b")]) {
    assert.throws(() => renderFleet(teams, out, GOVERNOR, { OPENRIG_HOME: home }), /inside the live home/, out);
  }
  assert.deepEqual(readdirSync(home), [], "nothing written into the home");
  // A live home at a custom path is known from OPENRIG_DB even when OPENRIG_HOME is unset.
  assert.throws(() => renderFleet(teams, join(home, "x"), GOVERNOR, { OPENRIG_DB: join(home, "openrig.sqlite") }), /inside the live home/);
  // A dangling symlink planted as the team dir is refused by name, not written through.
  const planted = fresh();
  mkdirSync(planted);
  symlinkSync(join(home, "nowhere"), join(planted, "social-media"));
  assert.throws(() => renderFleet(teams, planted, GOVERNOR, env), /already exists; render into a fresh --out/);
  assert.deepEqual(readdirSync(home), []);
  const out = fresh();
  assert.throws(() => renderFleet(teams, out, "not a url", env), /--governor-url/);
  assert.equal(existsSync(out), false);
});

test("plantworks pw team render works end to end through the CLI", async () => {
  const bin = fileURLToPath(new URL("../../bin/plantworks.mjs", import.meta.url));
  const dir = teamsDir("social-media");
  const pf = join(mkdtempSync(join(tmpdir(), "pw-render-pf-")), "platform.json");
  writeFileSync(pf, JSON.stringify(platform("social-media")));
  const childEnv = sealedEnv({ OPENRIG_HOME: mkdtempSync(join(tmpdir(), "pw-render-cli-home-")) });
  const run = (args: string[]) => promisify(execFile)(process.execPath, [bin, "pw", "team", "render", ...args], { env: childEnv })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }));
  const out = fresh();
  const ok = await run(["--teams", dir, "--platform", pf, "--out", out, "--governor-url", GOVERNOR]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /social-media\/fleet\.json/);
  const refused = await run(["--teams", dir, "--platform", pf, "--out", join(childEnv.OPENRIG_HOME!, "x"), "--governor-url", GOVERNOR]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /render: refusing to render into .*inside the live home/);
});

test("removing a team's spec: the re-render drops it, and the restarted broker answers its jobs 400 unknown_team", async () => {
  const dir = teamsDir("social-media", "support");
  const pf = platform("social-media", "support");
  const db = join(mkdtempSync(join(tmpdir(), "pw-render-db-")), "broker.sqlite");
  const job = (team: string, card: string) => ({ jobId: `kb-${team}-${card}-a1`, team, task: { prompt: "p" } });
  const boot = () => {
    const store = openStore(db);
    const app = createBroker({ store, teams: loadTeams(dir, pf), send: () => {}, env: { PLANTWORKS_FRONTDOOR_CALLBACK: "http://127.0.0.1:9/cb" }, publicUrl: "http://broker.test" });
    const submit = (body: unknown) => app.request(`${API}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { store, submit };
  };

  const before = fresh();
  renderFleet(loadTeams(dir, pf), before, GOVERNOR, env);
  assert.deepEqual(readdirSync(before).sort(), ["social-media", "support"]);
  let b = boot();
  assert.equal((await b.submit(job("support", "t_1"))).status, 201);
  b.store.close();

  rmSync(join(dir, "support"), { recursive: true });
  const after = fresh();
  renderFleet(loadTeams(dir, pf), after, GOVERNOR, env);
  assert.deepEqual(readdirSync(after), ["social-media"], "the re-render no longer contains the removed team");

  b = boot(); // the broker reads specs at start, so the removal takes effect on restart
  const gone = await b.submit(job("support", "t_2"));
  assert.deepEqual([gone.status, (await gone.json()).error], [400, "unknown_team"]);
  assert.equal((await b.submit(job("social-media", "t_3"))).status, 201, "the remaining team is unaffected");
  b.store.close();
});
