import { performance } from "node:perf_hooks";
import { APIError, APIUserAbortError, TypeSafeClient, noul } from "@typesafe-ai/sdk";
import type { Fetch, JsonValue, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type { TurnState } from "./types.ts";

/**
 * The only module that talks to TypeSafe.
 *
 * Everything else in this package consumes typed judgments and never learns that a
 * network exists.
 */

/** Pinned, not `jev-latest`. Aliases move on every release and these thresholds are calibrated. */
export const DEFAULT_MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0";

/**
 * The router sits in front of every turn, so a slow answer is worse than no answer.
 *
 * The SDK ships `timeout: 10_000` per attempt and `maxRetries: 2` with 500 ms backoff —
 * sane for a batch job, and up to ~31 seconds of dead air here. Both are overridden.
 *
 * 600 ms, not the 400 ms this was first built with. `npm run bench` measured a 217 ms
 * bare TCP connect to the API from here, so ~300 ms is a floor nothing in this repo can
 * move: ten times the tokens changes the round trip by nothing (306 tokens took 371 ms,
 * 3,199 took 325 ms). At 400 ms, 29% of turns fell back; at 600 ms it is about 5%, and
 * falling back is expensive — skill accuracy drops from 90.7% to the heuristic's 81.5%,
 * and under-provisioned model tiers go from 7.4% to 31.5%.
 */
export const DEFAULT_DEADLINE_MS = 600;

export class MissingKeyError extends Error {
  constructor() {
    super(
      "TYPESAFE_API_KEY is not set. Export it (never commit it), or run with MOCK=1 for the clearly-labelled offline mode.",
    );
    this.name = "MissingKeyError";
  }
}

export interface JevOptions {
  readonly deadlineMs?: number;
  readonly model?: string;
  /** Injected in tests so the whole router runs offline. */
  readonly fetch?: Fetch;
}

/** Called when an answer lands after the deadline already gave up on it. */
export type LateHandler<Q extends Questions> = (outcome: JevOutcome<Q>) => void;

export interface JevOutcome<Q extends Questions> {
  readonly answers: SystemOneResult<Q>["answers"];
  /** Wall clock around the call itself, measured the same way on every path. */
  readonly jevMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly requestId: string | undefined;
}

/** Why a call did not produce answers. The router maps each of these onto the fallback. */
export type JevFailure = "deadline" | "aborted" | "api" | "network";

export class JevError extends Error {
  constructor(
    readonly failure: JevFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export class Jev {
  private client: TypeSafeClient | null = null;

  constructor(private readonly options: JevOptions = {}) {}

  get deadlineMs(): number {
    return this.options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /** How long an abandoned request is allowed to keep running before the SDK gives up. */
  get backstopMs(): number {
    return Math.max(this.deadlineMs * 8, 10_000);
  }

  private getClient(): TypeSafeClient {
    if (this.client) return this.client;
    if (!process.env.TYPESAFE_API_KEY && !this.options.fetch) throw new MissingKeyError();
    this.client = new TypeSafeClient({
      // Not the deadline. The SDK's timeout aborts the fetch, and aborting destroys the
      // pooled TLS connection — which is exactly the alternating-fallback bug this
      // module is written to avoid. The router's own timer is the contract; this is only
      // a backstop so an abandoned request cannot leak forever.
      timeout: Math.max(this.deadlineMs * 8, 10_000),
      // One shot. A retry costs at least another full deadline, and by then the turn is
      // better served by the heuristic than by a late correct answer.
      retry: { maxRetries: 0 },
      defaultModel: this.options.model ?? DEFAULT_MODEL,
      logLevel: "error",
      ...(this.options.fetch ? { fetch: this.options.fetch, apiKey: "test-key" } : {}),
    });
    return this.client;
  }

  /**
   * Opens the connection before a real turn needs it.
   *
   * Measured from here: a cold call is ~1,150ms, a warm one ~300ms, and a bare TCP
   * connect to the API is 217ms. All of that gap is DNS, TCP and TLS, and the first turn
   * of a session pays it — which is exactly the turn least able to afford it. Call this
   * at harness startup and throw the result away.
   */
  async prewarm(): Promise<boolean> {
    try {
      // Two calls, not one, and this is the whole reason the method exists in this shape.
      //
      // Timing a fresh process against the live API: request 1 takes ~885ms, request 2
      // ~912ms, and only from request 3 does it settle at ~350ms. One warmup left the
      // first routed turn missing a 600ms deadline in four runs out of four. Two does
      // not. Payload size is not the variable — warming with a full-sized body instead
      // of this two-word one changed nothing, also four out of four.
      const warm = { state: "warmup", questions: { warm: noul("Is this a warmup request?") } };
      const options = { timeout: 10_000, retry: { maxRetries: 0 } } as const;
      await this.getClient().systemOne(warm, options);
      await this.getClient().systemOne(warm, options);
      return true;
    } catch {
      // Warming is best-effort. A failure here says nothing about whether routing works.
      return false;
    }
  }

  /**
   * One round trip: one state, every question, evaluated in parallel.
   *
   * Rejects with a `JevError` classifying the failure, so the caller can fall back
   * without having to know the SDK's error hierarchy.
   */
  async ask<const Q extends Questions>(
    state: TurnState,
    questions: Q,
    signal?: AbortSignal,
    onLate?: LateHandler<Q>,
  ): Promise<JevOutcome<Q>> {
    const client = this.getClient();
    // The SDK's state type is JSON; a structural round trip is how the reference
    // projects hand it an arbitrary object.
    const payload = JSON.parse(JSON.stringify(state)) as { [key: string]: JsonValue };

    const started = performance.now();
    /**
     * The deadline does not abort the request. This is deliberate and was measured.
     *
     * Aborting tears down the pooled TLS connection, and re-establishing it costs about
     * as much as the deadline itself — so one slow turn made the next one slow, which
     * aborted, which made the one after that slow. Routes alternated
     * fallback/jev/fallback/jev indefinitely. Letting the abandoned request finish on
     * its own returns the socket to the pool clean, and the answer is not wasted either:
     * `onLate` hands it to the cache, so a re-sent turn is free.
     *
     * The caller's own signal still aborts, because that is a real cancellation rather
     * than a timeout.
     */
    const inflight = client
      .systemOne({ state: payload, questions }, signal ? { signal } : {})
      .withResponse();

    try {
      const { data, requestId } = await Promise.race([
        inflight,
        deadlineRejection(this.deadlineMs),
      ]);
      return {
        answers: data.answers,
        jevMs: performance.now() - started,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        model: data.model,
        requestId,
      };
    } catch (error) {
      const failure = classify(error);
      if (failure.failure === "deadline" && onLate) {
        inflight.then(
          ({ data, requestId }) =>
            onLate({
              answers: data.answers,
              jevMs: performance.now() - started,
              inputTokens: data.usage.input_tokens,
              outputTokens: data.usage.output_tokens,
              model: data.model,
              requestId,
            }),
          () => {},
        );
      } else {
        // Nothing is waiting on it any more; swallow so it cannot surface as an
        // unhandled rejection.
        inflight.catch(() => {});
      }
      throw failure;
    }
  }
}

/** Rejects once the deadline passes, so a silent transport cannot outlive it. */
function deadlineRejection(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new JevError("deadline", "Jev missed the router deadline")), ms);
    // Node keeps the process alive for a pending timer; this one must never do that.
    timer.unref?.();
  });
}

function classify(error: unknown): JevError {
  if (error instanceof JevError) return error;
  if (error instanceof APIUserAbortError) return new JevError("aborted", error.message);
  if (error instanceof APIError) {
    return new JevError("api", `TypeSafe ${error.status}: ${error.message}`, error.status);
  }
  if (error instanceof Error) return new JevError("network", error.message);
  return new JevError("network", String(error));
}
