import type {
  CatalogSpec,
  DefaultCatalogSpec,
  Effort,
  SkillIdOf,
  TierOf,
  ToolIdOf,
} from "./catalog/index.ts";

/** What the harness hands the router at the start of a turn. */
export interface TurnInput {
  /** The message the user just sent. The only untrusted field. */
  readonly message: string;
  /**
   * A short recap of what came before — a few lines at most, not the transcript.
   * State size is the dominant lever on both latency and accuracy: `jev-1.13` loses
   * accuracy as irrelevant material grows around the decision.
   */
  readonly recentContext?: string;
  readonly session?: SessionFacts;
}

/** Facts the harness already knows. Observed, never inferred, and never asked about. */
export interface SessionFacts {
  readonly turnIndex?: number;
  readonly cwdKind?: string;
  readonly openFiles?: readonly string[];
  readonly lastToolsUsed?: readonly string[];
  /** One of the catalogue's tier names. */
  readonly lastTier?: string;
  /**
   * Tools the harness cannot offer this turn, by catalogue id. Removed in code before
   * Jev ever sees them; ids not in the catalogue are ignored.
   */
  readonly unavailableTools?: readonly string[];
}

/** The compact object sent as Jev's `state`. Questions reference its fields by name. */
export interface TurnState {
  readonly [key: string]: unknown;
  readonly latest_user_message: string;
  readonly recent_context: string;
  readonly session: Record<string, unknown>;
  readonly unavailable_tools: readonly string[];
}

/** Where a decision came from. Every route carries one; the bench slices on it. */
export type DecisionSource =
  /** A deterministic rule answered it. No model call was made. */
  | "shortcut"
  /** An identical turn was routed moments ago. */
  | "cache"
  /** Jev answered inside the deadline. */
  | "jev"
  /** Jev missed the deadline or failed. The heuristic answered instead. */
  | "fallback";

/**
 * What the router hands back. Generic over the catalogue it was built from, so
 * `route.tier`, `route.tools` and `route.skill` are unions of *your* names.
 */
export interface RouteDecision<C extends CatalogSpec = DefaultCatalogSpec> {
  readonly tier: TierOf<C>;
  readonly model: string;
  readonly effort: Effort;
  readonly tools: readonly ToolIdOf<C>[];
  readonly skill: SkillIdOf<C> | null;
  readonly source: DecisionSource;
  /** Short, human-readable notes on why this route came out the way it did. */
  readonly why: readonly string[];
  readonly telemetry: Telemetry;
}

export interface Telemetry {
  /** Wall clock for the whole `route()` call, including cache and policy. */
  readonly totalMs: number;
  /** Wall clock spent inside Jev. Zero for shortcut and cache hits. */
  readonly jevMs: number;
  readonly hops: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string | null;
  readonly requestId?: string | undefined;
}

/** https://docs.typesafe.ai/models — jev-1.13: $0.042 per million input tokens, output free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
