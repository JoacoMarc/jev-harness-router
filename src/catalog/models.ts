/**
 * Model tiers and effort levels.
 *
 * The router never asks Jev "which model should run this turn?" — that is an indirect
 * question (the tier is a property of the difficulty, which is a property of the turn),
 * and `jev-1.13` loses accuracy on indirection. Jev is asked about the turn; this
 * catalogue and `policy.ts` own the mapping from turn properties to a model.
 *
 * Swapping in a new model is an edit here and nothing else. No prompt changes, no
 * re-tuned thresholds.
 */

/** Ordered from cheapest/fastest to most capable. Order is load-bearing: policy escalates by index. */
export const TIERS = ["fast", "balanced", "deep"] as const;
export type Tier = (typeof TIERS)[number];

/** Ordered from least to most reasoning budget. Order is load-bearing. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelCard {
  /** The id the harness passes to the Anthropic API. */
  readonly id: string;
  readonly label: string;
  /** What this tier is for, in the harness operator's terms. Not sent to Jev. */
  readonly use: string;
}

export const MODELS = {
  fast: {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    use: "Lookups, single-file edits, mechanical transforms, short answers.",
  },
  balanced: {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    use: "Ordinary feature work and debugging across a handful of files.",
  },
  deep: {
    id: "claude-opus-5",
    label: "Opus 5",
    use: "Architecture, cross-cutting refactors, ambiguous or high-stakes work.",
  },
} as const satisfies Record<Tier, ModelCard>;

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** Never de-escalate silently: returns whichever tier is more capable. */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierIndex(a) >= tierIndex(b) ? a : b;
}

export function effortIndex(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return effortIndex(a) >= effortIndex(b) ? a : b;
}
