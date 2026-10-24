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

test("worker run resumes only its own seat at start, and a failed resume does not stop the loop", async (t) => {
  const seen: string[] = [];
  let claims = 0;
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === "DELETE") { res.writeHead(500).end("broker hiccup"); return; }
    if (req.url === "/plantworks/v1/claim-next") { claims++; res.writeHead(204).end(); return; }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const oldArgv = process.argv;
  const oldUrl = process.env.PLANTWORKS_BROKER_URL;
  const oldWrite = process.stderr.write;
  const errors: string[] = [];
  process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.env.PLANTWORKS_BROKER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.argv = ["node", "plantworks", "worker", "run", "--team", "t", "--seat", "worker-0@team", "--poll-ms", "250"];
  t.after(() => {
    process.argv = oldArgv;
    process.stderr.write = oldWrite;
    if (oldUrl === undefined) delete process.env.PLANTWORKS_BROKER_URL;
    else process.env.PLANTWORKS_BROKER_URL = oldUrl;
  });
  const program = new Command();
  const [{ workerVerb }, { runProgram }] = await Promise.all([import("./worker.ts"), import("../../../packages/cli/dist/index.js")]);
  workerVerb(program);
  const running = runProgram(program, process.argv);
  while (claims < 1) await new Promise((r) => setTimeout(r, 10));
  process.emit("SIGTERM" as NodeJS.Signals);
  await running;
  assert.deepEqual(seen.filter((s) => s.startsWith("DELETE")), ["DELETE /plantworks/v1/seats/worker-0%40team/drain"], "exactly its own seat, once");
  assert.ok(seen.indexOf("POST /plantworks/v1/claim-next") > seen.indexOf("DELETE /plantworks/v1/seats/worker-0%40team/drain"), "the resume comes before the first claim");
  assert.match(errors.join(""), /could not resume worker-0@team \(500\)/);
});
