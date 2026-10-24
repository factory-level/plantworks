// SPDX-License-Identifier: Apache-2.0
// plantworks.job.state events: CloudEvents 1.0 (structured JSON) posted to the team's callback,
// at least once. The event id is `<jobId>:<state>`, so a consumer deduplicates on it.
import { parseJobId, type JobState, type TransitionDetail } from "../contract/job.ts";

export const JOB_STATE_EVENT = "plantworks.job.state";

export interface JobStateEvent {
  specversion: "1.0";
  type: typeof JOB_STATE_EVENT;
  source: string;
  id: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  data: { jobId: string; team: string; attempt: number; state: JobState } & TransitionDetail;
}

export function jobStateEvent(
  job: { jobId: string; team: string },
  state: JobState,
  detail: TransitionDetail = {},
  now: Date = new Date(),
): JobStateEvent {
  const parsed = parseJobId(job.jobId);
  if (!parsed) throw new Error(`invalid jobId ${job.jobId}`);
  return {
    specversion: "1.0",
    type: JOB_STATE_EVENT,
    source: `/plantworks/teams/${job.team}`,
    id: `${job.jobId}:${state}`,
    subject: job.jobId,
    time: now.toISOString(),
    datacontenttype: "application/json",
    data: { jobId: job.jobId, team: job.team, attempt: parsed.attempt, state, ...detail },
  };
}

export interface EmitterOptions {
  /** The team spec's events.callbackDefault. Operator config, never taken from an envelope. */
  url: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown when an event cannot be delivered: a permanent 4xx, or retries ran out. */
export class DeliveryError extends Error {
  readonly event: JobStateEvent;
  readonly attempts: number;
  constructor(message: string, event: JobStateEvent, attempts: number) {
    super(message);
    this.event = event;
    this.attempts = attempts;
  }
}

const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * Posts events one at a time, in the order emit() was called, retrying with capped exponential
 * backoff. emit() resolves once the consumer answers 2xx.
 */
// ponytail: retries live in memory, so a crashed process loses undelivered events. The broker's
// persistent outbox replaces this; until then, re-emit from the job's recorded state.
export function createEmitter(opts: EmitterOptions) {
  if (!/^https?:\/\//.test(opts.url) || !URL.canParse(opts.url)) throw new Error("callback url must be http(s)");
  const {
    url, maxAttempts = 8, baseDelayMs = 500, maxDelayMs = 30_000, requestTimeoutMs = 10_000,
    fetch: doFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  let tail: Promise<unknown> = Promise.resolve();

  async function deliver(event: JobStateEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let why: string;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/cloudevents+json" },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        await res.body?.cancel();
        if (res.ok) return;
        why = `HTTP ${res.status}`;
        if (!retryable(res.status)) throw new DeliveryError(`${event.id}: ${why}, not retried`, event, attempt);
      } catch (err) {
        if (err instanceof DeliveryError) throw err;
        why = (err as Error).message;
      }
      if (attempt >= maxAttempts) throw new DeliveryError(`${event.id}: ${why} after ${attempt} attempts`, event, attempt);
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  return {
    emit(event: JobStateEvent): Promise<void> {
      const run = tail.then(() => deliver(event));
      tail = run.catch(() => {});
      return run;
    },
  };
}
