// SPDX-License-Identifier: Apache-2.0
// plantworks.job.state events: CloudEvents 1.0 (structured JSON) posted to the team's callback.
// Delivery is at least once within a retry budget (see README.md); the event id is
// `<jobId>:<state>`, so a consumer deduplicates on it.
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

/** Any Plantworks CloudEvent the emitter can carry: plantworks.job.state, or plantworks.approval.* (PW-23). */
export type CloudEvent = Omit<JobStateEvent, "type" | "data"> & { type: string; data: Record<string, unknown> };

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
  /**
   * Called for every event that could not be delivered, whether or not the caller awaits emit().
   * The event is then the caller's to record and re-emit. Defaults to logging to stderr.
   */
  onDeliveryError?: (err: DeliveryError) => void;
}

/** An event that could not be delivered: a permanent 3xx/4xx, or the retry budget ran out. */
export class DeliveryError extends Error {
  readonly event: CloudEvent;
  readonly attempts: number;
  constructor(message: string, event: CloudEvent, attempts: number) {
    super(message);
    this.event = event;
    this.attempts = attempts;
  }
}

const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/** Retry-After in ms (seconds or HTTP date), or undefined when absent or unparseable. */
function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Posts events one at a time, in the order emit() was called, retrying with capped exponential
 * backoff (or the consumer's Retry-After, capped the same way). emit() resolves once the consumer
 * answers 2xx and rejects with a DeliveryError otherwise; onDeliveryError sees every failure too.
 * Redirects are not followed: a 3xx is a permanent failure, so a consumer cannot bounce the
 * POST to another address.
 */
// ponytail: retries live in memory and the queue is unbounded, so a crashed process loses
// undelivered events and a long outage queues every emit() behind the first. Fine for Phase 0-1
// (one job in flight); the broker's persistent outbox replaces this.
export function createEmitter(opts: EmitterOptions) {
  if (!/^https?:\/\//.test(opts.url) || !URL.canParse(opts.url)) throw new Error("callback url must be http(s)");
  const {
    url, maxAttempts = 8, baseDelayMs = 500, maxDelayMs = 30_000, requestTimeoutMs = 10_000,
    fetch: doFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onDeliveryError = (err) => console.error(`plantworks.job.state not delivered: ${err.message}`),
  } = opts;
  let tail: Promise<unknown> = Promise.resolve();

  async function deliver(event: CloudEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let why: string;
      let wait: number | undefined;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/cloudevents+json" },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(requestTimeoutMs),
          redirect: "manual",
        });
        await res.body?.cancel();
        if (res.ok) return;
        why = `HTTP ${res.status}`;
        if (!retryable(res.status)) throw new DeliveryError(`${event.id}: ${why}, not retried`, event, attempt);
        wait = retryAfterMs(res.headers.get("retry-after"));
      } catch (err) {
        if (err instanceof DeliveryError) throw err;
        why = (err as Error).message;
      }
      if (attempt >= maxAttempts) throw new DeliveryError(`${event.id}: ${why} after ${attempt} attempts`, event, attempt);
      await sleep(Math.min(maxDelayMs, wait ?? baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  return {
    emit(event: CloudEvent): Promise<void> {
      const run = tail.then(() => deliver(event));
      tail = run.catch((err: DeliveryError) => {
        try { onDeliveryError(err); } catch { /* a failing hook must not stall later events */ }
      });
      return run;
    },
  };
}
