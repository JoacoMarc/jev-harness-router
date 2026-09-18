import type { RouteDecision } from "./types.ts";

/**
 * Renders the router's decision for the downstream model.
 *
 * ── Edit the defaults below to make the router yours. ────────────────────────
 * The tag name and both sentences are the shipped wording, copied from the
 * skill-suggestion cookbook. Override them per call, or change them here.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This block is **appended after** the harness's cached system-prompt prefix, never
 * spliced into it. The cookbook is explicit about why: the roster text has to be
 * byte-identical on every turn or the downstream model's prefix cache misses, and that
 * miss costs far more latency than the router ever saved. That mechanism is not specific
 * to any one provider — anything that caches a prompt prefix behaves this way.
 *
 * The wording is measured, not decorative. It says the suggestion can be ignored,
 * because pushing harder also wins compliance on the wrong suggestions, and a wrong
 * suggestion is worse than none. A turn with nothing to suggest still emits a sentence
 * saying so, rather than nothing at all, so the harness's own "when in doubt, load it"
 * instruction is not left unopposed. Both of those are worth keeping if you reword this.
 */
export interface PromptOptions {
  /** XML-ish tag wrapping the block. */
  readonly tag?: string;
  /** How to announce a chosen skill. Keep the permission to ignore it. */
  readonly suggest?: (skill: string) => string;
  /** What to say when nothing applies. Keep saying something. */
  readonly none?: string;
}

export const DEFAULT_PROMPT_OPTIONS: Required<PromptOptions> = {
  tag: "skill_relevance",
  suggest: (skill) =>
    `Relevant to the current request: ${skill}. Ignore this if it does not fit what the user actually asked for.`,
  none: "No skill in the roster appears relevant to this request.",
};

export function renderSkillBlock(
  decision: Pick<RouteDecision, "skill">,
  options: PromptOptions = {},
): string {
  const { tag, suggest, none } = { ...DEFAULT_PROMPT_OPTIONS, ...options };
  const body = decision.skill ? suggest(decision.skill) : none;
  return `\n\n<${tag}>\n${body}\n</${tag}>`;
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
  options: PromptOptions = {},
): { cached: string; suffix: string } {
  return { cached: roster, suffix: renderSkillBlock(decision, options) };
}
