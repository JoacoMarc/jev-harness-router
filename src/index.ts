/**
 * A per-turn harness router.
 *
 * One Jev call decides the model tier, the tool set, the skill and the effort budget for
 * an agent turn, behind a hard latency deadline with a deterministic fallback.
 *
 *   const catalog = defineCatalog({ models, tools, skills });
 *   const router = createRouter({ catalog });
 *   const route = await router.route({ message: "arreglá el bug de auth en el login" });
 *   // route.model, route.effort, route.tools, route.skill, route.telemetry.totalMs
 */
export { Router, createRouter, SequenceGate, MIN_RERANK_MS } from "./router.ts";
export type { RouterOptions } from "./router.ts";

export { renderSkillBlock, systemPromptParts, DEFAULT_PROMPT_OPTIONS } from "./prompt.ts";
export type { PromptOptions } from "./prompt.ts";

export {
  DEFAULT_THRESHOLDS,
  decide,
  gateScore,
  margin,
  scoreQuantile,
  topSkills,
  applyRerank,
} from "./policy.ts";
export type { PolicyResult, Thresholds, Diagnostics } from "./policy.ts";

export {
  buildQuestions,
  buildRerankQuestions,
  questionCount,
  skillCriteria,
  toolCriteria,
  GATE_IDS,
  GATE_QUESTIONS,
  DIFFICULTY_LEVELS,
  SCOPE_LEVELS,
  INTENT_CRITERIA,
  Q,
} from "./questions.ts";
export type {
  RouterAnswers,
  RouterQuestions,
  RerankAnswers,
  RerankQuestions,
  BuildOptions,
  GateId,
} from "./questions.ts";

export { buildState, availableTools, truncate } from "./state.ts";
export { heuristicRoute, isShortcut, shortcutRoute, normalize } from "./heuristic.ts";
export { Lru, cacheKey } from "./cache.ts";

export {
  Jev,
  JevError,
  MissingKeyError,
  defaultDeadlineMs,
  DEADLINE_ENV,
  FALLBACK_DEADLINE_MS,
  DEFAULT_MODEL,
} from "./jev.ts";
export type { JevOptions, JevOutcome, JevFailure } from "./jev.ts";

export * from "./catalog/index.ts";

export {
  complete,
  hasProviderKey,
  providerKey,
  ProviderError,
  MissingProviderKeyError,
} from "./provider.ts";
export type { CompleteRequest, FetchLike, Message, Reply } from "./provider.ts";

export { isMock, mockFetch } from "./mock.ts";

export type {
  RouteDecision,
  DecisionSource,
  Telemetry,
  TurnInput,
  TurnState,
  SessionFacts,
} from "./types.ts";
export { USD_PER_INPUT_TOKEN } from "./types.ts";
