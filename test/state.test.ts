import { describe, expect, it } from "vitest";
import {
  CONTEXT_MAX_CHARS,
  MESSAGE_MAX_CHARS,
  MAX_OPEN_FILES,
  availableTools,
  buildState,
  truncate,
} from "../src/state.ts";
import { TOOL_IDS } from "../src/catalog/index.ts";
import { heuristicRoute, isShortcut } from "../src/heuristic.ts";
import { cacheKey } from "../src/cache.ts";

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("  hola  ", 100)).toBe("hola");
  });

  it("keeps the head and the tail, where the intent lives", () => {
    const text = `START${"x".repeat(500)}END`;
    const out = truncate(text, 50);
    expect(out.length).toBeLessThanOrEqual(56);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
  });
});

describe("buildState", () => {
  it("stays small, because state size is the lever on both latency and accuracy", () => {
    const state = buildState({
      message: "x".repeat(10_000),
      recentContext: "y".repeat(10_000),
      session: { openFiles: Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`) },
    });

    expect(state.latest_user_message.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS + 8);
    expect(state.recent_context.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS + 8);
    expect((state.session.open_files as string[]).length).toBe(MAX_OPEN_FILES);
    expect(JSON.stringify(state).length).toBeLessThan(3_000);
  });

  it("omits session keys it has no fact for, rather than sending nulls", () => {
    const state = buildState({ message: "hola" });
    expect(state.session).toEqual({});
    expect(state.recent_context).toBe("");
  });

  it("passes through facts the harness already knows", () => {
    const state = buildState({
      message: "seguí",
      session: { turnIndex: 0, cwdKind: "node", lastTier: "deep" },
    });
    expect(state.session.turn_index).toBe(0);
    expect(state.session.is_first_turn).toBe(true);
    expect(state.session.previous_turn_model_tier).toBe("deep");
  });
});

describe("availableTools", () => {
  it("returns the whole catalogue when nothing is blocked", () => {
    expect(availableTools({ message: "hi" })).toEqual(TOOL_IDS);
  });

  it("removes blocked tools entirely", () => {
    const tools = availableTools({
      message: "hi",
      session: { unavailableTools: ["Bash", "Write"] },
    });
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools.length).toBe(TOOL_IDS.length - 2);
  });
});

describe("cacheKey", () => {
  it("is stable for the same state and different for a changed one", () => {
    const a = buildState({ message: "hola" });
    const b = buildState({ message: "hola" });
    const c = buildState({ message: "hola!" });
    expect(cacheKey(a)).toBe(cacheKey(b));
    expect(cacheKey(a)).not.toBe(cacheKey(c));
  });
});

describe("the heuristic baseline", () => {
  it("recognises the turns that need no model at all", () => {
    for (const message of ["/pr", "dale", "ok", "", "   ", "gracias"]) {
      expect(isShortcut({ message })).toBe(true);
    }
    for (const message of ["arreglá el login", "dale para adelante con el refactor"]) {
      expect(isShortcut({ message })).toBe(false);
    }
  });

  it("is a real baseline, not a strawman: it gets the easy cases right", () => {
    expect(heuristicRoute({ message: "commiteá los cambios" }).skill).toBe("ita-commit");
    expect(heuristicRoute({ message: "qué tengo en el trello" }).skill).toBe("trello-cli");
    expect(heuristicRoute({ message: "corré los tests" }).tools).toContain("Bash");
    expect(heuristicRoute({ message: "dónde está definido useAuth" }).tools).toContain("Grep");
  });

  it("reaches for the deep tier on open-ended work", () => {
    expect(heuristicRoute({ message: "hacé un refactor del módulo de billing" }).tier).toBe("deep");
    expect(heuristicRoute({ message: "cuánto es 2+2" }).tier).toBe("fast");
  });

  it("respects unavailable tools", () => {
    const route = heuristicRoute({
      message: "corré los tests",
      session: { unavailableTools: ["Bash"] },
    });
    expect(route.tools).not.toContain("Bash");
  });
});
