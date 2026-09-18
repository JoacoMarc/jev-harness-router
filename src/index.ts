/**
 * A per-turn harness router.
 *
 * One Jev call decides the model tier, the tool set, the skill and the effort budget for
 * an agent turn, behind a hard latency deadline with a deterministic fallback.
 *
 *   const router = createRouter();
 *   const route = await router.route({ message: "arreglá el bug de auth en el login" });
 *   // route.model, route.effort, route.tools, route.skill, route.telemetry.totalMs
 */
export { Router, createRouter, SequenceGate, MIN_RERANK_MS } from "./router.ts";
export type { RouterOptions } from "./router.ts";

export { renderSkillBlock, systemPromptParts } from "./prompt.ts";

export { DEFAULT_THRESHOLDS, decide, gateScore, margin, topSkills, applyRerank } from "./policy.ts";
export type { PolicyResult, Thresholds, Diagnostics } from "./policy.ts";

export { buildQuestions, buildRerankQuestions, questionCount } from "./questions.ts";
export type { RouterAnswers, RouterQuestions } from "./questions.ts";

export { buildState, availableTools } from "./state.ts";
export { heuristicRoute, isShortcut } from "./heuristic.ts";

export { Jev, JevError, MissingKeyError, DEFAULT_DEADLINE_MS, DEFAULT_MODEL } from "./jev.ts";

export * from "./catalog/index.ts";
export type {
  RouteDecision,
  DecisionSource,
  Telemetry,
  TurnInput,
  TurnState,
  SessionFacts,
} from "./types.ts";
export { USD_PER_INPUT_TOKEN } from "./types.ts";
