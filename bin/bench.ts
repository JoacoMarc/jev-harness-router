/**
 * Measure the thing the whole design is for.
 *
 *   npx tsx bin/bench.ts
 *   npx tsx bin/bench.ts --runs 3 --concurrency 4
 *
 * Three numbers matter. What the router actually costs a turn (percentiles, against the
 * 400 ms deadline). What batching buys, reproduced on this catalogue rather than quoted
 * from the docs. And where the deadline should sit, from the coverage curve instead of
 * from a guess.
 */
import { performance } from "node:perf_hooks";
import { DEFAULT_DEADLINE_MS, Jev } from "../src/jev.ts";
import { buildQuestions, questionCount } from "../src/questions.ts";
import { availableTools, buildState } from "../src/state.ts";
import { isShortcut } from "../src/heuristic.ts";
import { createRouter } from "../src/router.ts";
import { USD_PER_INPUT_TOKEN } from "../src/types.ts";
import { loadEnv, mean, ms, pct, percentile, pool, readFixtures, requireKey, table, transport } from "./util.ts";

loadEnv();
requireKey();

const argv = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const RUNS = num("runs", 2);
const CONCURRENCY = num("concurrency", 4);
const DEADLINE = num("deadline", DEFAULT_DEADLINE_MS);

const fixtures = (await readFixtures()).filter((f) => !isShortcut(f));
const tools = availableTools({ message: "" });

console.log(
  `\n${fixtures.length} turns x ${RUNS} runs, ${questionCount(tools)} questions per request,` +
    ` concurrency ${CONCURRENCY}\n`,
);

// ---------------------------------------------------------------- 1. latency

// Generous deadline on purpose: the point is to measure the true distribution and then
// read the deadline off it, not to record a pile of timeouts. Warmed first, because a
// harness warms once at startup and the handshake is not what is being measured here —
// leaving it in put a cold first call into the p95 and made the verdict pessimistic.
const jev = new Jev({ deadlineMs: 20_000, ...transport() });
await jev.prewarm();

interface Timing {
  ms: number;
  inputTokens: number;
}

const work = fixtures.flatMap((f) => Array.from({ length: RUNS }, () => f));
const timings = await pool(work, CONCURRENCY, async (f): Promise<Timing> => {
  const out = await jev.ask(buildState(f), buildQuestions(tools));
  return { ms: out.jevMs, inputTokens: out.inputTokens };
});

const latencies = timings.map((t) => t.ms);
const tokens = timings.map((t) => t.inputTokens);

console.log("jev round trip");
console.log(
  table([
    ["", "ms"],
    ["  p50", ms(percentile(latencies, 50))],
    ["  p95", ms(percentile(latencies, 95))],
    ["  p99", ms(percentile(latencies, 99))],
    ["  max", ms(Math.max(...latencies))],
    ["  mean", ms(mean(latencies))],
  ]),
);

const within = latencies.filter((l) => l <= DEADLINE).length / latencies.length;
const verdict = percentile(latencies, 95) <= DEADLINE ? "PASS" : "FAIL";
console.log(
  `\n  ${verdict}: p95 ${ms(percentile(latencies, 95))} against a ${DEADLINE}ms deadline` +
    `  ·  ${pct(within)} of calls land inside it`,
);

console.log(
  `\n  ${Math.round(mean(tokens))} input tokens per call` +
    `  ·  $${(mean(tokens) * USD_PER_INPUT_TOKEN * 1000).toFixed(4)} per 1k turns` +
    "  ·  output tokens are free",
);

// ---------------------------------------------------------------- 2. deadline curve

console.log("\ndeadline coverage");
console.log(
  table([
    ["  deadline", "answered by jev", "answered by the heuristic"],
    ...[150, 200, 250, 300, 400, 500, 750, 1000].map((d) => {
      const covered = latencies.filter((l) => l <= d).length / latencies.length;
      return [`  ${d}ms`, pct(covered), pct(1 - covered)];
    }),
  ]),
);

// ---------------------------------------------------------------- 3. batching ablation

// The claim under test: one request with N questions beats N requests with one each.
// The docs measure 12x cheaper and 10x faster on a 54KB document; this reproduces it on
// the router's own tiny state, where the margin should be narrower and still decisive.
const probe = fixtures[Math.floor(fixtures.length / 2)];
if (probe) {
  const state = buildState(probe);
  const all = buildQuestions(tools);
  const ids = Object.keys(all);

  const t0 = performance.now();
  const batched = await jev.ask(state, all);
  const batchedMs = performance.now() - t0;

  const t1 = performance.now();
  const singles = await pool(ids, CONCURRENCY, async (id) =>
    jev.ask(state, { [id]: all[id as keyof typeof all] } as typeof all),
  );
  const serialConcurrentMs = performance.now() - t1;
  const serialSequentialMs = singles.reduce((a, s) => a + s.jevMs, 0);
  const serialTokens = singles.reduce((a, s) => a + s.inputTokens, 0);

  console.log("\nbatching, on this router's own state");
  console.log(
    table([
      ["  strategy", "calls", "input tokens", "wall clock"],
      ["  one call, every question", "1", String(batched.inputTokens), ms(batchedMs)],
      [
        `  one call each, ${CONCURRENCY} at a time`,
        String(ids.length),
        String(serialTokens),
        ms(serialConcurrentMs),
      ],
      ["  one call each, sequential", String(ids.length), String(serialTokens), ms(serialSequentialMs)],
    ]),
  );
  console.log(
    `\n  ${(serialTokens / Math.max(batched.inputTokens, 1)).toFixed(1)}x cheaper` +
      `  ·  ${(serialConcurrentMs / Math.max(batchedMs, 1)).toFixed(1)}x faster than firing them concurrently` +
      `  ·  ${(serialSequentialMs / Math.max(batchedMs, 1)).toFixed(1)}x faster than one after another`,
  );
  console.log(
    "\n  The token saving is unconditional: every separate call re-sends the whole state.\n" +
      "  The concurrent column is the honest speed comparison; the sequential one is the\n" +
      "  figure the docs quote, and it flatters batching.",
  );
}

// ---------------------------------------------------------------- 4. end to end

// Warmed first, the way a harness should: the handshake is 600ms of the first call and
// has nothing to do with routing.
const router = createRouter({ deadlineMs: DEADLINE, ...transport() });
await router.prewarm();
const endToEnd = await pool(fixtures, CONCURRENCY, (f) => router.route(f));
const totals = endToEnd.map((r) => r.telemetry.totalMs);
const fallbacks = endToEnd.filter((r) => r.source === "fallback").length;

console.log("\nend to end, at the production deadline");
console.log(
  table([
    ["  p50", ms(percentile(totals, 50))],
    ["  p95", ms(percentile(totals, 95))],
    ["  p99", ms(percentile(totals, 99))],
    ["  max", ms(Math.max(...totals))],
    ["  fell back", `${fallbacks}/${endToEnd.length}`],
  ]),
);
console.log(
  `\n  The max is the number that matters: it is the worst a turn can be slowed by asking.\n`,
);
