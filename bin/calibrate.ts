/**
 * Measure the round trip from where you actually are, and write the deadline it implies.
 *
 *   npm run calibrate
 *   npm run calibrate -- --coverage 98 --samples 40
 *
 * The router's deadline is the one number that cannot be inherited. It is dominated by
 * network distance to `api.typesafe.ai`, not by anything in this repo: ten times the
 * tokens changes the round trip by nothing, while a bare TCP connect from Buenos Aires
 * is 217ms and from us-east would be a fraction of that. The shipped 600 is one
 * machine's answer. This finds yours.
 *
 * It writes `HARNESS_ROUTER_DEADLINE_MS` into `.env`, which is gitignored, so the value
 * stays per-machine and never ships.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DEADLINE_ENV, FALLBACK_DEADLINE_MS, Jev } from "../src/jev.ts";
import { buildQuestions } from "../src/questions.ts";
import { availableTools, buildState } from "../src/state.ts";
import { isShortcut } from "../src/heuristic.ts";
import {
  WARMUP_SAMPLES,
  loadEnv,
  mean,
  ms,
  pct,
  percentile,
  readFixtures,
  requireKey,
  table,
} from "./util.ts";

loadEnv();
requireKey();

const argv = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  const value = i >= 0 ? Number(argv[i + 1]) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
};

/** Share of turns that should reach Jev rather than the heuristic. */
const COVERAGE = num("coverage", 95);
const SAMPLES = num("samples", 30);
const ENV_PATH = ".env";

const fixtures = (await readFixtures()).filter((f) => !isShortcut(f));
if (fixtures.length === 0) {
  console.error("No routable fixtures in fixtures/turns.jsonl. Add some turns first.");
  process.exit(1);
}

const tools = availableTools({ message: "" });
const questions = buildQuestions(tools);
// Deliberately generous: this measures the distribution, so a timeout would be a
// measurement that destroyed the thing it was measuring.
const jev = new Jev({ deadlineMs: 30_000 });

console.log(
  `\nWarming up, then timing ${SAMPLES} sequential round trips` +
    ` (the first ${WARMUP_SAMPLES} are run and discarded).\n`,
);
await jev.prewarm();

const latencies: number[] = [];
for (let i = 0; i < SAMPLES + WARMUP_SAMPLES; i++) {
  const fixture = fixtures[i % fixtures.length] as (typeof fixtures)[number];
  const out = await jev.ask(buildState(fixture), questions);
  if (i >= WARMUP_SAMPLES) latencies.push(out.jevMs);
  process.stderr.write(i < WARMUP_SAMPLES ? "~" : ".");
}
process.stderr.write("\n\n");

const rounded = (value: number): number => Math.ceil(value / 50) * 50;
const target = rounded(percentile(latencies, COVERAGE));

console.log(
  table([
    ["  p50", ms(percentile(latencies, 50))],
    ["  p90", ms(percentile(latencies, 90))],
    ["  p95", ms(percentile(latencies, 95))],
    ["  p99", ms(percentile(latencies, 99))],
    ["  mean", ms(mean(latencies))],
    ["  max", ms(Math.max(...latencies))],
  ]),
);

console.log("\n  coverage if you pick...");
console.log(
  table([
    ["  deadline", "reaches jev", "falls back"],
    ...[200, 300, 400, 500, 600, 750, 1000, 1500].map((d) => {
      const covered = latencies.filter((l) => l <= d).length / latencies.length;
      return [`  ${d}ms${d === target ? "  <-" : ""}`, pct(covered), pct(1 - covered)];
    }),
  ]),
);

const actual = latencies.filter((l) => l <= target).length / latencies.length;
console.log(
  `\n  ${COVERAGE}% coverage needs ${ms(target)}, which covers ${pct(actual)} of this sample.`,
);

if (argv.includes("--dry-run")) {
  console.log(`\n  --dry-run: nothing written. Set it yourself with ${DEADLINE_ENV}=${target}\n`);
  process.exit(0);
}

const previous = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
const line = `${DEADLINE_ENV}=${target}`;
const next = new RegExp(`^${DEADLINE_ENV}=.*$`, "m").test(previous)
  ? previous.replace(new RegExp(`^${DEADLINE_ENV}=.*$`, "m"), line)
  : `${previous.replace(/\n*$/, "")}\n\n# Written by \`npm run calibrate\`. Per-machine; .env is gitignored.\n${line}\n`;
await writeFile(ENV_PATH, next);

console.log(
  `\n  Wrote ${line} to ${ENV_PATH}` +
    (target === FALLBACK_DEADLINE_MS ? "  (same as the shipped default)" : "") +
    `\n  Re-run \`npm run bench\` to confirm, and \`npm run eval\` if you changed the catalogue.\n`,
);
