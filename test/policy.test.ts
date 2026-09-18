import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, decide, gateScore, margin } from "../src/policy.ts";
import { TIERS, TOOL_IDS, type ToolId } from "../src/catalog/index.ts";
import { answers } from "./helpers.ts";

/**
 * The whole decision layer is pure, so all of it is testable with no key and no network.
 * These are the rules the plan argued for; if one of them regresses it should fail here
 * rather than in a latency graph.
 */

describe("margin", () => {
  it("is 1 for a single option and 0 for a dead tie", () => {
    expect(margin({ a: 1 })).toBe(1);
    expect(margin({ a: 0.5, b: 0.5 })).toBe(0);
  });

  it("measures the gap between the top two, not the winner's own mass", () => {
    expect(margin({ a: 0.45, b: 0.44, c: 0.11 })).toBeCloseTo(0.01, 5);
    expect(margin({ a: 0.45, b: 0.2, c: 0.2, d: 0.15 })).toBeCloseTo(0.25, 5);
  });
});

describe("gateScore", () => {
  it("inverts prose_suffices, because a yes there points away from needing a skill", () => {
    const high = gateScore(
      answers({
        gates: { acts_on_system: 1, follows_procedure: 1, produces_artifact: 1, prose_suffices: 0 },
      }),
    );
    expect(high.score).toBeCloseTo(1, 5);

    const low = gateScore(
      answers({
        gates: { acts_on_system: 0, follows_procedure: 0, produces_artifact: 0, prose_suffices: 1 },
      }),
    );
    expect(low.score).toBeCloseTo(0, 5);
  });

  it("reports the raw values, un-inverted, for inspection", () => {
    const { values } = gateScore(answers({ gates: { prose_suffices: 0.9 } }));
    expect(values.prose_suffices).toBe(0.9);
  });
});

describe("model tier and effort", () => {
  it("sends a trivial turn to the cheap tier", () => {
    const d = decide(answers({ difficulty: 0.1 }), TOOL_IDS);
    expect(d.tier).toBe("fast");
    expect(d.effort).toBe("low");
  });

  it("sends open-ended work to the deep tier", () => {
    const d = decide(answers({ difficulty: 3 }), TOOL_IDS);
    expect(d.tier).toBe("deep");
    expect(d.effort).toBe("xhigh");
  });

  it("floors the tier at balanced when the turn spans the project", () => {
    const d = decide(answers({ difficulty: 0.1, scope: 2 }), TOOL_IDS);
    expect(d.tier).toBe("balanced");
  });

  it("escalates rather than guesses when difficulty confidence is low", () => {
    const sure = decide(answers({ difficulty: 0.1, difficultyConfidence: 0.95 }), TOOL_IDS);
    const unsure = decide(answers({ difficulty: 0.1, difficultyConfidence: 0.2 }), TOOL_IDS);
    expect(sure.tier).toBe("fast");
    expect(unsure.tier).toBe("balanced");
    expect(unsure.why.join(" ")).toMatch(/low, escalating/);
  });

  it("never escalates downward", () => {
    const d = decide(answers({ difficulty: 2.9, difficultyConfidence: 0.1 }), TOOL_IDS);
    expect(d.tier).toBe("deep");
    expect(d.effort).toBe("xhigh");
  });
});

