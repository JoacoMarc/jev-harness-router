import { describe, expect, it } from "vitest";
import { MIN_RERANK_MS, createRouter } from "../src/router.ts";
import { DEFAULT_THRESHOLDS } from "../src/policy.ts";
import { Q, gateId } from "../src/questions.ts";
import { renderSkillBlock, systemPromptParts } from "../src/prompt.ts";
import { EFFORTS, TIERS } from "../src/catalog/index.ts";
import { distribution, fakeJev } from "./helpers.ts";

const gatesOpen = {
  [gateId("acts_on_system")]: { type: "noul", noul: 0.95 },
  [gateId("follows_procedure")]: { type: "noul", noul: 0.9 },
  [gateId("produces_artifact")]: { type: "noul", noul: 0.9 },
  [gateId("prose_suffices")]: { type: "noul", noul: 0.05 },
};

describe("lane 1: the shortcut", () => {
  it("answers a slash command without touching the network", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ calls }) });
    const route = await router.route({ message: "/commit" });

    expect(calls.n).toBe(0);
    expect(route.source).toBe("shortcut");
    expect(route.tier).toBe("fast");
    expect(route.tools).toEqual([]);
    expect(route.telemetry.jevMs).toBe(0);
  });

  it("answers a bare continuation the same way, in Spanish or English", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ calls }) });
    for (const message of ["dale", "ok", "Sí", "gracias!", "  "]) {
      const route = await router.route({ message });
      expect(route.source).toBe("shortcut");
    }
    expect(calls.n).toBe(0);
  });
});

describe("lane 2: the cache", () => {
  it("serves an identical turn without a second call", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ calls }) });
    const input = { message: "where is the auth middleware defined?" };

    const first = await router.route(input);
    const second = await router.route(input);

    expect(calls.n).toBe(1);
    expect(first.source).toBe("jev");
    expect(second.source).toBe("cache");
    expect(second.tier).toBe(first.tier);
    expect(second.telemetry.jevMs).toBe(0);
  });

  it("does not confuse two different turns", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ calls }) });
    await router.route({ message: "first question about the parser" });
    await router.route({ message: "second, unrelated question about the parser" });
    expect(calls.n).toBe(2);
  });
});

describe("lane 3: Jev, and the deadline behind it", () => {
  it("routes from real answers and reports its telemetry", async () => {
    const router = createRouter({
      fetch: fakeJev({
        answers: {
          ...gatesOpen,
          [Q.difficulty]: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} },
          "tool::Read": { type: "noul", noul: 0.9 },
          "tool::Bash": { type: "noul", noul: 0.9 },
        },
      }),
    });

    const route = await router.route({ message: "run the test suite and fix what breaks" });
    expect(route.source).toBe("jev");
    expect(route.tier).toBe("deep");
    expect(route.tools).toEqual(expect.arrayContaining(["Read", "Bash"]));
    expect(route.telemetry.hops).toBe(1);
    expect(route.telemetry.inputTokens).toBe(400);
    expect(route.telemetry.model).toBe("jev-1.13.0");
    expect(route.telemetry.requestId).toBe("req_test");
  });

  it("falls back to the heuristic when the deadline passes, and stays inside it", async () => {
    const router = createRouter({ deadlineMs: 80, fetch: fakeJev({ delayMs: 2_000 }) });

    const started = performance.now();
    const route = await router.route({ message: "arreglá el bug de auth en el login" });
    const elapsed = performance.now() - started;

    expect(route.source).toBe("fallback");
    // The contract is the deadline, not the answer.
    expect(elapsed).toBeLessThan(600);
    expect(route.why[0]).toMatch(/^jev deadline/);
    // The fallback is still a usable route, not an empty one.
    expect(route.model).toBeTruthy();
    expect(route.tools.length).toBeGreaterThan(0);
  });

  it("falls back on an API error rather than throwing at the harness", async () => {
    const router = createRouter({ fetch: fakeJev({ status: 500 }) });
    const route = await router.route({ message: "refactor the billing module" });
    expect(route.source).toBe("fallback");
    expect(route.why[0]).toMatch(/^jev api/);
    expect(route.tier).toBe("deep");
  });

  it("does not cache a fallback", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ status: 500, calls }) });
    await router.route({ message: "same turn twice" });
    await router.route({ message: "same turn twice" });
    // A transient failure must not poison the route for the rest of the session.
    expect(calls.n).toBe(2);
  });
});

