import { choice, noul, score } from "@typesafe-ai/sdk";
import type {
  ChoiceQuestion,
  Description,
  NoulQuestion,
  ScoreQuestion,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import {
  NO_SKILL,
  SKILLS,
  SKILL_IDS,
  TOOLS,
  type SkillId,
  type ToolId,
} from "./catalog/index.ts";

/**
 * Every question the router asks, built from the catalogues.
 *
 * Pure: no client, no network, no environment. `test/questions.test.ts` asserts the
 * shape of what goes on the wire without an API key.
 *
 * Question ids are namespaced (`turn::`, `gate::`, `tool::`, `skill::`) so the policy
 * can slice answers by prefix instead of keeping a lookup table. The ids themselves are
 * never sent to the model — all the meaning has to live in `instructions`.
 */

// ---------------------------------------------------------------- ids

export const GATE_IDS = [
  "acts_on_system",
  "follows_procedure",
  "produces_artifact",
  "prose_suffices",
] as const;
export type GateId = (typeof GATE_IDS)[number];

/**
 * A yes here points away from needing a skill, so the policy folds it in as `1 - v`.
 *
 * The inversion happens to the value, in code. The question itself is still phrased
 * the natural way round — `jev-1.13` does worse on a Noul whose `true` means "no".
 */
export const INVERTED_GATES: ReadonlySet<GateId> = new Set<GateId>(["prose_suffices"]);

export const Q = {
  difficulty: "turn::difficulty",
  scope: "turn::scope",
  intent: "turn::intent",
  skill: "skill::which",
  toolWhich: "tool::which",
} as const;

export const gateId = <T extends GateId>(id: T): `gate::${T}` => `gate::${id}`;
export const toolId = <T extends ToolId>(id: T): `tool::${T}` => `tool::${id}`;

// ---------------------------------------------------------------- rubrics

/**
 * Levels describe situations, not degrees.
 *
 * The model never sees a level's number or its neighbours — each is judged on its own
 * against the state, so "harder than the previous one" means nothing and bare numerals
 * measurably wreck the answer.
 */
export const DIFFICULTY_LEVELS = [
  "Answerable in a sentence or two from what is already in front of the assistant: a definition, a yes or no, a restatement, or acknowledging what was just said.",
  "One self-contained step: change a file the user named, look up where something is defined, or run a command the user already spelled out.",
  "Several steps that depend on each other across a handful of files: build a feature, trace a bug from its symptom, or connect two parts of the system.",
  "The shape of the work has to be figured out before any of it can be done: a cross-cutting change, a design decision with real trade-offs, or a problem whose cause nobody has identified yet.",
] as const;

export const SCOPE_LEVELS = [
  "Everything needed to answer is already in the message itself.",
  "One file, or a few specific files that the message names or that are easy to find.",
  "Many files across the project, or parts of it that nobody has named yet and have to be discovered first.",
] as const;

export const INTENT_CRITERIA = {
  explain:
    "The user wants to understand something. Correct when a good answer is words, and nothing in the project changes.",
  locate:
    "The user wants to know where something lives, or whether it exists at all. Correct when the answer is a pointer into the codebase.",
  modify:
    "The user wants code, config or files changed. Correct whenever the turn should end with the project different from how it started.",
  operate:
    "The user wants a command or an outside service driven: build, test, deploy, git, a ticket board, an API.",
  meta: "The user is steering the session rather than the work: undo that, try the other approach, stop, keep going.",
} as const;

/**
 * The request-shape gates. Three come from the skill-suggestion cookbook, where they cut
 * wrong skill loads from 16.8% to 7.3%; the fourth was added after measuring.
 *
 * They ask whether an action is wanted. A question about subject matter would not
 * separate "explain what a monad is" from a request that genuinely needs a skill,
 * because both of them are software.
 *
 * `produces_artifact` exists because the cookbook's roster is all doing-skills, and this
 * one is not. The first eval showed the original trio suppressing `architecture`,
 * `system-design` and `testing-strategy` on turns where the ranking had already named
 * them at confidence 0.99 — writing an ADR acts on nothing and follows no command list,
 * so all three probes read low. The missing question is whether the turn wants a work
 * product built by a known method, as opposed to an explanation.
 */
export const GATE_QUESTIONS: Record<GateId, string> = {
  acts_on_system:
    "Is the assistant being asked to act on the user's files, repository, accounts or services, rather than only to explain or advise?",
  follows_procedure:
    "Would a careful expert answering this consult a specific documented procedure, checklist or set of commands, rather than answering from general understanding?",
  produces_artifact:
    "Is the assistant being asked to produce a structured work product — a design, a decision record, a plan, a review, a written document — rather than simply answer a question?",
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose alone, with no tools, no documentation, and no access to the user's files or accounts?",
};

// ---------------------------------------------------------------- criteria maps

export type SkillCriteria = Record<SkillId | typeof NO_SKILL, Description>;
export type ToolCriteria = Record<ToolId | typeof NO_SKILL, string>;

const NO_SKILL_DESCRIPTION =
  "No skill in this catalogue does the specific thing the request asks for, so the assistant should handle the turn directly.";

/** Lowercases the leading character so a card reads as a verb phrase mid-sentence. */
function asPhrase(sentence: string): string {
  const trimmed = sentence.trim().replace(/\.$/, "");
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Skill option descriptions.
 *
 * `structured` swaps each string for a `what` / `not_for` / `examples` object. The docs
 * recommend that shape for confusable options but publish no measurement of it, so this
 * was built as an A/B rather than a default. The A/B then came back decisive, and it is
 * now the default: 94.4% skill accuracy against 92.6%, and 0% of covered turns missed
 * against 4%, at the same false-positive rate.
 *
 * It costs 24% more input tokens (3,244 -> 4,015) and no measurable time — 20 turns each
 * way came out at p50 322ms for strings and 329ms for objects. That is the same result
 * the token probe gives: this request's latency is network, not payload.
 */
export function skillCriteria(structured = true): SkillCriteria {
  const out: Record<string, Description> = {};
  for (const id of SKILL_IDS) {
    const card = SKILLS[id];
    const notFor = "notFor" in card ? card.notFor : undefined;
    const examples = "examples" in card ? card.examples : undefined;
    if (!structured) {
      out[id] = notFor ? `${card.description} Not for: ${notFor}` : card.description;
      continue;
    }
    const entry: Record<string, Description> = { what: card.description };
    if (notFor) entry.not_for = notFor;
    if (examples) entry.examples = [...examples];
    out[id] = entry;
  }
  out[NO_SKILL] = structured ? { what: NO_SKILL_DESCRIPTION } : NO_SKILL_DESCRIPTION;
  return out as SkillCriteria;
}

export function toolCriteria(tools: readonly ToolId[]): ToolCriteria {
  const out: Record<string, string> = {};
  for (const id of tools) out[id] = TOOLS[id].description;
  out[NO_SKILL] = "The turn can be handled without reaching for any tool at all.";
  return out as ToolCriteria;
}

// ---------------------------------------------------------------- the question set

export type RouterQuestions = {
  [Q.difficulty]: ScoreQuestion<typeof DIFFICULTY_LEVELS>;
  [Q.scope]: ScoreQuestion<typeof SCOPE_LEVELS>;
  [Q.intent]: ChoiceQuestion<typeof INTENT_CRITERIA>;
  [Q.skill]: ChoiceQuestion<SkillCriteria>;
  [Q.toolWhich]: ChoiceQuestion<ToolCriteria>;
} & { [K in GateId as `gate::${K}`]: NoulQuestion } & {
  [K in ToolId as `tool::${K}`]: NoulQuestion;
};

export type RouterAnswers = SystemOneResult<RouterQuestions>["answers"];

export interface BuildOptions {
  /** Objects for skill options instead of strings. Defaults to true; measurably better. */
  readonly structuredSkillCriteria?: boolean;
}

/**
 * One request's worth of questions.
 *
 * All of them are independent and evaluated in parallel against one shared state, so a
 * question the policy may not read costs tokens but essentially no time. That is what
 * buys the whole four-way decision in a single round trip.
 *
 * The mapped types above promise a key for every `ToolId`; a caller that filters `tools`
 * gets fewer at runtime. That is the right upper bound for an answer — whatever comes
 * back is one of the tools that were offered — and `policy.ts` only ever reads the keys
 * it asked for.
 */
export function buildQuestions(
  tools: readonly ToolId[],
  options: BuildOptions = {},
): RouterQuestions {
  const questions: Record<string, unknown> = {
    [Q.difficulty]: score(
      "How much work is it to fully handle `latest_user_message`, read together with `recent_context`?",
      DIFFICULTY_LEVELS,
    ),
    [Q.scope]: score(
      "How much of the project has to be read or understood to handle `latest_user_message`?",
      SCOPE_LEVELS,
    ),
    [Q.intent]: choice(
      "What is the user trying to get done in `latest_user_message`?",
      INTENT_CRITERIA,
    ),
    [Q.skill]: choice(
      "Which of these skills, if any, is the right one to load to help with `latest_user_message`?",
      skillCriteria(options.structuredSkillCriteria ?? true),
    ),
    [Q.toolWhich]: choice(
      "Which single one of these capabilities is most central to handling `latest_user_message`?",
      toolCriteria(tools),
    ),
  };

  for (const id of GATE_IDS) questions[gateId(id)] = noul(GATE_QUESTIONS[id]);

  for (const id of tools) {
    questions[toolId(id)] = noul(
      `To handle \`latest_user_message\`, will the assistant have to ${asPhrase(TOOLS[id].description)}?`,
      {
        true: "Completing the turn requires doing this.",
        false:
          "The turn can be completed without doing this. The subject merely coming up in the message is not enough.",
      },
    );
  }

  return questions as RouterQuestions;
}

/** Question count for a tool set, without building the request. Used by the bench. */
export function questionCount(tools: readonly ToolId[]): number {
  return 5 + GATE_IDS.length + tools.length;
}

// ---------------------------------------------------------------- second hop

/**
 * The optional rerank pass.
 *
 * The skill-suggestion cookbook's measured win needs two calls: rank everything cheaply,
 * then read the finalists properly. But its own examples show the second call is wasted
 * when the ranking is already decisive (0.99 against 0.01) and decisive when it is not
 * (0.70 against 0.30, where it flipped the answer). So the router gates this on the
 * margin rather than paying for it every turn, and only inside whatever is left of the
 * deadline.
 *
 * The Choice settles *which* skill. The per-candidate Nouls are absolute and can all come
 * back low, which is how the shortlist gets rejected wholesale.
 */
export const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for `latest_user_message`. Which one? Read what each actually does, not just its name.";

export const fitsId = <T extends SkillId>(id: T): `fits::${T}` => `fits::${id}`;

export type RerankQuestions = {
  [Q.skill]: ChoiceQuestion<Record<SkillId | typeof NO_SKILL, Description>>;
} & { [K in SkillId as `fits::${K}`]: NoulQuestion };

export type RerankAnswers = SystemOneResult<RerankQuestions>["answers"];

/** The fuller description a finalist earns on the second pass. */
function detailed(id: SkillId): string {
  const card = SKILLS[id];
  const notFor = "notFor" in card ? ` Not for: ${card.notFor}` : "";
  const examples =
    "examples" in card && card.examples
      ? ` Requests like: ${card.examples.map((e) => `"${e}"`).join("; ")}.`
      : "";
  return `${card.description}${notFor}${examples}`;
}

export function buildRerankQuestions(names: readonly SkillId[]): RerankQuestions {
  const criteria: Record<string, string> = {};
  for (const id of names) criteria[id] = detailed(id);
  criteria[NO_SKILL] = NO_SKILL_DESCRIPTION;

  const questions: Record<string, unknown> = {
    [Q.skill]: choice(RERANK_INSTRUCTIONS, criteria),
  };
  for (const id of names) {
    questions[fitsId(id)] = noul(
      `Does the skill "${id}" do the specific thing \`latest_user_message\` asks for? It is described as: ${SKILLS[id].description}`,
    );
  }
  return questions as RerankQuestions;
}
