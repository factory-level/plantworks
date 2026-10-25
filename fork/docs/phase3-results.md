<!-- SPDX-License-Identifier: Apache-2.0 -->
# Phase 3 results: trains scale-out (PW-33)

PW-33 shows that adding trains raises the ceiling on seats, not the load on the GPU. Idle seats cost close to nothing, the number of jobs in flight stays at the platform cap, and draining a seat is safe while the platform scales.

This page records the **local simulation**. The factory-server proof (GitOps-only scale-out, worker Deployment counts and the stats log on k8s) is **gated** and has not been run.

## What ran

The test is `fork/src/broker/trains.test.ts`, run with `node --test`. It is sealed: every child environment is built from scratch, in temp homes, with sentinel `OPENRIG_URL`/`OPENRIG_DB` values asserted untouched. It never uses the live daemon, its database or port 7433.

| Part | In the simulation |
|---|---|
| Team | One team `t`, class `long` with `slots: 2` and `perTrain.workers.long: 2`, emitted with `emitTeam` |
| Slot cap | `PLANTWORKS_SLOT_CAP` fixed at `t=2`. The same value is in the platform file the spec is validated against |
| Broker | In process (`startBroker` + `claimNextRoutes` + `runtimeRoutes`) on its own SQLite file. A fake daemon queue records each handoff |
| Seats | Each one is a real `plantworks pw worker run` process with its own governor on 127.0.0.1 |
| Pi | A stand-in: for each claimed job it moves the job to `running`, makes one chat completion through the claiming seat's governor, and marks it `done` |
| Endpoint | A loopback OpenAI-compatible stub. Each call is held for 60 ms and its peak concurrency is recorded |
| Scaler input | `GET /plantworks/v1/stats`, sampled every 15 ms for the whole run |

The sequence:
1. Emit `trains: 1`, which gives 2 seats. Submit 20 jobs and start both workers.
2. Re-emit the same definition with `trains: 3`, and start the 4 new seats. That makes 6.
3. Hold one running job and drain its seat with `pw worker drain`. Release the job, and check that the drain then exits 0.
4. Submit the last 10 jobs while the drained worker is still polling. Keep it up for 1.5 s more, then stop it, as a pod's preStop would.
5. Let the queue empty. Wait 1.5 s with 5 seats still polling, then stop them.

## Results

From one run (Node 22.22, 9.8 s):

```
samples=512 maxInFlight=2 cap=2 peakEndpointCalls=2 calls=30 handoffs=30 seatsUsed=6/6 drained=long-01@t heldJob=kb-t-card05-a1
```

| Card criterion | Local result | Status |
|---|---|---|
| `6adc1a7c`: trains 1 → 3 only by editing the definition and re-emitting it | Re-emitting changes `workers.max` from 2 to 6 (`fleetFor`) and the Hermes profile's `max_in_progress_per_profile` from 1 to 3. Class `slots` stays at 2. Nothing is edited by hand | **Render half only.** The GitOps re-emit is gated |
| `6adc1aaa`: with 30 queued jobs, in flight never exceeds the team cap | In all 512 stats samples `slots.t.inFlight` ≤ 2, and the cap was reached. The endpoint never saw more than 2 calls at once | Met locally |
| `6adc1aab`: empty queues let the platform scale workers to 0 | With the queue empty and 5 seats polling, the stats show `active: 0` and `slots.t.inFlight: 0`. No model calls were made in 1.5 s, and the stopped workers left nothing held | Met locally, as the stats signal. The scaler belongs to harness-hg, and the factory-server run is gated |
| `6adc1aac`: drain a `long` worker mid-job: drained or recovered, never duplicated | The drain waits for the held job (it is still running after 600 ms) and exits 0 once that job is `done`. The drained seat is handed none of the 10 jobs submitted afterwards. All 30 jobs have exactly one handoff, one run and one model call | Met locally |
| `6adc1aad`: results in `fork/docs/phase3-results.md` | This page | Met |
| `6adcd345`: proof on factory-server | Not run | **Gated** |

**Mutation checks.** These show the assertions would catch a regression:
- With the broker's cap and class-slot checks removed (`claim.ts`), the test fails with `in flight never above 2: max 3`.
- With the draining-seat check removed, it fails with `a draining seat is handed no new job`.

## Limits of the simulation

- **The Pi seat is a stand-in.** Jobs move to `running` and `done` directly in the broker store, not through the daemon's qitem closure and reconciliation. Restart and reconciliation safety is covered separately by `drain-restart.test.ts` (#69) and `recovery.test.ts`.
- **The broker keeps the team spec it loaded at start.** A scale-out changes only `trains`, which the broker doesn't use: it counts by slot budget key and class `slots`, and both are unchanged. A real rollout would also restart or reload the broker.
- **Scaling to 0 is shown as the signal only.** The test stops the workers itself. Nothing here runs KEDA or the harness-hg scaler.
- **One host stands in for the platform:** loopback HTTP, no latency model, and no remote seats. PW-32's seat agents aren't needed, because workers reach the broker only over HTTP.
- **The endpoint is a stub.** No inference load was put on any shared endpoint.
