// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPendingRunnerState } from "../../../packages/daemon/dist/adapters/pi-runner-protocol.js";
import { seatLiveness } from "./liveness.ts";

test("seat liveness follows the runner's own sidecar: only a recorded Pi exit is dead", () => {
  const home = mkdtempSync(join(tmpdir(), "pw-live-"));
  const seat = "worker-0@t";
  const dir = join(home, "state", "pi", seat);
  const write = (state: unknown) => writeFileSync(join(dir, "runner-state.json"), typeof state === "string" ? state : JSON.stringify(state));
  assert.equal(seatLiveness(home, seat).verdict, "starting", "no sidecar: not launched yet");
  mkdirSync(dir, { recursive: true });
  // What upstream's adapter writes before it types the launch command.
  write(buildPendingRunnerState("launch-1", "2026-10-24T00:00:00.000Z", null));
  assert.equal(seatLiveness(home, seat).verdict, "starting");
  write({ ready: true, launchId: "launch-1", updatedAt: "2026-10-24T00:00:05.000Z" });
  assert.deepEqual(seatLiveness(home, seat), { verdict: "live", detail: "ready, launch launch-1 (updated 2026-10-24T00:00:05.000Z)" });
  write({ ready: false, launchId: "launch-1", updatedAt: "2026-10-24T00:01:00.000Z", exited: { code: 1, at: "2026-10-24T00:01:00.000Z" } });
  assert.deepEqual(seatLiveness(home, seat), { verdict: "exited", detail: "Pi exited (code 1) at 2026-10-24T00:01:00.000Z" });
  write('{"ready": tr');
  assert.equal(seatLiveness(home, seat).verdict, "unknown", "a torn write is not a death");
  assert.throws(() => seatLiveness(home, "../escape"), /unsafe session name/);
});
