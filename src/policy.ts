import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import {
  DEFAULT_CATALOG,
  EFFORTS,
  NO_SKILL,
  maxEffort,
  type Catalog,
  type CatalogSpec,
  type DefaultCatalogSpec,
  type Effort,
  type SkillIdOf,
  type TierOf,
  type ToolIdOf,
} from "./catalog/index.ts";
import {
  GATE_IDS,
  INVERTED_GATES,
  Q,
  fitsId,
  gateId,
  toolId,
  type RerankAnswers,
  type RouterAnswers,
} from "./questions.ts";

/**
 * Everything the router decides once Jev has answered.
 *
 * Pure by design. It takes answers and returns a route; it never calls anything. That
 * makes the entire decision layer testable with no API key (`test/policy.test.ts`), and
 * it means moving a threshold re-derives a route from stored probabilities without
 * spending another request.
 */

const fallbackCatalog = <C extends CatalogSpec>(): Catalog<C> =>
  DEFAULT_CATALOG as unknown as Catalog<C>;

export interface Thresholds {
  /** Mean of the three request-shape gates, below which no skill is suggested. */
  readonly gate: number;
  /** Choice confidence the winning skill must clear before it is applied. */
  readonly skillConfidence: number;
  /** Share of `tool::which` probability a runner-up needs before it is considered. */
  readonly toolTail: number;
  /** Below this confidence on difficulty, escalate rather than guess. */
  readonly escalateConfidence: number;
  /** `p(top1) - p(top2)` on skills, below which a second hop is worth its latency. */
  readonly rerankMargin: number;
  /** Highest per-candidate `fits` Noul a shortlist must reach, or it is dropped whole. */
  readonly fits: number;
  /** How many finalists the second hop reads properly. */
  readonly shortlist: number;
  /**
   * Quantile of the difficulty distribution to read, in place of its expectation.
   * 0.5 is the median; higher leans toward whatever mass sits at the hard end.
   */
  readonly difficultyQuantile: number;
  /** Same, for scope. */
  readonly scopeQuantile: number;
  /**
   * Difficulty level at or above which the tier steps up. One cut per rung above the
   * floor, so a catalogue with N tiers wants N-1 of these; extra cuts are never reached
   * and missing ones leave the top rungs unused.
   */
  readonly tierCuts: readonly number[];
  /** Difficulty level at or above which effort steps up. Length must be EFFORTS-1. */
  readonly effortCuts: readonly number[];
  /** Scope level at or above which the tier is floored at `scopeFloorTier`. */
  readonly scopeFloor: number;
  /**
   * Index into the catalogue's tier ladder that a broad-scope turn is floored at. An
   * index rather than a name, so a catalogue with two tiers or five needs no edit here.
   */
  readonly scopeFloorTier: number;
  /** Multiplies every per-risk tool bar at once, so the whole set can be swept as one knob. */
  readonly toolScale: number;
}

