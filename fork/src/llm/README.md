<!-- SPDX-License-Identifier: Apache-2.0 -->
# LLM endpoint, classes and the per-call governor (PW-11)

- `endpoint.ts` reads `PLANTWORKS_LLM_URL` and `PLANTWORKS_LLM_API_KEY`, and implements
  `pw llm preflight` (`GET /models`).
- `classes.ts` holds the worker classes and the per-call ceilings.
- `governor.ts` is the per-seat proxy that every Pi call goes through.

## Who retries what

There are two retry layers, and each status is retried by exactly one of them.

| Endpoint answers | Governor | Pi 1.4.0 |
|---|---|---|
| `503` (queue full) | Waits it out with backoff (1 s doubling to 30 s). It is not an attempt, and it is **never shown to Pi** | Sees nothing, because the call is still open |
| The per-call deadline passes | Aborts the call and answers Pi `504`. It counts a deadline; 3 in a row fail the job as `call-deadline` | **Retries the call 3 times**, after 2 s, 4 s and 8 s. Each retry is a new governor call, so it counts toward the 3 deadlines |
| Any other status (for example `500`) | Passes it through unchanged and doesn't retry | **Retries 3 times**, after 2 s, 4 s and 8 s, then the turn fails |

So a busy endpoint costs Pi one call however long the queue lasts, and a 503 can't be retried
twice.

**Consequence: one stuck logical call can fail the job on its own.** Pi retries the governor's
deadline `504` 3 times, and every retry is a new governor call that can also hit the deadline. So
with an endpoint that never answers within `deadlineSeconds`, the sequence is:

1. Pi's first call hits the deadline: count 1.
2. Pi's first retry, 2 s later, hits it again: count 2.
3. Pi's second retry, 4 s later, hits it again: count 3, and the governor fails the job as
   `call-deadline`.

Pi's third retry never runs. With the quick class, that takes about 3 × 60 s + 6 s. In effect,
the 3-consecutive rule counts Pi's retries of one prompt, not 3 distinct prompts. Each of the 3
calls did miss the deadline. Whether that is the intended reading of PW-11 is a product decision.
The gated test "real Pi: one stuck call exhausts the 3-consecutive deadline rule…" runs this
chain end to end with real Pi and a 2 s class deadline. It observed 3 calls, with gaps of about
4.0 s and 6.0 s (deadline plus Pi's 2 s, then 4 s backoff), ending `failed`/`call-deadline`.

"The call is retried after backoff" (PW-11) is Pi's retry. The governor only counts deadlines and
stops the job at 3 in a row.

**Where Pi's behaviour comes from.** These are Pi 1.4.0's own defaults, the platform pin in
`fork/container/Dockerfile`:
- `@earendil-works/pi-coding-agent` `dist/core/settings-defaults.js:17-21` sets `retry: {enabled:
  true, maxRetries: 3, baseDelayMs: 2000}`;
- `@earendil-works/pi-ai` `dist/api/openai-completions.js:195-198` calls the SDK with
  `maxRetries: 0` and leaves provider-level retry to `retryProviderRequest`;
- that retries `408/409/429/5xx` only when a provider `maxRetries` is set, and the seat files
  set none.

The seat files the fork renders don't set `retry`, so these defaults apply.

**Observed.** The gated real-Pi tests in `fork/src/job/run-503.test.ts` ran with
`PLANTWORKS_PI_BIN` set to Pi 1.4.0's `dist/bundle/cli.js`. They used a stub endpoint on
127.0.0.1, behind the real governor, in a sealed environment with no shared inference:
- a `500`, and a `504`, each gave **4 calls** (1 plus 3 retries), with gaps of about 2.0 s,
  4.0 s and 8.0 s;
- `503, 503, 200` gave 3 endpoint posts but **1 Pi call**, and the job finished `done`.

CI skips these tests because it has no Pi. The ungated tests in the same file cover the
governor side with the fork's fake Pi:
- a busy period ends in `done` with no attempt counted;
- an endpoint that stays busy ends the job at `timeoutSeconds` as `failed`/`timeout`, never
  `call-deadline`.

A Pi upgrade can change these defaults. Re-run the gated tests against the new pin.

## Per-job priority (PW-29)

**Decision.** The seat's governor sets each request's `priority` to the effective priority of the
job the seat runs now. That value is the class `priority` plus the envelope's offset, the same
number the broker orders claims by. The card offered two options, and this rules out both:
- re-rendering the seat's `models.json` before each job, which would race a running Pi;
- one seat per priority band.

Nothing about the seat changes per job. The decision is cheap to change: it is one setter on the
governor and one line in `governBody`.

- **Why it reaches the endpoint as `priority`:**
  - Pi 1.4.0 sends a model's `compat.vllmPriority` as the body field `priority`
    (`pi-ai` `dist/api/openai-completions.js:620-621`). The governor replaces that value, and the
    seat files set none.
  - vLLM reads `priority` as an integer where lower means earlier handling, with ties by arrival.
    That is the broker's direction too: urgent is -3 and low is +2.
- **Opt-in: `PLANTWORKS_LLM_PRIORITY=1`.** vLLM rejects a non-zero `priority` unless it runs with
  `--scheduling-policy priority`. So by default no `priority` is sent at all, and on **Ollama**,
  which has no priority scheduling, this is a **no-op**: leave it unset.
- **One job at a time per governor.** A worker's claim loop waits for each job to be `done` before
  it claims the next (`fork/src/broker/worker.ts`, `waitForDone`). So a per-seat value is per job.
- **No call goes out before the job's priority is known.** claim-next creates the qitem, and the
  daemon can wake Pi then, before the worker has the claim response. So with hints on, the
  governor **holds** every completion call while no priority is set. The worker sets the value
  before it waits on any job, and clears it again when the job is `done`:
  - a claimed job gets class base + envelope offset;
  - a job held after a restart, or one whose handoff is unconfirmed, gets the class base, because
    its envelope isn't at hand.
- **`pw job run`** passes the envelope offset at governor start; built-in classes have no base.
- **Tests:**
  - `priority.test.ts` covers the default off, setting and overriding Pi's value, switching
    between jobs, and `pw job run`;
  - `fork/src/broker/worker-priority.test.ts` covers the worker path:
    - a call made while the claim answer is still held back waits, then carries base 2 + urgent,
      which is -1;
    - the next job gives base 2 + low, which is 4;
    - nothing goes out between jobs.

  None of them load a real vLLM; that check is gated.
- The envelope `priority` field is fork-defined and still pending the HarnessHG ack (D11).
