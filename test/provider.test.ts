import { describe, expect, it } from "vitest";
import { complete, MissingProviderKeyError, ProviderError } from "../src/provider.ts";
import type { CompleteRequest, ProviderConfig } from "../src/index.ts";

/**
 * The provider adapters, exercised with no key and no network.
 *
 * What matters here is not that a request is sent but what is in it: the cache
 * breakpoint sits on the stable half of the system prompt and the router's suggestion
 * lands after it, because getting that backwards costs more latency than the router
 * saves.
 */

const request: CompleteRequest = {
  model: "some-model",
  effort: "high",
  systemCached: "STABLE ROSTER",
  systemSuffix: "\n\n<skill_relevance>\nuse the thing\n</skill_relevance>",
  messages: [{ role: "user", content: "hola" }],
};

function capture(response: unknown, status = 200) {
  const seen: { url?: string; body?: Record<string, never>; headers?: Record<string, string> } = {};
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.body = JSON.parse(String(init?.body));
    seen.headers = init?.headers as Record<string, string>;
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, fetchImpl };
}

const ANTHROPIC_OK = {
  model: "claude-x",
  content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "  hola  " }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
};

const OPENAI_OK = {
  model: "gpt-x",
  choices: [{ message: { content: " hola " } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } },
};

describe("anthropic", () => {
  const config: ProviderConfig = {
    kind: "anthropic",
    apiKeyEnv: "TEST_KEY",
    effortParams: (effort) => (effort === "high" ? { thinking: { budget_tokens: 8000 } } : {}),
  };

  it("puts the cache breakpoint on the stable half and the suggestion after it", async () => {
    process.env.TEST_KEY = "k";
    const { seen, fetchImpl } = capture(ANTHROPIC_OK);
    await complete(request, config, fetchImpl);

    const system = seen.body?.system as unknown as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toBe("STABLE ROSTER");
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    // The volatile half must never carry a breakpoint, or every turn is a cache miss.
    expect(system[1]?.text).toContain("skill_relevance");
    expect(system[1]?.cache_control).toBeUndefined();
  });

  it("omits the second block entirely when there is nothing to append", async () => {
    process.env.TEST_KEY = "k";
    const { seen, fetchImpl } = capture(ANTHROPIC_OK);
    await complete({ ...request, systemSuffix: "  " }, config, fetchImpl);
    expect(seen.body?.system as unknown as unknown[]).toHaveLength(1);
  });

  it("passes the effort params the catalogue defines for that level", async () => {
    process.env.TEST_KEY = "k";
    const { seen, fetchImpl } = capture(ANTHROPIC_OK);
    await complete(request, config, fetchImpl);
    expect(seen.body?.thinking).toEqual({ budget_tokens: 8000 });

    const low = capture(ANTHROPIC_OK);
    await complete({ ...request, effort: "low" }, config, low.fetchImpl);
    expect(low.seen.body?.thinking).toBeUndefined();
  });

  it("reads text, usage and cache hits out of the reply", async () => {
    process.env.TEST_KEY = "k";
    const { fetchImpl } = capture(ANTHROPIC_OK);
    const reply = await complete(request, config, fetchImpl);
    // Thinking blocks are not the answer; only text is.
    expect(reply.text).toBe("hola");
    expect(reply.inputTokens).toBe(100);
    expect(reply.cachedTokens).toBe(80);
    expect(reply.model).toBe("claude-x");
  });
});

describe("openai and anything that speaks its shape", () => {
  const config: ProviderConfig = {
    kind: "openai",
    baseURL: "http://localhost:11434/",
    apiKeyEnv: "TEST_KEY",
  };

  it("honours a custom base URL, trailing slash and all", async () => {
    process.env.TEST_KEY = "k";
    const { seen, fetchImpl } = capture(OPENAI_OK);
    await complete(request, config, fetchImpl);
    expect(seen.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("keeps the suggestion last, since there is no breakpoint to place", async () => {
    process.env.TEST_KEY = "k";
    const { seen, fetchImpl } = capture(OPENAI_OK);
    await complete(request, config, fetchImpl);
    const messages = seen.body?.messages as unknown as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content.startsWith("STABLE ROSTER")).toBe(true);
    expect(messages[0]?.content.endsWith("</skill_relevance>")).toBe(true);
  });

  it("reads its own usage shape", async () => {
    process.env.TEST_KEY = "k";
    const { fetchImpl } = capture(OPENAI_OK);
    const reply = await complete(request, config, fetchImpl);
    expect(reply.text).toBe("hola");
    expect(reply.inputTokens).toBe(100);
    expect(reply.cachedTokens).toBe(80);
  });
});

describe("failures say what to do about them", () => {
  it("names the environment variable when the key is missing", async () => {
    delete process.env.ABSENT_KEY;
    await expect(
      complete(request, { kind: "openai", apiKeyEnv: "ABSENT_KEY" }, async () => new Response("")),
    ).rejects.toThrow(MissingProviderKeyError);
  });

  it("surfaces the provider's own status and body", async () => {
    process.env.TEST_KEY = "k";
    const { fetchImpl } = capture({ error: "no such model" }, 404);
    const failure = complete(request, { kind: "openai", apiKeyEnv: "TEST_KEY" }, fetchImpl);
    await expect(failure).rejects.toThrow(ProviderError);
    await expect(failure).rejects.toThrow(/404/);
  });
});