/**
 * Tuned on `fixtures/turns.jsonl` with `npm run eval`, not copied from the docs.
 *
 * What the sweep said, on 54 turns and this 24-skill catalogue:
 *
 * - `gate` 0.20 with `skillConfidence` 0.60 gives 92.6% skill accuracy at 6.9% false
 *   positives; the cookbook's 0.30/0.40 gives 85.2% at 13.8%.
 *
 *   Getting there took a question, not a number. With only the cookbook's three gates
 *   the best the sweep could do was 90.7%, and only by dropping the gate to 0.10 — at
 *   which point it barely gated at all. The cause was that all three probes ask whether
 *   an *action* is wanted, and this catalogue carries advisory skills: writing an ADR
 *   touches nothing and follows no command list, so `architecture` was being suppressed
 *   on turns the ranking had already named at confidence 0.99. Adding
 *   `produces_artifact` restored a real interior optimum (0.10 -> 87.0%, 0.20 -> 92.6%,
 *   0.30 -> 90.7%, 0.40 -> 79.6%), which is what a threshold doing useful work looks
 *   like. A flat or monotonic sweep is a sign the question is missing, not the number.
 * - Tier is read as the 0.60 quantile of the difficulty distribution with cuts at levels
 *   [2, 3]: 51.9% exact, 92.6% within one tier, and **0% under-provisioned**. Routing on
 *   the expectation instead scored the same on exactness and better on within-one, but
 *   sent 7.4% of turns to a model too small for them — and that is the error that hides.
 *   A grid over 270 combinations found no setting that beat it on under-provisioning.
 *
 * - `escalateConfidence` is 0, which switches the rule off. It came from the
 *   confidence-routing pattern, which is about *Choice* confidence, and the jaggedness
 *   page is explicit that a threshold tuned on one primitive does not carry to another.
 *   Half of these turns have a Score confidence under 0.5, so at 0.5 the "escalate when
 *   unsure" safety net was the default path rather than a net. Reading the distribution
 *   handles the same uncertainty properly; the sweep puts it 3.7pp ahead with the rule
 *   off. It stays as a knob because a catalogue with better-separated levels may want it.
 * - `toolScale` stays at 1. Raising it scores better only because it disables `Bash`
 *   outright, and for a router recall matters more than precision: a missing tool blocks
 *   the turn, an extra one costs a little context.
 *
 * Re-swept in September 2026 on 181 turns, 127 of them real ones from the author's Claude
 * Code sessions with the previous reply as `recentContext`: gate 0.20 is still the
 * interior optimum (90.0% skill accuracy, 8.1% false positives at skillConfidence 0.60);
 * skillConfidence 0.70 edges it on that set (91.7%, 5.6%, same misses) and is left alone
 * until a second sample agrees. difficultyQuantile 0.60 gives 61-63% exact tier at 3.3%
 * under-provisioned across runs; 0.50 gives about 68% at 6%. The labels are still one person's
 * judgement. Re-run the sweep on your own traffic before trusting these to three decimal
 * places.
 * `tierCuts` in particular assumes a three-tier ladder; a catalogue with two or four
 * tiers should pass its own.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  gate: 0.2,
  skillConfidence: 0.6,
  toolTail: 0.25,
  escalateConfidence: 0,
  rerankMargin: 0.35,
  fits: 0.3,
  shortlist: 3,
  difficultyQuantile: 0.6,
  scopeQuantile: 0.6,
  tierCuts: [2, 3],
  effortCuts: [1, 2, 3],
  scopeFloor: 2,
  scopeFloorTier: 1,
  toolScale: 1,
};

export interface PolicyResult<C extends CatalogSpec = DefaultCatalogSpec> {
  readonly tier: TierOf<C>;
  readonly model: string;
  readonly effort: Effort;
  readonly tools: readonly ToolIdOf<C>[];
  readonly skill: SkillIdOf<C> | null;
  readonly why: readonly string[];
  readonly diagnostics: Diagnostics;
}

export interface Diagnostics {
  readonly difficulty: number;
  readonly difficultyConfidence: number;
  readonly scope: number;
  readonly intent: string;
  readonly intentConfidence: number;
  readonly gate: number;
  readonly gateValues: Readonly<Record<string, number>>;
  readonly skillTop: string;
  readonly skillConfidence: number;
  /** `p(top1) - p(top2)` over the skill Choice. Small means the ranking is contested. */
  readonly skillMargin: number;
  readonly toolProbabilities: Readonly<Record<string, number>>;
  /** True when a second hop over the top skills would plausibly change the answer. */
  readonly rerankWorthwhile: boolean;
}

// ---------------------------------------------------------------- reading answers

/**
 * Answers seen by id, without the catalogue-specific key types.
 *
 * The typed `RouterAnswers<C>` is what callers get and what the tests assert on. Inside
 * the policy the catalogue is a type parameter, and indexing a mapped type by a generic
 * template-literal key is something TypeScript will not resolve — so the policy reads
 * through this view and checks each answer's `type` tag at runtime instead.
 */
type AnswerView = Readonly<Record<string, NoulResponse | ChoiceResponse | ScoreResponse | undefined>>;

const view = (answers: object): AnswerView => answers as AnswerView;

function noulAt(answers: AnswerView, id: string): number {
  const a = answers[id];
  if (!a || a.type !== "noul") throw new Error(`Expected a Noul answer at "${id}"`);
  return a.noul;
}

function choiceAt(answers: AnswerView, id: string): ChoiceResponse {
  const a = answers[id];
  if (!a || a.type !== "choice") throw new Error(`Expected a Choice answer at "${id}"`);
  return a;
}

function scoreAt(answers: AnswerView, id: string): ScoreResponse {
  const a = answers[id];
  if (!a || a.type !== "score") throw new Error(`Expected a Score answer at "${id}"`);
  return a;
}

// ---------------------------------------------------------------- arithmetic

/** Steps up through an ordered ladder by counting how many cuts the value clears. */
function bucket<T>(ladder: readonly T[], cuts: readonly number[], value: number): T {
  let index = 0;
  for (const cut of cuts) if (value >= cut) index += 1;
  return ladder[Math.min(index, ladder.length - 1)] as T;
}

