/**
 * Score the router against the labelled fixtures, and sweep its thresholds.
 *
 *   npx tsx bin/eval.ts
 *   npx tsx bin/eval.ts --strings        # A/B back to plain string skill criteria
 *   npx tsx bin/eval.ts --dump out.json  # keep the raw answers
 *
 * Jev is called once per fixture. Every threshold in the sweep is then re-derived from
 * those stored answers, because the policy is pure — moving a number does not cost a
 * request. That is the whole reason the raw probabilities are kept.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_THRESHOLDS, decide, type PolicyResult, type Thresholds } from "../src/policy.ts";
import { Jev } from "../src/jev.ts";
import { buildQuestions } from "../src/questions.ts";
import type { RouterAnswers } from "../src/questions.ts";
import { availableTools, buildState } from "../src/state.ts";
import { heuristicRoute, isShortcut, shortcutRoute } from "../src/heuristic.ts";
import { TIERS } from "../src/catalog/index.ts";
import { USD_PER_INPUT_TOKEN } from "../src/types.ts";
import { loadEnv, pct, pool, readFixtures, requireKey, setScore, table, transport, type Fixture } from "./util.ts";

loadEnv();
requireKey();

const argv = process.argv.slice(2);
const structured = !argv.includes("--strings");
const dumpPath = argv.includes("--dump") ? argv[argv.indexOf("--dump") + 1] : undefined;
const replayPath = argv.includes("--replay") ? argv[argv.indexOf("--replay") + 1] : undefined;
const WORKERS = 8;

const fixtures = await readFixtures();
console.log(`\n${fixtures.length} labelled turns, ${structured ? "structured" : "string"} skill criteria\n`);

// ---------------------------------------------------------------- collect

interface Sample {
  fixture: Fixture;
  answers: RouterAnswers | null;
  asked: ReturnType<typeof availableTools>;
  inputTokens: number;
  jevMs: number;
}

// A deadline generous enough that the eval measures accuracy, not timeouts. The bench
// is where the production deadline gets tested.
const jev = new Jev({ deadlineMs: 20_000, ...transport() });

async function collect(fixture: Fixture): Promise<Sample> {
  const asked = availableTools(fixture);
  if (isShortcut(fixture)) return { fixture, answers: null, asked, inputTokens: 0, jevMs: 0 };
  const state = buildState(fixture);
  const questions = buildQuestions(asked, { structuredSkillCriteria: structured });
  const out = await jev.ask(state, questions);
  return { fixture, answers: out.answers, asked, inputTokens: out.inputTokens, jevMs: out.jevMs };
}

/**
 * Tuning must not cost requests.
 *
 * `--dump` keeps the raw answers; `--replay` re-scores every threshold against them
 * offline. The policy is pure, so a sweep is arithmetic over stored probabilities, not
 * fifty more round trips.
 */
const samples: Sample[] = replayPath
  ? ((JSON.parse(await readFile(replayPath, "utf8")) as Sample[]).map((s) => ({
      ...s,
      fixture: s.fixture,
    })))
  : await pool(fixtures, WORKERS, collect);

if (replayPath) console.log(`replayed from ${replayPath} — no API calls made\n`);

// ---------------------------------------------------------------- score

interface Score {
  label: string;
  tierExact: number;
  tierWithin1: number;
  tierTooCheap: number;
  skillExact: number;
  skillFalsePositive: number;
  skillMissed: number;
  toolPrecision: number;
  toolRecall: number;
  toolExact: number;
}

function route(sample: Sample, thresholds: Thresholds): PolicyResult {
  if (!sample.answers) return shortcutRoute(sample.fixture);
  return decide(sample.answers, sample.asked, thresholds);
}

