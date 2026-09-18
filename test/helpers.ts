import type { Fetch, Questions } from "@typesafe-ai/sdk";
import { GATE_IDS, Q, gateId, toolId } from "../src/questions.ts";
import type { RouterAnswers } from "../src/questions.ts";
import { SKILL_IDS, TOOL_IDS, type SkillId, type ToolId } from "../src/catalog/index.ts";

/** Spreads `mass` over `winner` and the remaining labels, so probabilities sum to 1. */
export function distribution(
  labels: readonly string[],
  winner: string,
  mass: number,
): Record<string, number> {
  const rest = labels.filter((l) => l !== winner);
  const each = rest.length > 0 ? (1 - mass) / rest.length : 0;
  const out: Record<string, number> = { [winner]: mass };
  for (const l of rest) out[l] = each;
  return out;
}

/**
 * Gates closed by default: no action is being asked for, so no skill applies.
 * A test that wants a skill considered has to say so, the same way the model would.
 */
export const CLOSED_GATES: Record<(typeof GATE_IDS)[number], number> = {
  acts_on_system: 0.05,
  follows_procedure: 0.05,
  produces_artifact: 0.05,
  prose_suffices: 0.95,
};

/**
 * The canonical two-point distribution with expectation `score`.
 *
 * Policy reads a quantile of the distribution rather than the expectation, so a Score
 * answer without probabilities is not a Score answer. Tests that care about a bimodal
 * shape pass `probabilities` explicitly instead.
 */
export function scoreSpread(score: number): Record<string, number> {
  const floor = Math.floor(score);
  const frac = score - floor;
  return frac === 0 ? { [floor]: 1 } : { [floor]: 1 - frac, [floor + 1]: frac };
}

export interface AnswerSpec {
  difficulty?: number;
  /** Overrides `difficulty`'s implied spread, for testing bimodal answers. */
  difficultyProbabilities?: Record<string, number>;
  difficultyConfidence?: number;
  scope?: number;
  intent?: string;
  intentConfidence?: number;
  gates?: Partial<Record<(typeof GATE_IDS)[number], number>>;
  skill?: SkillId | "none";
  skillConfidence?: number;
  skillMass?: number;
  tools?: Partial<Record<ToolId, number>>;
  toolWhich?: ToolId | "none";
  toolWhichMass?: number;
  asked?: readonly ToolId[];
}

/** Builds a full, well-formed answer set so policy tests never depend on the network. */
export function answers(spec: AnswerSpec = {}): RouterAnswers {
  const asked = spec.asked ?? TOOL_IDS;
  const skillLabels = [...SKILL_IDS, "none"];
  const toolLabels = [...asked, "none"];

  const out: Record<string, unknown> = {
    [Q.difficulty]: {
      type: "score",
      score: spec.difficulty ?? 1,
      confidence: spec.difficultyConfidence ?? 0.9,
      legend: {},
      probabilities: spec.difficultyProbabilities ?? scoreSpread(spec.difficulty ?? 1),
    },
    [Q.scope]: {
      type: "score",
      score: spec.scope ?? 0,
      confidence: 0.9,
      legend: {},
      probabilities: scoreSpread(spec.scope ?? 0),
    },
    [Q.intent]: {
      type: "choice",
      choice: spec.intent ?? "explain",
      confidence: spec.intentConfidence ?? 0.9,
      probabilities: distribution(
        ["explain", "locate", "modify", "operate", "meta"],
        spec.intent ?? "explain",
        0.9,
      ),
    },
    [Q.skill]: {
      type: "choice",
      choice: spec.skill ?? "none",
      confidence: spec.skillConfidence ?? 0.9,
      probabilities: distribution(skillLabels, spec.skill ?? "none", spec.skillMass ?? 0.9),
    },
    [Q.toolWhich]: {
      type: "choice",
      choice: spec.toolWhich ?? "none",
      confidence: 0.8,
      probabilities: distribution(toolLabels, spec.toolWhich ?? "none", spec.toolWhichMass ?? 0.8),
    },
  };

  for (const id of GATE_IDS) {
    out[gateId(id)] = { type: "noul", noul: spec.gates?.[id] ?? CLOSED_GATES[id] };
  }
  for (const id of asked) {
    out[toolId(id)] = { type: "noul", noul: spec.tools?.[id] ?? 0 };
  }
  return out as unknown as RouterAnswers;
}

export interface FakeJevOptions {
  /** Milliseconds to stall before responding. Use to trip the router's deadline. */
  delayMs?: number;
  status?: number;
  /** Per-question-id overrides, by exact id. */
  answers?: Record<string, unknown>;
  /** Default probability for every `tool::*` and `gate::*` Noul. */
  noul?: number;
  /** Default expectation for every Score. */
  score?: number;
  /** Counts calls, so tests can assert on cache hits and second hops. */
  calls?: { n: number; bodies: unknown[] };
}

/**
 * A `fetch` that speaks the systemOne wire protocol.
 *
 * It reads the questions off the request and answers each one in its own shape, so the
 * router exercises its real parsing and policy paths with no key and no network.
 */
export function fakeJev(options: FakeJevOptions = {}): Fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      questions: Questions;
      state: unknown;
    };
    options.calls?.bodies.push(body);
    if (options.calls) options.calls.n += 1;

    if (options.delayMs) {
      // Deliberately ignores `init.signal`. This is the transport that hangs: a socket
      // that never answers and never notices the abort. The router's deadline has to
      // hold on its own against it, not by asking `fetch` nicely.
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.status && options.status >= 400) {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: options.status,
        headers: { "content-type": "application/json" },
      });
    }

    const out: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (options.answers && id in options.answers) {
        out[id] = options.answers[id];
        continue;
      }
      if (question.type === "noul") {
        out[id] = { type: "noul", noul: options.noul ?? 0 };
      } else if (question.type === "score") {
        const score = options.score ?? 0;
        out[id] = {
          type: "score",
          score,
          confidence: 0.9,
          legend: {},
          probabilities: scoreSpread(score),
        };
      } else {
        const labels = Object.keys(question.criteria);
        const winner = labels.includes("none") ? "none" : (labels[0] as string);
        out[id] = {
          type: "choice",
          choice: winner,
          confidence: 0.9,
          probabilities: distribution(labels, winner, 0.9),
        };
      }
    }

    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: out,
        usage: { input_tokens: 400, output_tokens: 60 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req_test" } },
    );
  };
}