/**
 * The lowest level whose cumulative probability reaches `q`.
 *
 * Read instead of the expectation, because the expectation lies on a bimodal answer and
 * bimodal answers are common here. "escribí el ADR" came back
 * `{0: 0.45, 1: 0.08, 2: 0.04, 3: 0.43}` — the model seeing two readings of the turn, not
 * one middling one — and its expectation of 1.46 describes neither. A high quantile also
 * encodes the asymmetry the whole router is built on: under-provisioning is the error
 * that hides, so when the distribution has real mass up top, believe the top.
 *
 * The docs are explicit that a Score's `score` and `probabilities` must be read
 * together; this is what reading them together looks like in code.
 */
export function scoreQuantile(
  probabilities: Readonly<Record<string, number>>,
  q: number,
): number {
  const levels = Object.keys(probabilities)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  let cumulative = 0;
  for (const level of levels) {
    cumulative += probabilities[String(level)] ?? 0;
    if (cumulative >= q) return level;
  }
  return levels[levels.length - 1] ?? 0;
}

/** Difference between the top two probabilities. 1 for a single option, 0 for a tie. */
export function margin(probabilities: Readonly<Record<string, number>>): number {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return 1;
  return (sorted[0] as number) - (sorted[1] as number);
}

/**
 * Folds the gates into one number.
 *
 * A mean, not a max: these are angles on the same question, so one weak probe should
 * not carry the decision. Risk flags are the opposite case and use `max`, because
 * averaging a red flag is how you silence it.
 */
export function gateScore<C extends CatalogSpec = DefaultCatalogSpec>(
  answers: RouterAnswers<C>,
): {
  score: number;
  values: Record<string, number>;
} {
  const a = view(answers);
  const values: Record<string, number> = {};
  let sum = 0;
  for (const id of GATE_IDS) {
    const raw = noulAt(a, gateId(id));
    values[id] = raw;
    sum += INVERTED_GATES.has(id) ? 1 - raw : raw;
  }
  return { score: sum / GATE_IDS.length, values };
}

// ---------------------------------------------------------------- the decision

