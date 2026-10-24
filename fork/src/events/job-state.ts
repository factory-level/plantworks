// SPDX-License-Identifier: Apache-2.0
// plantworks.job.state events: CloudEvents 1.0 (structured JSON) posted to the team's callback.
// Delivery is at least once within a retry budget (see README.md); broker event ids use
// `<jobId>:<persisted-transition-id>` so repeated states remain distinct and replay stable.
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
  data: { jobId: string; team: string; attempt: number; state: JobState; qitemId?: string; seat?: string; summary?: string; artifacts?: { name: string; uri: string }[]; evidence?: { kind: string; uri: string }[]; usage?: { promptTokens: number; completionTokens: number } } & TransitionDetail;
}

/** Any Plantworks CloudEvent the emitter can carry: plantworks.job.state, or plantworks.approval.* (PW-23). */
export type CloudEvent = Omit<JobStateEvent, "type" | "data"> & { type: string; data: Record<string, unknown> };

export function jobStateEvent(
  job: { jobId: string; team: string; transitionSeq?: number; qitemId?: string | null; seat?: string | null; summary?: string; artifacts?: { name: string; uri: string }[]; evidence?: { kind: string; uri: string }[]; usage?: { promptTokens: number; completionTokens: number } },
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
    id: `${job.jobId}:${job.transitionSeq ?? state}`,
    subject: job.jobId,
    time: now.toISOString(),
    datacontenttype: "application/json",
    data: {
      jobId: job.jobId, team: job.team, attempt: parsed.attempt, state,
      ...(job.qitemId ? { qitemId: job.qitemId } : {}),
      ...(job.seat ? { seat: job.seat } : {}),
      ...(job.summary ? { summary: job.summary } : {}),
      ...(job.artifacts ? { artifacts: job.artifacts } : {}),
      ...(job.evidence ? { evidence: job.evidence } : {}),
      ...(job.usage ? { usage: job.usage } : {}),
      ...detail,
    },
  };
}

export interface EmitterOptions {
  /** The team spec's events.callbackDefault. Operator config, never taken from an envelope. */
  url: string;
  /** Optional team-configured callback credential; never derived from a job envelope. */
  bearerToken?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Waits between attempts; it should resolve early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Called for every event that could not be delivered, whether or not the caller awaits emit().
   * The event is then the caller's to record and re-emit. Defaults to logging to stderr.
   */
  onDeliveryError?: (err: DeliveryError) => void;
}

/** emit() was aborted by its caller (a stopping outbox): not a delivery failure, and nothing to record. */
export class DeliveryAborted extends Error {
  readonly event: CloudEvent;
  constructor(event: CloudEvent) {
    super(`${event.id}: delivery aborted`);
    this.name = "AbortError";
    this.event = event;
  }
}

/** An event that could not be delivered: a permanent 3xx/4xx, or the retry budget ran out. */
export class DeliveryError extends Error {
  readonly event: CloudEvent;
  readonly attempts: number;
  readonly permanent: boolean;
  constructor(message: string, event: CloudEvent, attempts: number, permanent = false) {
    super(message);
    this.event = event;
    this.attempts = attempts;
    this.permanent = permanent;
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
    fetch: doFetch = fetch,
    sleep = (ms, signal) => new Promise<void>((r) => {
      const timer = setTimeout(r, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); r(); }, { once: true });
    }),
    onDeliveryError = (err) => console.error(`plantworks.job.state not delivered: ${err.message}`),
  } = opts;
  let tail: Promise<unknown> = Promise.resolve();

  async function deliver(event: CloudEvent, signal?: AbortSignal): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new DeliveryAborted(event);
      let why: string;
      let wait: number | undefined;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/cloudevents+json", ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}) },
          body: JSON.stringify(event),
          signal: signal ? AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), signal]) : AbortSignal.timeout(requestTimeoutMs),
          redirect: "manual",
        });
        await res.body?.cancel();
        if (res.ok) return;
        why = `HTTP ${res.status}`;
        if (!retryable(res.status)) throw new DeliveryError(`${event.id}: ${why}, not retried`, event, attempt, true);
        wait = retryAfterMs(res.headers.get("retry-after"));
      } catch (err) {
        if (err instanceof DeliveryError) throw err;
        if (signal?.aborted) throw new DeliveryAborted(event);
        why = (err as Error).message;
      }
      if (attempt >= maxAttempts) throw new DeliveryError(`${event.id}: ${why} after ${attempt} attempts`, event, attempt);
      await sleep(Math.min(maxDelayMs, wait ?? baseDelayMs * 2 ** (attempt - 1)), signal);
    }
  }

  return {
    /** `signal` aborts the delivery, before or between attempts or mid-request, with DeliveryAborted. */
    emit(event: CloudEvent, o: { signal?: AbortSignal } = {}): Promise<void> {
      // An aborted emit does not wait for earlier, unsignalled work queued on this emitter.
      const signal = o.signal;
      const turn = signal ? Promise.race([tail, new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })))]) : tail;
      const run = turn.then(() => deliver(event, signal));
      tail = run.catch((err: DeliveryError | DeliveryAborted) => {
        if (err instanceof DeliveryAborted) return;
        try { onDeliveryError(err); } catch { /* a failing hook must not stall later events */ }
      });
      return run;
    },
  };
}
