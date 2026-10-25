// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createDb } from "../../../packages/daemon/dist/db/connection.js";
import { ALL_MIGRATIONS } from "../../../packages/daemon/dist/db/all-migrations.js";
import { migrate } from "../../../packages/daemon/dist/db/migrate.js";
import { EventBus } from "../../../packages/daemon/dist/domain/event-bus.js";
import { QueueRepository } from "../../../packages/daemon/dist/domain/queue-repository.js";
import { InboxHandler } from "../../../packages/daemon/dist/domain/inbox-handler.js";
import { OutboxHandler } from "../../../packages/daemon/dist/domain/outbox-handler.js";
import { queueRoutes } from "../../../packages/daemon/dist/routes/queue.js";

test("queue create/claim/unclaim wire contract (upstream packages/daemon/src/routes/queue.ts:545-658; require-sender-identity.ts:78-107)", async (t) => {
  const db = createDb();
  t.after(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  const events = new EventBus(db);
  const queue = new QueueRepository(db, events);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("eventBus", events);
    c.set("queueRepo", queue);
    c.set("inboxHandler", new InboxHandler(db, events, queue));
    c.set("outboxHandler", new OutboxHandler(db));
    await next();
  });
  app.route("/api/queue", queueRoutes());

  const createBody = {
    qitemId: "contract-qitem-1",
    sourceSession: "sender@rig",
    destinationSession: "worker@rig",
    body: "contract test",
    priority: "normal",
    nudge: false,
  };
  const create = await app.request("/api/queue/create", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.sourceSession, "sender@rig");
  assert.equal(created.destinationSession, "worker@rig");
  assert.equal(created.body, "contract test");
  assert.equal(created.priority, "normal");
  assert.equal(created.state, "pending");
  assert.equal(queue.transitionLog.listForQitem(created.qitemId).at(-1).identityProvenance, "claimed:v1");
  assert.equal(typeof created.qitemId, "string");

  const replay = await app.request("/api/queue/create", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody),
  });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).qitemId, created.qitemId, "a retry with the same identity returns the existing item");
  assert.equal(queue.transitionLog.listForQitem(created.qitemId).length, 1, "an absorbed retry creates no second queue item");

  const reusedId = await app.request("/api/queue/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...createBody, destinationSession: "other@rig" }),
  });
  assert.equal(reusedId.status, 409);
  assert.equal((await reusedId.json()).error, "qitem_id_reuse");

  const missingCreateIdentity = await app.request("/api/queue/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ destinationSession: "worker@rig", body: "no actor", nudge: false }),
  });
  assert.equal(missingCreateIdentity.status, 400);
  assert.equal((await missingCreateIdentity.json()).error, "actor_required");

  const claim = await app.request(`/api/queue/${created.qitemId}/claim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ destinationSession: "worker@rig" }),
  });
  assert.equal(claim.status, 200);
  const claimed = await claim.json();
  assert.equal(claimed.qitemId, created.qitemId);
  assert.equal(claimed.sourceSession, "sender@rig");
  assert.equal(claimed.destinationSession, "worker@rig");
  assert.equal(claimed.body, "contract test");
  assert.equal(claimed.state, "in-progress");
  assert.equal(queue.transitionLog.listForQitem(created.qitemId).at(-1).actorSession, "worker@rig");
  assert.equal(queue.transitionLog.listForQitem(created.qitemId).at(-1).identityProvenance, "claimed:v1");

  const missingClaimIdentity = await app.request(`/api/queue/${created.qitemId}/claim`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(missingClaimIdentity.status, 400);
  assert.equal((await missingClaimIdentity.json()).error, "actor_required");

  const unclaim = await app.request(`/api/queue/${created.qitemId}/unclaim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ destinationSession: "worker@rig", reason: "manual" }),
  });
  assert.equal(unclaim.status, 200);
  const unclaimed = await unclaim.json();
  assert.equal(unclaimed.qitemId, created.qitemId);
  assert.equal(unclaimed.sourceSession, "sender@rig");
  assert.equal(unclaimed.destinationSession, "worker@rig");
  assert.equal(unclaimed.body, "contract test");
  assert.equal(unclaimed.state, "pending");
  assert.equal(queue.transitionLog.listForQitem(created.qitemId).at(-1).identityProvenance, "claimed:v1");

  const missingUnclaimIdentity = await app.request(`/api/queue/${created.qitemId}/unclaim`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(missingUnclaimIdentity.status, 400);
  assert.equal((await missingUnclaimIdentity.json()).error, "actor_required");

  const transportCreate = await app.request("/api/queue/create", {
    method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "wire@rig" },
    body: JSON.stringify({ ...createBody, qitemId: "contract-transport-qitem", sourceSession: "body@rig" }),
  });
  assert.equal(transportCreate.status, 201);
  const transported = await transportCreate.json();
  assert.equal(transported.sourceSession, "wire@rig");
  assert.equal(queue.transitionLog.listForQitem(transported.qitemId).at(-1).identityProvenance, "transport:v1");
});