describe("tool selection", () => {
  it("enables every tool that clears its own bar, and no others", () => {
    const d = decide(answers({ tools: { Read: 0.9, Grep: 0.9, Bash: 0.1 } }), TOOL_IDS);
    expect(d.tools).toContain("Read");
    expect(d.tools).toContain("Grep");
    expect(d.tools).not.toContain("Bash");
  });

  it("holds a read-only tool to a lower bar than an executing one", () => {
    // One probability, two verdicts: 0.5 clears Read's 0.35 and misses Bash's 0.8.
    const d = decide(answers({ tools: { Read: 0.5, Bash: 0.5 } }), TOOL_IDS);
    expect(d.tools).toContain("Read");
    expect(d.tools).not.toContain("Bash");
  });

  it("lets the ranking tail add a read-only tool the Noul narrowly missed", () => {
    const d = decide(
      answers({ tools: { Grep: 0.2 }, toolWhich: "Grep", toolWhichMass: 0.6 }),
      TOOL_IDS,
    );
    expect(d.tools).toContain("Grep");
    expect(d.why.join(" ")).toMatch(/ranking tail/);
  });

  it("refuses to let the ranking tail hand out Bash", () => {
    // The message driving this is untrusted, so a relative signal must not clear an
    // absolute safety bar.
    const d = decide(
      answers({ tools: { Bash: 0.2 }, toolWhich: "Bash", toolWhichMass: 0.95 }),
      TOOL_IDS,
    );
    expect(d.tools).not.toContain("Bash");
    expect(d.why.join(" ")).toMatch(/held back/);
  });

  it("only considers tools that were actually asked about", () => {
    const asked: ToolId[] = ["Read", "Grep"];
    const d = decide(answers({ asked, tools: { Read: 0.9 } }), asked);
    expect(d.tools).toEqual(["Read"]);
  });

  it("returns an empty set rather than inventing one", () => {
    const d = decide(answers(), TOOL_IDS);
    expect(d.tools).toEqual([]);
  });
});

describe("skill selection", () => {
  const gatesOpen = {
    acts_on_system: 0.9,
    follows_procedure: 0.9,
    produces_artifact: 0.9,
    prose_suffices: 0.1,
  };

  it("applies a confident skill when the gates are open", () => {
    const d = decide(answers({ gates: gatesOpen, skill: "ita-commit", skillConfidence: 0.9 }), TOOL_IDS);
    expect(d.skill).toBe("ita-commit");
  });

  it("suppresses the skill when the gates say no action is wanted", () => {
    const d = decide(
      answers({
        gates: {
          acts_on_system: 0.05,
          follows_procedure: 0.05,
          produces_artifact: 0.05,
          prose_suffices: 0.95,
        },
        skill: "ita-commit",
        skillConfidence: 0.95,
      }),
      TOOL_IDS,
    );
    expect(d.skill).toBeNull();
    expect(d.why.join(" ")).toMatch(/gate .* below/);
  });

  it("suppresses a winner the ranking is not confident about", () => {
    const d = decide(
      answers({ gates: gatesOpen, skill: "ita-commit", skillConfidence: 0.1 }),
      TOOL_IDS,
    );
    expect(d.skill).toBeNull();
  });

  it("honours an explicit none", () => {
    const d = decide(answers({ gates: gatesOpen, skill: "none" }), TOOL_IDS);
    expect(d.skill).toBeNull();
  });

  it("flags a contested ranking as worth a second hop", () => {
    const contested = decide(
      answers({ gates: gatesOpen, skill: "docx", skillMass: 0.34 }),
      TOOL_IDS,
    );
    const decisive = decide(
      answers({ gates: gatesOpen, skill: "docx", skillMass: 0.99 }),
      TOOL_IDS,
    );
    expect(contested.diagnostics.rerankWorthwhile).toBe(true);
    expect(decisive.diagnostics.rerankWorthwhile).toBe(false);
  });

  it("never proposes a second hop once the gates have closed", () => {
    const d = decide(answers({ skill: "docx", skillMass: 0.34 }), TOOL_IDS);
    expect(d.diagnostics.rerankWorthwhile).toBe(false);
  });
});

describe("thresholds", () => {
  it("re-derives a different route from the same answers", () => {
    // Moving a threshold must not require another request: that is the whole reason the
    // raw probabilities are kept and the policy is pure.
    // Asserted against the ladder rather than against literal tier names, so retuning
    // DEFAULT_THRESHOLDS on new data cannot silently break this.
    const a = answers({ difficulty: 1 });
    const cheap = decide(a, TOOL_IDS, { ...DEFAULT_THRESHOLDS, tierCuts: [5, 10] });
    const dear = decide(a, TOOL_IDS, { ...DEFAULT_THRESHOLDS, tierCuts: [0.05, 0.1] });
    expect(cheap.tier).toBe(TIERS[0]);
    expect(dear.tier).toBe(TIERS[TIERS.length - 1]);
  });

  it("keeps the ladders and their cut lists in step", () => {
    expect(DEFAULT_THRESHOLDS.tierCuts).toHaveLength(2);
    expect(DEFAULT_THRESHOLDS.effortCuts).toHaveLength(3);
  });
});