function score(label: string, routed: readonly PolicyResult[]): Score {
  let tierExact = 0;
  let tierWithin1 = 0;
  let tierTooCheap = 0;
  let tierN = 0;
  let skillExact = 0;
  let skillFalsePositive = 0;
  let skillMissed = 0;
  let skillN = 0;
  let coveredN = 0;
  const precisions: number[] = [];
  const recalls: number[] = [];
  let toolExact = 0;
  let toolN = 0;

  routed.forEach((r, i) => {
    const want = (samples[i] as Sample).fixture.expect;

    if (want.tier) {
      tierN += 1;
      const got = TIERS.indexOf(r.tier);
      const expected = TIERS.indexOf(want.tier as (typeof TIERS)[number]);
      if (got === expected) tierExact += 1;
      if (Math.abs(got - expected) <= 1) tierWithin1 += 1;
      // The asymmetry that matters: too big is visible on the bill, too small is a
      // silently worse answer.
      if (got < expected) tierTooCheap += 1;
    }

    if (want.skill !== undefined) {
      skillN += 1;
      if (want.skill === null) {
        if (r.skill === null) skillExact += 1;
        else skillFalsePositive += 1;
      } else {
        coveredN += 1;
        if (r.skill === want.skill) skillExact += 1;
        else if (r.skill === null) skillMissed += 1;
      }
    }

    if (want.tools) {
      toolN += 1;
      const s = setScore(r.tools, want.tools);
      precisions.push(s.precision);
      recalls.push(s.recall);
      if (s.exact) toolExact += 1;
    }
  });

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    label,
    tierExact: tierExact / Math.max(tierN, 1),
    tierWithin1: tierWithin1 / Math.max(tierN, 1),
    tierTooCheap: tierTooCheap / Math.max(tierN, 1),
    skillExact: skillExact / Math.max(skillN, 1),
    skillFalsePositive: skillFalsePositive / Math.max(skillN - coveredN, 1),
    skillMissed: skillMissed / Math.max(coveredN, 1),
    toolPrecision: avg(precisions),
    toolRecall: avg(recalls),
    toolExact: toolExact / Math.max(toolN, 1),
  };
}

const baseline = score("heuristic", samples.map((s) => heuristicRoute(s.fixture)));
const router = score("jev", samples.map((s) => route(s, DEFAULT_THRESHOLDS)));

console.log(
  table([
    ["", "heuristic", "jev", "delta"],
    ...(
      [
        ["tier exact", "tierExact", 1],
        ["tier within 1", "tierWithin1", 1],
        ["tier too cheap", "tierTooCheap", -1],
        ["skill exact", "skillExact", 1],
        ["skill false positive", "skillFalsePositive", -1],
        ["skill missed", "skillMissed", -1],
        ["tool precision", "toolPrecision", 1],
        ["tool recall", "toolRecall", 1],
        ["tool exact set", "toolExact", 1],
      ] as const
    ).map(([name, key, sign]) => {
      const a = baseline[key];
      const b = router[key];
      const delta = (b - a) * sign;
      return [name, pct(a), pct(b), `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`];
    }),
  ]),
);

console.log(
  `\n"tier too cheap" and the two skill error rates are errors: lower is better, and the delta\ncolumn is already signed so a positive number always means jev won.`,
);

// ---------------------------------------------------------------- sweeps

function sweep(name: string, values: readonly number[], build: (v: number) => Thresholds): void {
  console.log(`\n${name}`);
  console.log(
    table([
      [name, "skill exact", "false pos", "missed"],
      ...values.map((v) => {
        const s = score(String(v), samples.map((sample) => route(sample, build(v))));
        return [v.toFixed(2), pct(s.skillExact), pct(s.skillFalsePositive), pct(s.skillMissed)];
      }),
    ]),
  );
}

sweep("gate", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], (gate) => ({ ...DEFAULT_THRESHOLDS, gate }));
sweep("skillConfidence", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], (skillConfidence) => ({
  ...DEFAULT_THRESHOLDS,
  skillConfidence,
}));

