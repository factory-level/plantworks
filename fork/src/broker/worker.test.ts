// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

test("worker waits on an ambiguous reservation until logical completion before claiming again", async (t) => {
  let claims = 0;
  let state = "running";
  const server = createServer((req, res) => {
    if (req.url === "/plantworks/v1/claim-next" && req.method === "POST") {
      claims++;
      if (claims === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "handoff_unconfirmed", jobId: "job-a", qitemId: "qitem-a" }));
      } else {
        res.writeHead(204);
        res.end();
        server.close();
      }
      return;
    }
    if (req.url === "/plantworks/v1/jobs/job-a") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const oldArgv = process.argv;
  const oldBrokerUrl = process.env.PLANTWORKS_BROKER_URL;
  process.env.PLANTWORKS_BROKER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.argv = ["node", "plantworks", "worker", "run", "--team", "t", "--seat", "s", "--poll-ms", "250"];
  t.after(() => {
    process.argv = oldArgv;
    if (oldBrokerUrl === undefined) delete process.env.PLANTWORKS_BROKER_URL;
    else process.env.PLANTWORKS_BROKER_URL = oldBrokerUrl;
  });
  const program = new Command();
  const [{ workerVerb }] = await Promise.all([import("./worker.ts"), import("../../../packages/cli/dist/index.js")]);
  workerVerb(program);
  const running = import("../../../packages/cli/dist/index.js").then(({ runProgram }) => runProgram(program, process.argv));
  t.after(() => { process.emit("SIGTERM" as NodeJS.Signals); });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(claims, 1, "the reservation must prevent another claim while unresolved");
  state = "done";
  await new Promise<void>((resolve) => {
    const check = () => claims === 2 ? resolve() : setTimeout(check, 10);
    check();
  });
  assert.equal(claims, 2, "the worker may resume claiming after broker completion");
  process.emit("SIGTERM" as NodeJS.Signals);
  await running;
});
