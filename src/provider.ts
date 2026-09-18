import { performance } from "node:perf_hooks";
import { DEFAULT_BASE_URL, PROVIDER, type ProviderConfig } from "./catalog/provider.ts";
import type { Effort } from "./catalog/index.ts";

/**
 * The only module that talks to the model provider.
 *
 * Plain `fetch` against two wire formats, because that is all it takes and the
 * alternative is a dependency per vendor. Everything above this consumes a `Reply`.
 *
 * **This runs the turn. It does not run tools.** The router decides which tools a turn
 * should have, and a real harness turns that into tool definitions and an execute loop.
 * Doing that here would mean a demo that runs model-chosen shell commands on your
 * machine, which is not something to ship as an example. The decision is reported; the
 * execution is yours.
 */

export interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CompleteRequest {
  readonly model: string;
  readonly effort: Effort;
  /** Split so the stable half can carry a cache breakpoint and the volatile half cannot. */
  readonly systemCached: string;
  readonly systemSuffix: string;
  readonly messages: readonly Message[];
}

export interface Reply {
  readonly text: string;
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served from the provider's prompt cache, when it reports them. */
  readonly cachedTokens: number;
  readonly model: string;
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class MissingProviderKeyError extends Error {
  constructor(envName: string) {
    super(
      `${envName} is not set. Put it in .env (see .env.example).\n` +
        `Change provider in src/catalog/provider.ts — the file lists the common ones.`,
    );
    this.name = "MissingProviderKeyError";
  }
}

export function providerKey(config: ProviderConfig = PROVIDER): string {
  const key = process.env[config.apiKeyEnv];
  if (!key) throw new MissingProviderKeyError(config.apiKeyEnv);
  return key;
}

export function hasProviderKey(config: ProviderConfig = PROVIDER): boolean {
  return Boolean(process.env[config.apiKeyEnv]);
}

const baseURL = (c: ProviderConfig): string =>
  (c.baseURL ?? DEFAULT_BASE_URL[c.kind]).replace(/\/+$/, "");

/** Injected in tests, so both wire formats are covered with no key and no network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function complete(
  request: CompleteRequest,
  config: ProviderConfig = PROVIDER,
  fetchImpl: FetchLike = fetch,
): Promise<Reply> {
  const key = providerKey(config);
  const extra = config.effortParams?.(request.effort) ?? {};
  const started = performance.now();

  const { url, headers, body } =
    config.kind === "anthropic"
      ? anthropicCall(request, config, key, extra)
      : openaiCall(request, config, key, extra);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - started;

  if (!response.ok) {
    throw new ProviderError(response.status, `${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const json = (await response.json()) as Record<string, never>;
  return config.kind === "anthropic" ? anthropicReply(json, ms) : openaiReply(json, ms);
}

// ---------------------------------------------------------------- anthropic

function anthropicCall(
  r: CompleteRequest,
  c: ProviderConfig,
  key: string,
  extra: Record<string, unknown>,
) {
  return {
    url: `${baseURL(c)}/v1/messages`,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: {
      model: r.model,
      max_tokens: c.maxTokens ?? 4_096,
      // Two blocks, and the breakpoint sits on the first. The router's suggestion goes
      // after it so the stable half stays byte-identical and keeps hitting the cache —
      // the single easiest way to lose more latency than the router ever saved.
      system: [
        { type: "text", text: r.systemCached, cache_control: { type: "ephemeral" } },
        ...(r.systemSuffix.trim() ? [{ type: "text", text: r.systemSuffix }] : []),
      ],
      messages: r.messages.map((m) => ({ role: m.role, content: m.content })),
      ...extra,
    },
  };
}

function anthropicReply(json: Record<string, never>, ms: number): Reply {
  const content = (json.content as unknown as { type: string; text?: string }[]) ?? [];
  const usage = (json.usage as unknown as Record<string, number>) ?? {};
  return {
    text: content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim(),
    ms,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedTokens: usage.cache_read_input_tokens ?? 0,
    model: (json.model as unknown as string) ?? "",
  };
}

// ---------------------------------------------------------------- openai and friends

function openaiCall(
  r: CompleteRequest,
  c: ProviderConfig,
  key: string,
  extra: Record<string, unknown>,
) {
  // No breakpoint to place: these endpoints cache the prefix automatically or not at
  // all. Keeping the suffix last still matters — a stable prefix is what gets cached.
  const system = `${r.systemCached}${r.systemSuffix}`;
  return {
    url: `${baseURL(c)}/v1/chat/completions`,
    headers: { authorization: `Bearer ${key}` },
    body: {
      model: r.model,
      max_tokens: c.maxTokens ?? 4_096,
      messages: [
        { role: "system", content: system },
        ...r.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...extra,
    },
  };
}

function openaiReply(json: Record<string, never>, ms: number): Reply {
  const choices = (json.choices as unknown as { message?: { content?: string } }[]) ?? [];
  const usage = (json.usage as unknown as Record<string, number>) ?? {};
  const details = (json.usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
    ?.prompt_tokens_details;
  return {
    text: (choices[0]?.message?.content ?? "").trim(),
    ms,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedTokens: details?.cached_tokens ?? 0,
    model: (json.model as unknown as string) ?? "",
  };
}