export function decide<C extends CatalogSpec = DefaultCatalogSpec>(
  answers: RouterAnswers<C>,
  asked: readonly ToolIdOf<C>[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  catalog: Catalog<C> = fallbackCatalog<C>(),
): PolicyResult<C> {
  const a = view(answers);
  const why: string[] = [];

  const difficulty = scoreAt(a, Q.difficulty);
  const scope = scoreAt(a, Q.scope);
  const intent = choiceAt(a, Q.intent);

  // ---- model tier and effort -------------------------------------------------
  const difficultyLevel = scoreQuantile(difficulty.probabilities, thresholds.difficultyQuantile);
  const scopeLevel = scoreQuantile(scope.probabilities, thresholds.scopeQuantile);

  let tier = bucket(catalog.tiers, thresholds.tierCuts, difficultyLevel);
  let effort = bucket(EFFORTS, thresholds.effortCuts, difficultyLevel);
  why.push(
    `difficulty level ${difficultyLevel} (expectation ${difficulty.score.toFixed(2)}) -> ${tier}/${effort}`,
  );

  if (scopeLevel >= thresholds.scopeFloor) {
    const floor = catalog.tierAt(thresholds.scopeFloorTier);
    const floored = catalog.maxTier(tier, floor);
    if (floored !== tier) why.push(`scope level ${scopeLevel} floors tier at ${floor}`);
    tier = floored;
  }

  // Degrade toward the expensive path, never away from it. If the model cannot tell how
  // hard the turn is, the cost of a needlessly big model is visible and bounded; the
  // cost of a needlessly small one is a silently worse answer.
  if (difficulty.confidence < thresholds.escalateConfidence) {
    const up = catalog.tierAt(catalog.tierIndex(tier) + 1);
    const upEffort = EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)] as Effort;
    if (up !== tier || upEffort !== effort) {
      why.push(`difficulty confidence ${difficulty.confidence.toFixed(2)} is low, escalating`);
    }
    tier = catalog.maxTier(tier, up);
    effort = maxEffort(effort, upEffort);
  }

  // ---- tools -----------------------------------------------------------------
  const tools: ToolIdOf<C>[] = [];
  for (const id of asked) {
    const p = noulAt(a, toolId(id));
    if (p >= catalog.thresholdFor(id) * thresholds.toolScale) tools.push(id);
  }

  // The Choice is relative and the Nouls are absolute, so they answer different
  // questions and their runner-ups are worth reading. A tool with a real share of the
  // Choice's probability joins the set even if its own Noul fell just short — but only
  // when it is read-only. A write or execute tool has to clear its own absolute bar,
  // because the message driving this decision is untrusted input.
  const toolProbabilities: Record<string, number> = {};
  const which = choiceAt(a, Q.toolWhich);
  for (const [label, p] of Object.entries(which.probabilities)) {
    toolProbabilities[label] = p;
    if (label === NO_SKILL || !catalog.isToolId(label)) continue;
    if (!asked.includes(label) || tools.includes(label)) continue;
    if (p < thresholds.toolTail) continue;
    const risk = catalog.toolCard(label).risk;
    if (risk === "read") {
      tools.push(label);
      why.push(`${label} added from the tool ranking tail (p=${p.toFixed(2)})`);
    } else {
      why.push(`${label} ranked high (p=${p.toFixed(2)}) but is ${risk}-risk; held back`);
    }
  }

  if (tools.length === 0) why.push("no tool cleared its bar");

  // ---- skill -----------------------------------------------------------------
  const gate = gateScore(answers);
  const skillAnswer = choiceAt(a, Q.skill);
  const skillMargin = margin(skillAnswer.probabilities);
  let skill: SkillIdOf<C> | null = null;

  if (gate.score < thresholds.gate) {
    why.push(`gate ${gate.score.toFixed(2)} below ${thresholds.gate}, no skill`);
  } else if (skillAnswer.choice === NO_SKILL) {
    why.push("skill ranking picked none");
  } else if (skillAnswer.confidence < thresholds.skillConfidence) {
    why.push(
      `skill "${skillAnswer.choice}" at confidence ${skillAnswer.confidence.toFixed(2)}, below ${thresholds.skillConfidence}`,
    );
  } else if (catalog.isSkillId(skillAnswer.choice)) {
    skill = skillAnswer.choice;
    why.push(`skill ${skill} (confidence ${skillAnswer.confidence.toFixed(2)})`);
  } else {
    // The catalogue changed under a cached or replayed answer.
    why.push(`unknown skill "${skillAnswer.choice}" ignored`);
  }

  const rerankWorthwhile =
    gate.score >= thresholds.gate &&
    skillAnswer.choice !== NO_SKILL &&
    skillMargin < thresholds.rerankMargin;

  return {
    tier,
    model: catalog.modelFor(tier).id,
    effort,
    tools,
    skill,
    why,
    diagnostics: {
      difficulty: difficulty.score,
      difficultyConfidence: difficulty.confidence,
      scope: scope.score,
      intent: intent.choice,
      intentConfidence: intent.confidence,
      gate: gate.score,
      gateValues: gate.values,
      skillTop: skillAnswer.choice,
      skillConfidence: skillAnswer.confidence,
      skillMargin,
      toolProbabilities,
      rerankWorthwhile,
    },
  };
}

// ---------------------------------------------------------------- second hop

/** The best `count` real skills from the first pass, `none` excluded. */
export function topSkills<C extends CatalogSpec = DefaultCatalogSpec>(
  answers: RouterAnswers<C>,
  count: number,
  catalog: Catalog<C> = fallbackCatalog<C>(),
): SkillIdOf<C>[] {
  return Object.entries(choiceAt(view(answers), Q.skill).probabilities)
    .filter((entry): entry is [SkillIdOf<C>, number] => catalog.isSkillId(entry[0]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([id]) => id);
}

/**
 * Folds a rerank pass into a first-pass result.
 *
 * Either step may come back empty-handed, which is the point: the Choice always picks a
 * winner among the finalists, so the absolute `fits` Nouls are what allow the whole
 * shortlist to be thrown out.
 */
export function applyRerank<C extends CatalogSpec = DefaultCatalogSpec>(
  first: PolicyResult<C>,
  answers: RerankAnswers<C>,
  names: readonly SkillIdOf<C>[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  catalog: Catalog<C> = fallbackCatalog<C>(),
): PolicyResult<C> {
  const a = view(answers);
  const why = [...first.why];
  const fits = names.map((id) => noulAt(a, fitsId(id)));
  const best = fits.length > 0 ? Math.max(...fits) : 0;

  if (best < thresholds.fits) {
    why.push(`rerank: best fit ${best.toFixed(2)} below ${thresholds.fits}, dropping the shortlist`);
    return { ...first, skill: null, why };
  }

  const winner = choiceAt(a, Q.skill).choice;
  if (winner === NO_SKILL || !catalog.isSkillId(winner)) {
    why.push("rerank: picked none");
    return { ...first, skill: null, why };
  }

  if (winner !== first.skill) why.push(`rerank: ${first.skill ?? "none"} -> ${winner}`);
  else why.push(`rerank confirmed ${winner}`);
  return { ...first, skill: winner, why };
}
