import type { RouteDecision } from "./types.ts";

/**
 * Renders the router's decision for the downstream model.
 *
 * This block is **appended after** the harness's cached system-prompt prefix, never
 * spliced into it. The skill-suggestion cookbook is explicit about why: the roster text
 * has to be byte-identical on every turn or the downstream model's prefix cache misses,
 * and that miss costs far more latency than the router ever saved.
 *
 * The wording is measured, not decorative. It says the suggestion can be ignored,
 * because pushing harder also wins compliance on the wrong suggestions, and a wrong
 * suggestion is worse than none. A turn with nothing to suggest still emits a sentence
 * saying so, rather than nothing at all, so the harness's own "when in doubt, load it"
 * instruction is not left unopposed.
 */
export function renderSkillBlock(decision: Pick<RouteDecision, "skill">): string {
  const body = decision.skill
    ? `Relevant to the current request: ${decision.skill}. Ignore this if it does not fit what the user actually asked for.`
    : "No skill in the roster appears relevant to this request.";
  return `\n\n<skill_relevance>\n${body}\n</skill_relevance>`;
}

/**
 * Splits a system prompt into the part that carries the cache breakpoint and the part
 * that changes every turn. The caller marks `cached` as cacheable and appends `suffix`
 * after it.
 *
 * Only the skill lands in the prompt. Tier, effort and the tool set are harness
 * parameters, not text — they go in the request, so they cost the prefix nothing.
 */
export function systemPromptParts(
  roster: string,
  decision: Pick<RouteDecision, "skill">,
): { cached: string; suffix: string } {
  return { cached: roster, suffix: renderSkillBlock(decision) };
}
