// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePiModelsJson } from "../../../packages/daemon/dist/adapters/pi-readiness.js";
import { piSeatPinReadings } from "../../../packages/daemon/dist/domain/model-divergence/effective-model-readers.js";
import { CLASSES } from "../llm/classes.ts";
import { PLACEHOLDER_KEY, PROVIDER, seatAgentDir, writeSeatFiles } from "./pi-seat-files.ts";

const home = () => mkdtempSync(join(tmpdir(), "pw-seat-"));
const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("writes models.json and settings.json under $OPENRIG_HOME/state/pi/<session>/agent, per class", () => {
  for (const [className, c] of Object.entries(CLASSES)) {
    const h = home();
    const dir = writeSeatFiles({ openrigHome: h, session: "dev-worker@team", className, governorUrl: "http://127.0.0.1:4100" });
    assert.equal(dir, join(h, "state", "pi", "dev-worker@team", "agent"));
    assert.deepEqual(readdirSync(dir).sort(), ["models.json", "settings.json"], "no temp files left behind");
    const provider = read(dir, "models.json").providers[PROVIDER];
    assert.equal(provider.baseUrl, "http://127.0.0.1:4100", "Pi only ever sees the governor");
    assert.equal(provider.apiKey, PLACEHOLDER_KEY, "the real key is never written to seat files");
    assert.deepEqual(provider.models.map((m: Record<string, unknown>) => [m.id, m.contextWindow, m.maxTokens, m.reasoning]), [[c.model, c.maxContextTokens, c.maxOutputTokens, false]]);
    assert.deepEqual(read(dir, "settings.json"), { defaultProvider: PROVIDER, defaultModel: c.model, defaultThinkingLevel: "off" });
  }
  assert.equal(CLASSES.quick.maxContextTokens, 16384, "the default class is 16K");
});

test("rewriting a seat replaces its files, and unsafe session names or classes are refused", () => {
  const h = home();
  writeSeatFiles({ openrigHome: h, session: "s1", className: "long", governorUrl: "http://127.0.0.1:1" });
  const dir = writeSeatFiles({ openrigHome: h, session: "s1", className: "quick", governorUrl: "http://127.0.0.1:2" });
  assert.equal(read(dir, "models.json").providers[PROVIDER].models[0].contextWindow, 16384);
  for (const bad of ["../x", "a/b", "", ".hidden", "a..b"]) assert.throws(() => seatAgentDir(h, bad), /unsafe session name/);
  assert.throws(() => writeSeatFiles({ openrigHome: h, session: "s2", className: "huge", governorUrl: "http://127.0.0.1:1" }), /unknown worker class/);
});

test("every rendered field is one the pinned Pi 1.4.0 schemas declare, with the declared type", () => {
  const schema = (n: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/pi-1.4.0/${n}.schema.json`, import.meta.url), "utf8"));
  const models = schema("models");
  const settings = schema("settings");
  const provider = models.properties.providers.patternProperties["^.*$"].properties;
  const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : typeof v);
  const check = (where: string, value: Record<string, unknown>, declared: Record<string, { type?: string }>) => {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(Object.hasOwn(declared, k), `${where}.${k} is not a Pi 1.4.0 field`);
      if (typeof declared[k].type === "string") assert.equal(typeOf(v), declared[k].type, `${where}.${k}`);
    }
  };
  for (const className of Object.keys(CLASSES)) {
    const dir = writeSeatFiles({ openrigHome: home(), session: "s", className, governorUrl: "http://127.0.0.1:1" });
    const m = read(dir, "models.json");
    const s = read(dir, "settings.json");
    check("models", m, models.properties);
    check(`providers.${PROVIDER}`, m.providers[PROVIDER], provider);
    check("models[0]", m.providers[PROVIDER].models[0], provider.models.items.properties);
    check("settings", s, settings.properties);
    assert.ok(settings.$defs.ModelThinkingLevel.enum.includes(s.defaultThinkingLevel));
  }
});

test("the upstream daemon reads the rendered models.json as Pi's model config", () => {
  const dir = writeSeatFiles({ openrigHome: home(), session: "s", className: "quick", governorUrl: "http://127.0.0.1:1" });
  const config = parsePiModelsJson(readFileSync(join(dir, "models.json"), "utf8"));
  assert.equal(config.providers[PROVIDER].models[0].id, CLASSES.quick.model);
  // A pin with a thinking-level-like suffix makes the daemon consult this file; a parse failure would return ok: false.
  assert.equal(piSeatPinReadings(`${PROVIDER}/${CLASSES.quick.model}:off`, dir).ok, true);
});
