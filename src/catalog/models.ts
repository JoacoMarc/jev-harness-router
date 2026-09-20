/**
 * Model tiers and effort levels.
 *
 * ── The shipped default. ─────────────────────────────────────────────────────
 * Using the package as a dependency? Pass your own to `createRouter({ catalog })`
 * via `defineCatalog` and leave this file alone. Cloned the repo? Edit it here.
 * Either way the types follow: `route.tier` narrows to your tier names and a
 * `switch` over it is exhaustiveness-checked.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The router never asks Jev "which model should run this turn?" — that is an indirect
 * question (the tier is a property of the difficulty, which is a property of the turn),
 * and `jev-1.13` loses accuracy on indirection. Jev is asked about the turn; this
 * catalogue and `policy.ts` own the mapping from turn properties to a model.
 */

import type { ModelCard } from "./types.ts";

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
] as const satisfies readonly ModelCard[];
