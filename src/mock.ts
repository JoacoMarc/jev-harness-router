import type { Fetch, Questions } from "@typesafe-ai/sdk";
import {
  DEFAULT_CATALOG,
  NO_SKILL,
  type Catalog,
  type CatalogSpec,
  type DefaultCatalogSpec,
} from "./catalog/index.ts";
import { heuristicRoute } from "./heuristic.ts";
import { Q, gateId } from "./questions.ts";

/**
 * A stand-in for the API, driven by the heuristic.
 *
 * `MOCK=1` everywhere in this project means the same thing it means in the reference
 * projects: the CLI runs with no key, and says so. It exists so the wiring can be
 * exercised offline, and it is never a substitute for a measurement — the numbers a
 * mocked bench prints are the mock's numbers, which is why every entry point labels the
 * mode loudly.
 */

/** Roughly what a real round trip costs, so a mocked bench is not misleadingly instant. */
export const MOCK_LATENCY_MS = 120;

export function isMock(): boolean {
  return process.env.MOCK === "1";
}

function spread(labels: readonly string[], winner: string, mass: number): Record<string, number> {
  const rest = labels.filter((l) => l !== winner);
  const each = rest.length > 0 ? (1 - mass) / rest.length : 0;
  const out: Record<string, number> = { [winner]: mass };
  for (const l of rest) out[l] = each;
  return out;
}

/** Answers from the heuristic over `catalog`, which must be the one the router asks with. */
export function mockFetch<C extends CatalogSpec = DefaultCatalogSpec>(
  catalog: Catalog<C> = DEFAULT_CATALOG as unknown as Catalog<C>,
): Fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      questions: Questions;
      state: { latest_user_message?: string; recent_context?: string };
    };
    const message = body.state.latest_user_message ?? "";
    const guess = heuristicRoute({ message, recentContext: body.state.recent_context ?? "" }, catalog);
    const selected = new Set<string>(guess.tools);
    const tierIndex = catalog.tierIndex(guess.tier);

    await new Promise((resolve) =>
      setTimeout(resolve, MOCK_LATENCY_MS + Math.floor(Math.random() * 60)),
    );

    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "noul") {
        if (id.startsWith("tool::")) {
          const tool = id.slice("tool::".length);
          answers[id] = { type: "noul", noul: selected.has(tool) ? 0.92 : 0.06 };
        } else if (id === gateId("prose_suffices")) {
          answers[id] = { type: "noul", noul: guess.skill || selected.size ? 0.1 : 0.9 };
        } else if (id.startsWith("gate::")) {
          answers[id] = { type: "noul", noul: guess.skill ? 0.85 : selected.size ? 0.5 : 0.1 };
        } else {
          answers[id] = { type: "noul", noul: guess.skill ? 0.8 : 0.2 };
        }
        continue;
      }
      if (question.type === "score") {
        const score = id === Q.scope ? Math.min(tierIndex, 2) : tierIndex * 1.3;
        // Policy reads the distribution, not the expectation, so give it one.
        answers[id] = {
          type: "score",
          score,
          confidence: 0.82,
          legend: {},
          probabilities: { [String(Math.round(score))]: 1 },
        };
        continue;
      }

      const labels = Object.keys(question.criteria);
      let winner = labels.includes(NO_SKILL) ? NO_SKILL : (labels[0] as string);
      if (id === Q.skill && guess.skill && labels.includes(guess.skill)) winner = guess.skill;
      if (id === Q.toolWhich) {
        const first = guess.tools.find((t) => labels.includes(t));
        if (first) winner = first;
      }
      if (id === Q.intent) winner = selected.has("Edit") || selected.has("Write") ? "modify" : "explain";
      answers[id] = {
        type: "choice",
        choice: winner,
        confidence: 0.78,
        probabilities: spread(labels, winner, 0.78),
      };
    }

    return new Response(
      JSON.stringify({
        model: "mock",
        answers,
        usage: { input_tokens: Math.round(JSON.stringify(body).length / 4), output_tokens: 40 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