// The two skill thresholds interact: the gate decides whether to suggest anything, the
// confidence floor decides whether this particular winner is trustworthy. Sweeping them
// one at a time hides the corner where both are right.
console.log("\ngate x skillConfidence — skill exact % (false positive %)");
{
  const gates = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  const confs = [0.3, 0.4, 0.5, 0.6, 0.7];
  console.log(
    table([
      ["gate \\ conf", ...confs.map((c) => c.toFixed(2))],
      ...gates.map((gate) => [
        gate.toFixed(2),
        ...confs.map((skillConfidence) => {
          const sc = score(
            "cell",
            samples.map((sample) => route(sample, { ...DEFAULT_THRESHOLDS, gate, skillConfidence })),
          );
          return `${(sc.skillExact * 100).toFixed(1)} (${(sc.skillFalsePositive * 100).toFixed(1)})`;
        }),
      ]),
    ]),
  );
}

console.log("\ntier cuts");
console.log(
  table([
    ["cuts", "exact", "within 1", "too cheap"],
    ...([
      [0.5, 1.5],
      [0.8, 2.2],
      [1.0, 2.0],
      [1.2, 2.4],
      [1.4, 2.4],
      [1.6, 2.6],
      [1.8, 2.6],
      [2.0, 2.8],
      [2.2, 2.9],
    ] as const).map((tierCuts) => {
      const s = score("cuts", samples.map((sample) => route(sample, { ...DEFAULT_THRESHOLDS, tierCuts })));
      return [`[${tierCuts.join(", ")}]`, pct(s.tierExact), pct(s.tierWithin1), pct(s.tierTooCheap)];
    }),
  ]),
);

console.log("\ntool threshold scale (multiplies every per-risk bar)");
console.log(
  table([
    ["scale", "precision", "recall", "exact set"],
    ...[0.6, 0.8, 1.0, 1.3, 1.6, 2.0].map((scale) => {
      const s2 = score(
        "tools",
        samples.map((sample) => route(sample, { ...DEFAULT_THRESHOLDS, toolScale: scale })),
      );
      return [scale.toFixed(1), pct(s2.toolPrecision), pct(s2.toolRecall), pct(s2.toolExact)];
    }),
  ]),
);

// ---------------------------------------------------------------- misses

const misses = samples
  .map((s, i) => ({ s, r: route(s, DEFAULT_THRESHOLDS), i }))
  .filter(({ s, r }) => s.fixture.expect.skill !== undefined && r.skill !== (s.fixture.expect.skill ?? null));

if (misses.length > 0) {
  console.log(`\n${misses.length} skill misses`);
  for (const { s, r } of misses.slice(0, 15)) {
    const want = s.fixture.expect.skill ?? "none";
    const gate = r.diagnostics.gate.toFixed(2);
    console.log(
      `  ${s.fixture.id.padEnd(14)} want ${String(want).padEnd(20)} got ${String(r.skill ?? "none").padEnd(20)}` +
        ` gate ${gate} top ${r.diagnostics.skillTop} @ ${r.diagnostics.skillConfidence.toFixed(2)}`,
    );
  }
}

// ---------------------------------------------------------------- cost

const calls = samples.filter((s) => s.answers).length;
const tokens = samples.reduce((a, s) => a + s.inputTokens, 0);
const rerankRate =
  samples.filter((s) => s.answers && route(s, DEFAULT_THRESHOLDS).diagnostics.rerankWorthwhile).length /
  Math.max(calls, 1);

console.log(
  `\n${calls} jev calls for ${fixtures.length} turns` +
    ` (${fixtures.length - calls} answered by the shortcut, for free)` +
    `\n${Math.round(tokens / Math.max(calls, 1))} input tokens per call` +
    `  ·  $${((tokens / Math.max(calls, 1)) * USD_PER_INPUT_TOKEN * 1000).toFixed(4)} per 1k turns` +
    `\n${pct(rerankRate)} of calls have a contested enough ranking to want a second hop`,
);

if (dumpPath) {
  await writeFile(dumpPath, JSON.stringify(samples, null, 2));
  console.log(`\nraw answers written to ${dumpPath}`);
}
console.log();
