import {
  EFFORTS,
  NO_SKILL,
  TOOLS,
  isSkillId,
  isToolId,
  maxEffort,
  maxTier,
  modelFor,
  thresholdFor,
  tierAt,
  TIERS,
  type Effort,
  type SkillId,
  type Tier,
  type ToolId,
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
  /** Difficulty expectation at or above which the tier steps up. Length must be TIERS-1. */
  readonly tierCuts: readonly number[];
  /** Difficulty expectation at or above which effort steps up. Length must be EFFORTS-1. */
  readonly effortCuts: readonly number[];
  /** Scope expectation at or above which the tier is floored at `scopeFloorTier`. */
  readonly scopeFloor: number;
  /**
   * Index into `TIERS` that a broad-scope turn is floored at. An index rather than a
   * name, so a catalogue with two tiers or five needs no edit here.
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
 * - `tierCuts` [2.0, 2.8] gives 51.9% exact and 94.4% within one tier, against 33.3% and
 *   77.8% at [0.8, 2.2]. Jev's difficulty expectation runs high against these labels.
 * - `toolScale` stays at 1. Raising it scores better only because it disables `Bash`
 *   outright, and for a router recall matters more than precision: a missing tool blocks
 *   the turn, an extra one costs a little context.
 *
 * Fifty-four labelled turns is a small sample and the labels are one person's judgement.
 * Re-run the sweep on your own traffic before trusting these to three decimal places.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  gate: 0.2,
  skillConfidence: 0.6,
  toolTail: 0.25,
  escalateConfidence: 0.5,
  rerankMargin: 0.35,
  fits: 0.3,
  shortlist: 3,
  tierCuts: [2.0, 2.8],
  effortCuts: [0.8, 1.8, 2.6],
  scopeFloor: 1.5,
  scopeFloorTier: 1,
  toolScale: 1,
};

export interface PolicyResult {
  readonly tier: Tier;
  readonly model: string;
  readonly effort: Effort;
  readonly tools: readonly ToolId[];
  readonly skill: SkillId | null;
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

/** Steps up through an ordered ladder by counting how many cuts the value clears. */
function bucket<T>(ladder: readonly T[], cuts: readonly number[], value: number): T {
  let index = 0;
  for (const cut of cuts) if (value >= cut) index += 1;
  return ladder[Math.min(index, ladder.length - 1)] as T;
}

/** Difference between the top two probabilities. 1 for a single option, 0 for a tie. */
export function margin(probabilities: Readonly<Record<string, number>>): number {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return 1;
  return (sorted[0] as number) - (sorted[1] as number);
}

/**
 * Folds the three gates into one number.
 *
 * A mean, not a max: these are three angles on the same question, so one weak probe
 * should not carry the decision. Risk flags are the opposite case and use `max` below,
 * because averaging a red flag is how you silence it.
 */
export function gateScore(answers: RouterAnswers): {
  score: number;
  values: Record<string, number>;
} {
  const values: Record<string, number> = {};
  let sum = 0;
  for (const id of GATE_IDS) {
    const raw = answers[gateId(id)].noul;
    values[id] = raw;
    sum += INVERTED_GATES.has(id) ? 1 - raw : raw;
  }
  return { score: sum / GATE_IDS.length, values };
}

export function decide(
  answers: RouterAnswers,
  asked: readonly ToolId[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): PolicyResult {
  const why: string[] = [];

  const difficulty = answers[Q.difficulty];
  const scope = answers[Q.scope];
  const intent = answers[Q.intent];

  // ---- model tier and effort -------------------------------------------------
  let tier = bucket(TIERS, thresholds.tierCuts, difficulty.score);
  let effort = bucket(EFFORTS, thresholds.effortCuts, difficulty.score);
  why.push(`difficulty ${difficulty.score.toFixed(2)} -> ${tier}/${effort}`);

  if (scope.score >= thresholds.scopeFloor) {
    const floor = tierAt(thresholds.scopeFloorTier);
    const floored = maxTier(tier, floor);
    if (floored !== tier) why.push(`scope ${scope.score.toFixed(2)} floors tier at ${floor}`);
    tier = floored;
  }

  // Degrade toward the expensive path, never away from it. If the model cannot tell how
  // hard the turn is, the cost of a needlessly big model is visible and bounded; the
  // cost of a needlessly small one is a silently worse answer.
  if (difficulty.confidence < thresholds.escalateConfidence) {
    const up = tierAt(TIERS.indexOf(tier) + 1);
    const upEffort = EFFORTS[Math.min(EFFORTS.indexOf(effort) + 1, EFFORTS.length - 1)] as Effort;
    if (up !== tier || upEffort !== effort) {
      why.push(`difficulty confidence ${difficulty.confidence.toFixed(2)} is low, escalating`);
    }
    tier = maxTier(tier, up);
    effort = maxEffort(effort, upEffort);
  }

  // ---- tools -----------------------------------------------------------------
  const tools: ToolId[] = [];
  for (const id of asked) {
    const p = answers[toolId(id)].noul;
    if (p >= thresholdFor(id) * thresholds.toolScale) tools.push(id);
  }

  // The Choice is relative and the Nouls are absolute, so they answer different
  // questions and their runner-ups are worth reading. A tool with a real share of the
  // Choice's probability joins the set even if its own Noul fell just short — but only
  // when it is read-only. A write or execute tool has to clear its own absolute bar,
  // because the message driving this decision is untrusted input.
  const toolProbabilities: Record<string, number> = {};
  const which = answers[Q.toolWhich];
  for (const [label, p] of Object.entries(which.probabilities)) {
    toolProbabilities[label] = p;
    if (label === NO_SKILL || !isToolId(label)) continue;
    if (!asked.includes(label) || tools.includes(label)) continue;
    if (p < thresholds.toolTail) continue;
    if (TOOLS[label].risk === "read") {
      tools.push(label);
      why.push(`${label} added from the tool ranking tail (p=${p.toFixed(2)})`);
    } else {
      why.push(`${label} ranked high (p=${p.toFixed(2)}) but is ${TOOLS[label].risk}-risk; held back`);
    }
  }

  if (tools.length === 0) why.push("no tool cleared its bar");

  // ---- skill -----------------------------------------------------------------
  const gate = gateScore(answers);
  const skillAnswer = answers[Q.skill];
  const skillMargin = margin(skillAnswer.probabilities);
  let skill: SkillId | null = null;

  if (gate.score < thresholds.gate) {
    why.push(`gate ${gate.score.toFixed(2)} below ${thresholds.gate}, no skill`);
  } else if (skillAnswer.choice === NO_SKILL) {
    why.push("skill ranking picked none");
  } else if (skillAnswer.confidence < thresholds.skillConfidence) {
    why.push(
      `skill "${skillAnswer.choice}" at confidence ${skillAnswer.confidence.toFixed(2)}, below ${thresholds.skillConfidence}`,
    );
  } else if (isSkillId(skillAnswer.choice)) {
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
    model: modelFor(tier).id,
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
export function topSkills(answers: RouterAnswers, count: number): SkillId[] {
  return Object.entries(answers[Q.skill].probabilities)
    .filter((entry): entry is [SkillId, number] => isSkillId(entry[0]))
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
export function applyRerank(
  first: PolicyResult,
  answers: RerankAnswers,
  names: readonly SkillId[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): PolicyResult {
  const why = [...first.why];
  const fits = names.map((id) => answers[fitsId(id)].noul);
  const best = fits.length > 0 ? Math.max(...fits) : 0;

  if (best < thresholds.fits) {
    why.push(`rerank: best fit ${best.toFixed(2)} below ${thresholds.fits}, dropping the shortlist`);
    return { ...first, skill: null, why };
  }

  const winner = answers[Q.skill].choice;
  if (winner === NO_SKILL || !isSkillId(winner)) {
    why.push("rerank: picked none");
    return { ...first, skill: null, why };
  }

  if (winner !== first.skill) why.push(`rerank: ${first.skill ?? "none"} -> ${winner}`);
  else why.push(`rerank confirmed ${winner}`);
  return { ...first, skill: winner, why };
}
