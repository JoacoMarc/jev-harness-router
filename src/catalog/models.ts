/**
 * Model tiers and effort levels.
 *
 * ── Edit this file to make the router yours. ─────────────────────────────────
 * Nothing outside `src/catalog/` knows what a "fast" tier is or that Claude
 * exists. Replace the entries below with your own, in any number, and the types
 * follow: `route.tier` narrows to your tier names and a `switch` over it is
 * exhaustiveness-checked.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The router never asks Jev "which model should run this turn?" — that is an indirect
 * question (the tier is a property of the difficulty, which is a property of the turn),
 * and `jev-1.13` loses accuracy on indirection. Jev is asked about the turn; this
 * catalogue and `policy.ts` own the mapping from turn properties to a model.
 */

export interface ModelCard {
  /** Whatever your harness passes to its provider. Nothing here parses it. */
  readonly id: string;
  readonly label: string;
  /** What this tier is for, in the harness operator's terms. Never sent to Jev. */
  readonly use: string;
  /**
   * Patterns that mean "this turn deserves at least this tier", for the offline
   * heuristic only — the fallback when Jev misses the deadline, and the baseline the
   * eval scores against. Jev never sees them.
   *
   * Matched against diacritic-folded text, so write them unaccented: `arregl\w*`
   * catches "arreglá". The cheapest tier declares an empty list: it is the floor, so
   * nothing has to match for a turn to land there.
   */
  readonly hints?: readonly RegExp[];
}

/**
 * Ordered cheapest and fastest first. **The order is the capability ladder** — policy
 * escalates by index, so an entry's position matters more than its name.
 */
export const MODELS = [
  {
    tier: "fast",
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    use: "Lookups, single-file edits, mechanical transforms, short answers.",
    hints: [],
  },
  {
    tier: "balanced",
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    use: "Ordinary feature work and debugging across a handful of files.",
    hints: [
      /\b(implement\w*|agreg\w*|add |featur\w*|bug|error|falla|rompe|broken|fix|arregl\w*|test\w*|refactor|integr\w*|debug\w*)\b/i,
    ],
  },
  {
    tier: "deep",
    id: "claude-opus-5",
    label: "Opus 5",
    use: "Architecture, cross-cutting refactors, ambiguous or high-stakes work.",
    hints: [
      /\b(refactor\w*|arquitectur\w*|architect\w*|migrat\w*|migrac\w*|redisen\w*|redesign|trade-?offs?|estrateg\w*|strateg\w*|por que|why does|design (a|the)|disen\w*)\b/i,
    ],
  },
] as const satisfies readonly (ModelCard & { tier: string })[];

export type Tier = (typeof MODELS)[number]["tier"];

export const TIERS = MODELS.map((m) => m.tier) as readonly Tier[] as Tier[];

/** Ordered from least to most reasoning budget. The order is load-bearing. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

const BY_TIER = new Map(MODELS.map((m) => [m.tier as Tier, m as ModelCard & { tier: Tier }]));

export function modelFor(tier: Tier): ModelCard {
  const card = BY_TIER.get(tier);
  if (!card) throw new Error(`Unknown tier "${tier}". Check src/catalog/models.ts.`);
  return card;
}

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** Never de-escalate silently: returns whichever tier is more capable. */
export function maxTier(a: Tier, b: Tier): Tier {
  return tierIndex(a) >= tierIndex(b) ? a : b;
}

/** The tier at `index`, clamped to the ladder. */
export function tierAt(index: number): Tier {
  return TIERS[Math.min(Math.max(index, 0), TIERS.length - 1)] as Tier;
}

export function effortIndex(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return effortIndex(a) >= effortIndex(b) ? a : b;
}

export function effortAt(index: number): Effort {
  return EFFORTS[Math.min(Math.max(index, 0), EFFORTS.length - 1)] as Effort;
}
