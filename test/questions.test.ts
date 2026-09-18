import { describe, expect, expectTypeOf, it } from "vitest";
import { SKILLS } from "../src/catalog/index.ts";
import {
  DIFFICULTY_LEVELS,
  GATE_IDS,
  Q,
  SCOPE_LEVELS,
  buildQuestions,
  buildRerankQuestions,
  gateId,
  questionCount,
  rerankAddsEvidence,
  skillCriteria,
  toolId,
} from "../src/questions.ts";
import type { RouterAnswers } from "../src/questions.ts";
import { SKILL_IDS, TOOL_IDS, type SkillId, type ToolId } from "../src/catalog/index.ts";

const A = SKILL_IDS[0] as SkillId;
const B = SKILL_IDS[1] as SkillId;
const C = SKILL_IDS[2] as SkillId;

describe("buildQuestions", () => {
  const questions = buildQuestions(TOOL_IDS);

  it("asks everything in one request", () => {
    expect(Object.keys(questions)).toHaveLength(questionCount(TOOL_IDS));
    expect(Object.keys(questions).length).toBeGreaterThan(TOOL_IDS.length);
  });

  it("asks one Noul per tool, not one Choice over tools", () => {
    // Tool selection is multi-label and can legitimately come back empty, which a
    // Choice cannot express: it is relative and always names a winner.
    for (const id of TOOL_IDS) {
      expect(questions[toolId(id)].type).toBe("noul");
    }
  });

  it("gives the skill Choice a none option", () => {
    expect(Object.keys(questions[Q.skill].criteria)).toContain("none");
    expect(Object.keys(questions[Q.skill].criteria)).toHaveLength(SKILL_IDS.length + 1);
  });

  it("keeps the catalogue inside Choice's 255-option ceiling", () => {
    expect(Object.keys(questions[Q.skill].criteria).length).toBeLessThanOrEqual(255);
    expect(Object.keys(questions[Q.toolWhich].criteria).length).toBeLessThanOrEqual(255);
  });

  it("describes score levels as situations, never as bare numbers", () => {
    for (const level of [...DIFFICULTY_LEVELS, ...SCOPE_LEVELS]) {
      expect(level).not.toMatch(/^\s*\d+\s*$/);
      expect(level.length).toBeGreaterThan(30);
    }
  });

  it("stays inside Score's 2-to-10 level range", () => {
    expect(DIFFICULTY_LEVELS.length).toBeGreaterThanOrEqual(2);
    expect(DIFFICULTY_LEVELS.length).toBeLessThanOrEqual(10);
    expect(SCOPE_LEVELS.length).toBeGreaterThanOrEqual(2);
    expect(SCOPE_LEVELS.length).toBeLessThanOrEqual(10);
  });

  it("names the state field it is about, in backticks", () => {
    // Pointing at the relevant part of state by name is the documented mitigation for
    // the model's weakness at indirection.
    for (const key of [Q.difficulty, Q.scope, Q.intent, Q.skill, Q.toolWhich] as const) {
      expect(String(questions[key].instructions)).toContain("`latest_user_message`");
    }
  });

  it("phrases every gate the natural way round", () => {
    // The inversion of prose_suffices happens to the value in policy.ts. A Noul whose
    // `true` means "no" measurably does worse.
    for (const id of GATE_IDS) {
      const q = questions[gateId(id)];
      expect(String(q.instructions)).toMatch(/^(Is|Would|Could)\b/);
      expect(String(q.instructions)).not.toMatch(/\bnot\b/i);
    }
  });

  it("only asks about the tools it was handed", () => {
    const narrow = buildQuestions(["Read", "Grep"]);
    expect(narrow).toHaveProperty("tool::Read");
    expect(narrow).not.toHaveProperty("tool::Bash");
  });
});

describe("skillCriteria", () => {
  it("can still emit plain strings, with the neighbour warning folded in", () => {
    const plain = skillCriteria(false);
    expect(typeof plain[A]).toBe("string");
    // Every example card that declares a neighbour folds the warning into its string.
    const withNeighbour = SKILL_IDS.find((id) => "notFor" in SKILLS[id]) as SkillId;
    expect(String(plain[withNeighbour])).toMatch(/Not for: /);
  });

  it("defaults to what / not_for / examples objects, which measured better", () => {
    const structured = skillCriteria() as Record<string, Record<string, unknown>>;
    const rich = SKILL_IDS.find(
      (id) => "notFor" in SKILLS[id] && "examples" in SKILLS[id],
    ) as SkillId;
    expect(structured[rich]).toMatchObject({
      what: expect.any(String),
      not_for: expect.any(String),
      examples: expect.any(Array),
    });
  });

  it("costs more input, which is the trade the eval settled", () => {
    const plain = JSON.stringify(skillCriteria(false)).length;
    const structured = JSON.stringify(skillCriteria(true)).length;
    expect(structured).toBeGreaterThan(plain);
  });
});

describe("buildRerankQuestions", () => {
  const names: SkillId[] = [A, B, C];
  const questions = buildRerankQuestions(names);

  it("pairs the shortlist Choice with one absolute Noul per finalist", () => {
    expect(questions[Q.skill].type).toBe("choice");
    for (const id of names) expect(questions[`fits::${id}`].type).toBe("noul");
  });

  it("keeps a none option so the whole shortlist can be rejected", () => {
    expect(Object.keys(questions[Q.skill].criteria)).toContain("none");
  });

  it("knows when a second hop would learn nothing", () => {
    // The whole justification for another round trip is that the finalists are re-read
    // against something the ranking never saw. If no finalist carries `detail`, they are
    // not, and the router skips the call rather than paying for a re-read.
    const withDetail = SKILL_IDS.filter((id) => "detail" in SKILLS[id]);
    const without = SKILL_IDS.filter((id) => !("detail" in SKILLS[id]));
    expect(rerankAddsEvidence(withDetail.slice(0, 2))).toBe(true);
    expect(rerankAddsEvidence(without.slice(0, 2))).toBe(false);
    expect(rerankAddsEvidence([])).toBe(false);
  });

  it("spends more words on each finalist than the wide pass did", () => {
    // Progressive disclosure is the only honest reason to pay for a second round trip:
    // the finalists are re-read against better evidence than the ranking had.
    const wide = JSON.stringify(buildQuestions(TOOL_IDS)[Q.skill].criteria[A]);
    const close = JSON.stringify(questions[Q.skill].criteria[A]);
    expect(close.length).toBeGreaterThan(wide.length);
  });
});

describe("answer types are derived from the catalogue", () => {
  it("types the skill choice as the literal union of skill ids plus none", () => {
    expectTypeOf<RouterAnswers[typeof Q.skill]["choice"]>().toEqualTypeOf<SkillId | "none">();
  });

  it("types the tool ranking as the literal union of tool ids plus none", () => {
    expectTypeOf<RouterAnswers[typeof Q.toolWhich]["choice"]>().toEqualTypeOf<ToolId | "none">();
  });

  it("gives every tool Noul a probability and no confidence", () => {
    expectTypeOf<RouterAnswers[`tool::${ToolId}`]["noul"]>().toEqualTypeOf<number>();
    expectTypeOf<RouterAnswers[`tool::${ToolId}`]>().not.toHaveProperty("confidence");
  });

  it("gives Choice and Score a confidence", () => {
    expectTypeOf<RouterAnswers[typeof Q.difficulty]["confidence"]>().toEqualTypeOf<number>();
    expectTypeOf<RouterAnswers[typeof Q.intent]["confidence"]>().toEqualTypeOf<number>();
  });
});
