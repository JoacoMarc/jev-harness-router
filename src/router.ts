import { performance } from "node:perf_hooks";
import type { Fetch } from "@typesafe-ai/sdk";
import { Lru, cacheKey } from "./cache.ts";
import type { ToolId } from "./catalog/index.ts";
import { heuristicRoute, isShortcut, shortcutRoute } from "./heuristic.ts";
import { DEFAULT_DEADLINE_MS, Jev, JevError } from "./jev.ts";
import {
  DEFAULT_THRESHOLDS,
  applyRerank,
  decide,
  topSkills,
  type PolicyResult,
  type Thresholds,
} from "./policy.ts";
import { buildQuestions, buildRerankQuestions } from "./questions.ts";
import { availableTools, buildState } from "./state.ts";
import type { RouteDecision, Telemetry, TurnInput } from "./types.ts";

/**
 * Three lanes, cheapest first: a deterministic shortcut, then the cache, then Jev with a
 * hard deadline and the heuristic waiting behind it.
 *
 * The contract is the deadline, not the answer. A turn is never made slower by the thing
 * that was supposed to make it faster, so every path out of here is bounded.
 */

/** Below this much remaining budget the second hop is not attempted at all. */
export const MIN_RERANK_MS = 120;

export interface RouterOptions {
  /** Total budget for the whole route, second hop included. */
  readonly deadlineMs?: number;
  readonly thresholds?: Thresholds;
  /** Enable the margin-gated rerank pass. Off by default: measure before you pay for it. */
  readonly rerank?: boolean;
  readonly cacheSize?: number;
  /** `what`/`not_for`/`examples` objects for skill options. Defaults to true; see `questions.ts`. */
  readonly structuredSkillCriteria?: boolean;
  readonly model?: string;
  /** Injected in tests so the router runs with no key and no network. */
  readonly fetch?: Fetch;
}

export class Router {
  private readonly jev: Jev;
  private readonly cache: Lru<PolicyResult>;
  private readonly thresholds: Thresholds;

  constructor(private readonly options: RouterOptions = {}) {
    this.jev = new Jev({
      deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      ...(options.model ? { model: options.model } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.cache = new Lru<PolicyResult>(options.cacheSize ?? 256);
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  }

  get deadlineMs(): number {
    return this.options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Opens the connection so the first routed turn does not pay for the handshake.
   *
   * Takes a cold first turn from ~1,150ms to ~300ms. What variance is left after that is
   * the network's, and no amount of warming removes it.
   *
   * Best-effort and safe to ignore: it resolves false rather than throwing.
   */
  prewarm(): Promise<boolean> {
    return this.jev.prewarm();
  }

  async route(input: TurnInput, signal?: AbortSignal): Promise<RouteDecision> {
    const started = performance.now();
    const since = () => performance.now() - started;

    // Lane 1. The cheapest call is the one that never happens, and a slash command or a
    // bare "dale" is answerable from a regex. Direct evidence stays in code.
    if (isShortcut(input)) {
      return finish(shortcutRoute(input), "shortcut", since(), 0, 0, 0, 0, null);
    }

    const state = buildState(input);
    const key = cacheKey(state);

    // Lane 2.
    const cached = this.cache.get(key);
    if (cached) return finish(cached, "cache", since(), 0, 0, 0, 0, null);

    // Lane 3.
    const tools = availableTools(input);
    const questions = buildQuestions(tools, {
      structuredSkillCriteria: this.options.structuredSkillCriteria ?? true,
    });

    let first;
    try {
      // A late answer is still a correct answer. The deadline stops the harness waiting
      // for it; it does not stop the request, and whatever eventually lands goes into
      // the cache so a re-sent turn gets it for free.
      first = await this.jev.ask(state, questions, signal, (late) => {
        this.cache.set(key, decide(late.answers, tools, this.thresholds));
      });
    } catch (error) {
      const failure = error instanceof JevError ? error.failure : "network";
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = heuristicRoute(input);
      return finish(
        { ...fallback, why: [`jev ${failure}: ${reason}`, ...fallback.why] },
        "fallback",
        since(),
        Math.min(since(), this.deadlineMs),
        1,
        0,
        0,
        null,
      );
    }

    let result = decide(first.answers, tools, this.thresholds);
    let hops = 1;
    let jevMs = first.jevMs;
    let inputTokens = first.inputTokens;
    let outputTokens = first.outputTokens;

    // The second hop only happens when the ranking is genuinely contested *and* the
    // budget survived the first one. A late better answer is still a late answer.
    const remaining = this.deadlineMs - since();
    if (
      (this.options.rerank ?? false) &&
      result.diagnostics.rerankWorthwhile &&
      remaining >= MIN_RERANK_MS
    ) {
      const names = topSkills(first.answers, this.thresholds.shortlist);
      if (names.length > 0) {
        try {
          const second = await new Jev({
            deadlineMs: Math.floor(remaining),
            ...(this.options.model ? { model: this.options.model } : {}),
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          }).ask(state, buildRerankQuestions(names), signal);
          result = applyRerank(result, second.answers, names, this.thresholds);
          hops = 2;
          jevMs += second.jevMs;
          inputTokens += second.inputTokens;
          outputTokens += second.outputTokens;
        } catch (error) {
          // The first hop's answer stands. A failed rerank is a missed refinement,
          // not a failed route.
          const reason = error instanceof Error ? error.message : String(error);
          result = { ...result, why: [...result.why, `rerank skipped: ${reason}`] };
        }
      }
    }

    this.cache.set(key, result);
    return finish(
      result,
      "jev",
      since(),
      jevMs,
      hops,
      inputTokens,
      outputTokens,
      first.model,
      first.requestId,
    );
  }
}

export function createRouter(options: RouterOptions = {}): Router {
  return new Router(options);
}

/**
 * Discards answers that arrive after a newer turn has already started.
 *
 * Only matters when the harness routes speculatively — on a debounce while the user is
 * still typing, say — where an in-flight route can outlive the message that asked for it.
 */
export class SequenceGate {
  private issued = 0;
  private applied = 0;
  private controller: AbortController | null = null;

  /** Cancels any in-flight route and returns the signal plus a staleness check. */
  next(): { seq: number; signal: AbortSignal; isStale: () => boolean } {
    this.controller?.abort();
    this.controller = new AbortController();
    const seq = ++this.issued;
    return {
      seq,
      signal: this.controller.signal,
      isStale: () => seq < this.applied,
    };
  }

  /** Marks a sequence as applied. Returns false when a newer one already landed. */
  accept(seq: number): boolean {
    if (seq < this.applied) return false;
    this.applied = seq;
    return true;
  }
}

function finish(
  result: PolicyResult,
  source: RouteDecision["source"],
  totalMs: number,
  jevMs: number,
  hops: number,
  inputTokens: number,
  outputTokens: number,
  model: string | null,
  requestId?: string | undefined,
): RouteDecision {
  const telemetry: Telemetry = {
    totalMs,
    jevMs,
    hops,
    inputTokens,
    outputTokens,
    model,
    requestId,
  };
  return {
    tier: result.tier,
    model: result.model,
    effort: result.effort,
    tools: result.tools as readonly ToolId[],
    skill: result.skill,
    source,
    why: result.why,
    telemetry,
  };
}
