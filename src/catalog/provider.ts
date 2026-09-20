import type { Effort } from "./types.ts";

/**
 * Where the routed turn actually runs.
 *
 * ── Edit this file to make the router yours. ─────────────────────────────────
 * Two wire formats cover almost everything. `openai` plus a `baseURL` reaches
 * Groq, Together, OpenRouter, DeepSeek, Mistral, vLLM, LM Studio and Ollama,
 * because they all speak the same chat-completions shape.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The router itself does not know or care what is here — it decides a tier, and
 * `models.ts` says which id that tier means. This file is only consulted when something
 * runs the turn.
 */

export type ProviderKind = "anthropic" | "openai";

export interface ProviderConfig {
  readonly kind: ProviderKind;
  /** Defaults to the vendor's own. Point it anywhere that speaks the same shape. */
  readonly baseURL?: string;
  /** Environment variable holding the key. Never put the key itself in this file. */
  readonly apiKeyEnv: string;
  /** Cap on the reply. Reasoning budgets are set through `effortParams`. */
  readonly maxTokens?: number;
  /**
   * How the router's effort decision reaches the provider.
   *
   * This is the one place a tier and an effort become vendor-specific: Anthropic takes a
   * thinking budget in tokens, OpenAI takes a named reasoning effort, and most
   * OpenAI-compatible endpoints take neither and ignore both. Returning `{}` is a
   * perfectly good answer — the routed *model* still changes, which is most of the win.
   */
  readonly effortParams?: (effort: Effort) => Record<string, unknown>;
}

/** Anthropic's thinking budget, in tokens, per effort level. */
const ANTHROPIC_THINKING: Record<Effort, number> = {
  low: 0,
  medium: 2_000,
  high: 8_000,
  xhigh: 24_000,
};

export const PROVIDER = {
  kind: "anthropic",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  maxTokens: 4_096,
  effortParams: (effort) => {
    const budget = ANTHROPIC_THINKING[effort];
    // A thinking block needs headroom above the budget, or the request is rejected.
    return budget > 0
      ? { thinking: { type: "enabled", budget_tokens: budget }, max_tokens: budget + 4_096 }
      : {};
  },
} as const satisfies ProviderConfig;

/**
 * Swap the export above for one of these to move provider.
 *
 * ```ts
 * // OpenAI
 * export const PROVIDER = {
 *   kind: "openai",
 *   apiKeyEnv: "OPENAI_API_KEY",
 *   effortParams: (effort) => ({
 *     reasoning_effort: effort === "low" ? "low" : effort === "medium" ? "medium" : "high",
 *   }),
 * } as const satisfies ProviderConfig;
 *
 * // Groq, Together, OpenRouter, DeepSeek, Mistral — same shape, different host
 * export const PROVIDER = {
 *   kind: "openai",
 *   baseURL: "https://api.groq.com/openai",
 *   apiKeyEnv: "GROQ_API_KEY",
 * } as const satisfies ProviderConfig;
 *
 * // Ollama, LM Studio, vLLM — local, and the key is ignored
 * export const PROVIDER = {
 *   kind: "openai",
 *   baseURL: "http://localhost:11434",
 *   apiKeyEnv: "OLLAMA_API_KEY",
 * } as const satisfies ProviderConfig;
 * ```
 *
 * Whichever you pick, put the matching model ids in `models.ts`. Nothing validates that
 * a tier's id exists on the provider until you run a turn through it.
 */

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};
