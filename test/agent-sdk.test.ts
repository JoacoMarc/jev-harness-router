import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, expectTypeOf, it } from "vitest";
import { toQueryOptions, type AgentSdkQueryOptions } from "../src/adapters/agent-sdk.ts";
import { createRouter } from "../src/router.ts";
import { fakeJev } from "./helpers.ts";

/**
 * The adapter has no runtime dependency on the SDK, so the only thing that keeps it
 * honest is this: whatever it returns must spread into `query({ options })` unchanged.
 */
describe("toQueryOptions", () => {
  it("is structurally an Agent SDK Options object", () => {
    expectTypeOf<AgentSdkQueryOptions>().toMatchTypeOf<Options>();
  });

  it("carries the four decisions across", () => {
    const out = toQueryOptions({
      model: "claude-sonnet-5",
      effort: "high",
      tools: ["Read", "Edit"],
      skill: "debug",
    });
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.effort).toBe("high");
    expect(out.tools).toEqual(["Read", "Edit"]);
    expect(out.allowedTools).toBeUndefined();
    expect(out.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(out.systemPrompt?.append).toContain("debug");
    expect(out.systemPrompt?.append).toMatch(/Ignore this if it does not fit/);
  });

  it("restricts to an empty tool set when nothing cleared its bar", () => {
    // `tools: []` disables built-in tools for the turn in the SDK, which is what the
    // route said. `alwaysTools` is the escape hatch, not a silent default.
    const bare = toQueryOptions({ model: "m", effort: "low", tools: [], skill: null });
    expect(bare.tools).toEqual([]);
    const kept = toQueryOptions(
      { model: "m", effort: "low", tools: [], skill: null },
      { alwaysTools: ["Read"] },
    );
    expect(kept.tools).toEqual(["Read"]);
  });

  it("can auto-allow instead of restrict, or leave tools alone", () => {
    const route = { model: "m", effort: "medium" as const, tools: ["Bash"], skill: null };
    expect(toQueryOptions(route, { tools: "allow" })).toMatchObject({ allowedTools: ["Bash"] });
    expect(toQueryOptions(route, { tools: "allow" }).tools).toBeUndefined();
    const none = toQueryOptions(route, { tools: "none" });
    expect(none.tools).toBeUndefined();
    expect(none.allowedTools).toBeUndefined();
  });

  it("does not duplicate a tool that is both routed and always on", () => {
    const out = toQueryOptions(
      { model: "m", effort: "low", tools: ["Read", "Grep"], skill: null },
      { alwaysTools: ["Read"] },
    );
    expect(out.tools).toEqual(["Read", "Grep"]);
  });

  it("remaps effort when asked, and never invents max on its own", () => {
    const route = { model: "m", effort: "xhigh" as const, tools: [], skill: null };
    expect(toQueryOptions(route).effort).toBe("xhigh");
    expect(toQueryOptions(route, { effort: { xhigh: "max" } }).effort).toBe("max");
  });

  it("still says something when no skill applies, and can be switched off", () => {
    const route = { model: "m", effort: "low" as const, tools: [], skill: null };
    expect(toQueryOptions(route).systemPrompt?.append).toMatch(/No skill in the roster/);
    expect(toQueryOptions(route, { skillBlock: false }).systemPrompt).toBeUndefined();
    expect(toQueryOptions(route, { skillBlock: { tag: "hint" } }).systemPrompt?.append).toContain("<hint>");
  });

  it("takes a real route from the router, on any catalogue", async () => {
    const router = createRouter({
      catalog: {
        models: [{ tier: "only", id: "claude-haiku-4-5", label: "H", use: "all" }],
        tools: { Read: { description: "Open a file.", risk: "read" } },
        skills: {},
      },
      fetch: fakeJev({ noul: 0.9 }),
    });
    const route = await router.route({ message: "leé el archivo" });
    const out = toQueryOptions(route);
    expect(out.model).toBe("claude-haiku-4-5");
    expect(out.tools).toEqual(["Read"]);
  });
});
