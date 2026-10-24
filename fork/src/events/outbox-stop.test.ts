// SPDX-License-Identifier: Apache-2.0
// The broker's close() stops the job-state outbox promptly, even mid-retry, without recording the
// aborted delivery or touching the store afterwards; the next start replays it with the same id.
// Real broker over HTTP on 127.0.0.1, a disposable SQLite file, no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTeam } from "../team/command.ts";
import { PHASE_0_1 } from "../team/spec.ts";
import { API, loadTeams, startBroker } from "../broker/server.ts";
import { openStore } from "../broker/store.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A callback that answers 503 while `down()` holds, else 204; records every id it sees. */
async function consumer(down: () => boolean) {
  const received: string[] = [];
  let refused = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      received.push(JSON.parse(raw).id);
      if (down()) { refused++; return res.writeHead(503).end(); }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`, received, refused: () => refused,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const cls = { slots: 1, model: "qwen3.5:9b", context: { maxContextTokens: 16384, thinkingTokens: 0 }, perCall: { maxOutputTokens: 1536, deadlineSeconds: 60 }, approval: "never", timeoutSeconds: 900, maxAttempts: 1 };
const definition = {
  team: "social-media", trains: 1, perTrain: { orchestrators: 1, workers: { quick: 1 } },
  endpoint: { url: "${PLANTWORKS_LLM_URL}", slotBudgetKey: "social-media" }, defaultClass: "quick", classes: { quick: cls },
  events: { callbackDefault: "${SOCIAL_MEDIA_CALLBACK}", approvalConsumer: "frontdoor" },
};
const platform = { ...PHASE_0_1, slotCaps: { "social-media": 1 } };
const JOB = "kb-social-media-t_stop0001-a1";

async function until(what: string, ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("close() during a delivery's backoff resolves promptly, records nothing, and the restart replays the same id", async () => {
  let down = true;
  const fd = await consumer(() => down);
  const dir = mkdtempSync(join(tmpdir(), "pw-stop-teams-"));
  assert.ok("files" in emitTeam(definition, dir, platform));
  const db = join(mkdtempSync(join(tmpdir(), "pw-stop-db-")), "broker.sqlite");
  const env = { SOCIAL_MEDIA_CALLBACK: fd.url };
  const logs: string[] = [];
  try {
    let store = openStore(db);
    let broker = await startBroker({ store, teams: loadTeams(dir, platform), env, host: "127.0.0.1", port: 0, log: (l) => logs.push(l) });
    const res = await fetch(`${broker.url}${API}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: JOB, team: "social-media", task: { prompt: "p" } }) });
    assert.equal(res.status, 201);
    await until("the first refused delivery", () => fd.refused() >= 1);
    const firstId = fd.received[0]!;

    // The emitter is now sleeping before its next attempt (0.5 s doubling, up to ~60 s in all).
    const started = Date.now();
    await broker.close();
    const took = Date.now() - started;
    const refusedAtClose = fd.refused();
    assert.ok(took < 2000, `close() took ${took} ms with a delivery mid-backoff`);
    // The aborted delivery left no trace: no failure row and no cursor advance.
    assert.deepEqual(store.db.prepare("SELECT COUNT(*) AS n FROM event_outbox_failures").get(), { n: 0 });
    assert.deepEqual(store.db.prepare("SELECT delivered_through FROM event_outbox_team_cursor WHERE team = 'social-media'").get(), { delivered_through: 0 });
    store.close();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fd.refused(), refusedAtClose, "the stopped broker made no further attempts");
    assert.deepEqual(logs.filter((l) => /pump failed/.test(l)), [], "nothing ran against the closed store");

    down = false;
    store = openStore(db);
    broker = await startBroker({ store, teams: loadTeams(dir, platform), env, host: "127.0.0.1", port: 0, log: (l) => logs.push(l) });
    const before = fd.received.length;
    await until("the replay", () => fd.received.length > before);
    assert.equal(fd.received[before], firstId, "the replay keeps the id the aborted delivery had");
    await broker.close();
    store.close();
  } finally {
    await fd.close();
  }
});
