import type { CatalogSpec, Effort } from "../catalog/index.ts";
import { renderSkillBlock, type PromptOptions } from "../prompt.ts";
import type { RouteDecision } from "../types.ts";

/**
 * Turns a route into the per-call options of the Claude Agent SDK's `query()`.
 *
 * The SDK takes `model`, `effort`, the tool set and a system-prompt suffix per call, which
 * is exactly the four things the router decides. This module has no runtime dependency on
 * the SDK: it returns a plain object that is structurally an `Options`, and
 * `test/agent-sdk.test.ts` checks that against the SDK's own types.
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { createRouter, toQueryOptions } from "jev-harness-router";
 *
 * const route = await router.route({ message });
 * for await (const m of query({ prompt: message, options: { ...toQueryOptions(route), cwd } })) …
 * ```
 */

/** The SDK's own union, spelled out so this module does not import the SDK. */
export type AgentSdkEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentSdkOptions {
  /**
   * How the routed tool set reaches the SDK.
   *
   * - `restrict` (default): sets `tools`, so this turn's Claude Code has *only* the routed
   *   tools. An empty route disables built-in tools for the turn, which is what "no tool
   *   cleared its bar" means. Put anything that must always exist in `alwaysTools`.
   * - `allow`: sets `allowedTools`, so the routed tools run without a permission prompt and
   *   everything else stays available behind the SDK's normal permission flow.
   * - `none`: leaves tools alone.
   */
  readonly tools?: "restrict" | "allow" | "none";
  /** Tool names added to the routed set whatever the route said, e.g. `["Read", "Grep"]`. */
  readonly alwaysTools?: readonly string[];
  /**
   * Maps the router's effort ladder onto the SDK's. Same names by default; the SDK's
   * extra `max` is never produced unless you map something onto it.
   */
  readonly effort?: Partial<Record<Effort, AgentSdkEffort>>;
  /**
   * Appends the skill block to the `claude_code` preset system prompt, after everything
   * Claude Code puts there, so the cached prefix is untouched. Pass `PromptOptions` to
   * reword it, or `false` to leave the system prompt alone.
   */
  readonly skillBlock?: boolean | PromptOptions;
}

/**
 * Structurally a subset of the SDK's `Options`. Kept as its own type so a harness can
 * spread it into `query()` without this package depending on the SDK's version.
 */
export interface AgentSdkQueryOptions {
  readonly model: string;
  readonly effort: AgentSdkEffort;
  readonly tools?: string[];
  readonly allowedTools?: string[];
  readonly systemPrompt?: { type: "preset"; preset: "claude_code"; append: string };
}

/** Only the four decided fields are read, so any catalogue's route fits. */
export type RoutedTurn = Pick<RouteDecision<CatalogSpec>, "model" | "effort" | "tools" | "skill">;

export function toQueryOptions(route: RoutedTurn, options: AgentSdkOptions = {}): AgentSdkQueryOptions {
  const out: {
    model: string;
    effort: AgentSdkEffort;
    tools?: string[];
    allowedTools?: string[];
    systemPrompt?: NonNullable<AgentSdkQueryOptions["systemPrompt"]>;
  } = {
    model: route.model,
    effort: options.effort?.[route.effort] ?? route.effort,
  };

  const mode = options.tools ?? "restrict";
  if (mode !== "none") {
    const set = new Set<string>([...route.tools, ...(options.alwaysTools ?? [])]);
    const names = [...set];
    if (mode === "restrict") out.tools = names;
    else out.allowedTools = names;
  }

  const block = options.skillBlock ?? true;
  if (block !== false) {
    out.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: renderSkillBlock(route, block === true ? {} : block).trim(),
    };
  }

  return out;
}