describe("the second hop", () => {
  const contested = {
    ...gatesOpen,
    [Q.skill]: {
      type: "choice",
      choice: "docx",
      confidence: 0.55,
      probabilities: distribution(["docx", "pdf", "ltmsoft-doc-create", "none"], "docx", 0.4),
    },
  };

  it("stays off by default, even when the ranking is contested", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ answers: contested, calls }) });
    const route = await router.route({ message: "armá el documento de la propuesta" });
    expect(calls.n).toBe(1);
    expect(route.telemetry.hops).toBe(1);
  });

  it("runs when enabled and the ranking is contested", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({
      rerank: true,
      deadlineMs: 5_000,
      fetch: fakeJev({
        calls,
        answers: { ...contested, "fits::docx": { type: "noul", noul: 0.8 } },
      }),
    });
    const route = await router.route({ message: "armá el documento de la propuesta" });
    expect(calls.n).toBe(2);
    expect(route.telemetry.hops).toBe(2);
  });

  it("skips the second hop when the first was already decisive", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({
      rerank: true,
      deadlineMs: 5_000,
      fetch: fakeJev({
        calls,
        answers: {
          ...gatesOpen,
          [Q.skill]: {
            type: "choice",
            choice: "trello-cli",
            confidence: 0.99,
            probabilities: distribution(["trello-cli", "docx", "none"], "trello-cli", 0.99),
          },
        },
      }),
    });
    const route = await router.route({ message: "movelo a En Progreso en el trello" });
    expect(calls.n).toBe(1);
    expect(route.skill).toBe("trello-cli");
  });

  it("does not start a second hop it cannot finish in the budget", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({
      rerank: true,
      deadlineMs: MIN_RERANK_MS - 1,
      fetch: fakeJev({ answers: contested, calls }),
    });
    const route = await router.route({ message: "armá el documento de la propuesta" });
    expect(calls.n).toBe(1);
    expect(route.telemetry.hops).toBe(1);
  });

  it("drops the shortlist when every finalist fits badly", async () => {
    const router = createRouter({
      rerank: true,
      deadlineMs: 5_000,
      fetch: fakeJev({
        // Every `fits::*` Noul defaults to 0 here: the Choice still names a winner
        // among the finalists, and the absolute Nouls are what throw them all out.
        answers: contested,
      }),
    });
    const route = await router.route({ message: "armá el documento de la propuesta" });
    expect(route.skill).toBeNull();
    expect(route.why.join(" ")).toMatch(/below 0\.3, dropping the shortlist/);
  });
});

describe("unavailable tools", () => {
  it("never asks about a tool the harness cannot offer", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({ fetch: fakeJev({ calls, noul: 0.99 }) });
    const route = await router.route({
      message: "run the migration",
      session: { unavailableTools: ["Bash", "Write"] },
    });

    const body = calls.bodies[0] as { questions: Record<string, unknown> };
    expect(body.questions).not.toHaveProperty("tool::Bash");
    expect(body.questions).toHaveProperty("tool::Read");
    // Filtering in code is not advice to the model, it is a fact it never sees.
    expect(route.tools).not.toContain("Bash");
  });
});

describe("the prompt block", () => {
  it("keeps the roster byte-identical and appends the suggestion after it", async () => {
    const roster = "ROSTER TEXT THAT MUST NOT MOVE";
    const withSkill = systemPromptParts(roster, { skill: "ita-commit" });
    const without = systemPromptParts(roster, { skill: null });

    // Anything spliced into the prefix costs a prefix-cache miss on every turn, which
    // is more latency than the router can ever save.
    expect(withSkill.cached).toBe(roster);
    expect(without.cached).toBe(roster);
    expect(withSkill.suffix).not.toBe(without.suffix);
  });

  it("tells the model it may ignore the suggestion", () => {
    expect(renderSkillBlock({ skill: "ita-commit" })).toMatch(/Ignore this if it does not fit/);
  });

  it("still says something when nothing applies", () => {
    // Silence would leave the harness's own "err on the side of loading" unopposed.
    const block = renderSkillBlock({ skill: null });
    expect(block).toMatch(/No skill in the roster appears relevant/);
    expect(block).toContain("<skill_relevance>");
  });
});

describe("defaults", () => {
  it("ships a deadline above the measured network floor and below a second", () => {
    // A bare TCP connect to the API is 217ms from here, so anything under ~300ms would
    // fall back on essentially every turn. Above a second it stops being a router you
    // can afford to put in front of every turn.
    const router = createRouter();
    expect(router.deadlineMs).toBeGreaterThan(300);
    expect(router.deadlineMs).toBeLessThanOrEqual(1000);
  });

  it("ships thresholds that are internally consistent", () => {
    // The values themselves come from `npm run eval` and are expected to move when the
    // fixtures do, so this pins the invariants rather than the numbers.
    const t = DEFAULT_THRESHOLDS;
    for (const p of [t.gate, t.skillConfidence, t.toolTail, t.escalateConfidence, t.fits]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(t.tierCuts).toHaveLength(TIERS.length - 1);
    expect(t.effortCuts).toHaveLength(EFFORTS.length - 1);
    // Cuts must ascend, or the ladder skips a rung.
    expect([...t.tierCuts].sort((a, b) => a - b)).toEqual([...t.tierCuts]);
    expect([...t.effortCuts].sort((a, b) => a - b)).toEqual([...t.effortCuts]);
    expect(t.shortlist).toBeGreaterThan(0);
    expect(t.toolScale).toBeGreaterThan(0);
  });
});

describe("a missed deadline must not poison the next turn", () => {
  it("does not abort the in-flight request, so the connection survives", async () => {
    // Measured against the real API: aborting on the deadline tears down the pooled TLS
    // connection, and re-establishing it costs about as much as the deadline — so routes
    // alternated fallback/jev/fallback/jev forever. Only the caller's own signal aborts.
    let sawAbort = false;
    const router = createRouter({
      deadlineMs: 60,
      fetch: async (input, init) => {
        init?.signal?.addEventListener("abort", () => {
          sawAbort = true;
        });
        return fakeJev({ delayMs: 200 })(input, init);
      },
    });

    const route = await router.route({ message: "a turn that will outrun the deadline" });
    expect(route.source).toBe("fallback");

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sawAbort).toBe(false);
  });

  it("puts the late answer in the cache, so a re-sent turn gets it for free", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const router = createRouter({
      deadlineMs: 60,
      fetch: fakeJev({ delayMs: 200, calls, noul: 0.99 }),
    });
    const input = { message: "the same turn, sent twice" };

    const first = await router.route(input);
    expect(first.source).toBe("fallback");

    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await router.route(input);
    expect(second.source).toBe("cache");
    // And it is the real answer, not the heuristic's: every tool Noul came back at 0.99.
    expect(second.tools.length).toBeGreaterThan(first.tools.length);
    expect(calls.n).toBe(1);
  });
});
