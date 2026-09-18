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
const COVERAGE = num("coverage", 98);
const SAMPLES = num("samples", 30);
/**
 * Padding on top of the measured quantile.
 *
 * Without it this command lied. Thirty samples taken back to back span about ten
 * seconds, and network conditions over ten seconds are autocorrelated — so the sample
 * describes one window, not the distribution. The first run here measured p95 at 470ms,
 * wrote a 500ms deadline, and the very next real turns fell back half the time.
 *
 * The margin buys back what a short sample cannot see. Pass `--margin 1` to disable it
 * and get the raw quantile.
 */
const MARGIN = num("margin", 1.25);
/** Gap between samples, so the window covers more than one moment of the network. */
const SPACING_MS = num("spacing", 200);
/**
 * The point past which a router stops being worth putting in front of a turn.
 *
 * Not a law of nature — it depends on what a turn costs you. Spending 1.5s to route a
 * 30s agent turn is cheap; spending it on a 3s turn is not. But a calibrator that
 * silently writes 4200ms because the network was bad for a minute has failed at its job,
 * which is to tell you the truth about your situation. Raise it with `--ceiling` if your
 * turns are long enough to absorb it.
 */
const CEILING_MS = num("ceiling", 1500);
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
  `\nWarming up, then timing ${SAMPLES} round trips ${SPACING_MS}ms apart` +
    ` (the first ${WARMUP_SAMPLES} are run and discarded).\n`,
);
await jev.prewarm();

const latencies: number[] = [];
for (let i = 0; i < SAMPLES + WARMUP_SAMPLES; i++) {
  const fixture = fixtures[i % fixtures.length] as (typeof fixtures)[number];
  const out = await jev.ask(buildState(fixture), questions);
  if (i >= WARMUP_SAMPLES) latencies.push(out.jevMs);
  process.stderr.write(i < WARMUP_SAMPLES ? "~" : ".");
  if (SPACING_MS > 0) await new Promise((r) => setTimeout(r, SPACING_MS));
}
process.stderr.write("\n\n");

const rounded = (value: number): number => Math.ceil(value / 50) * 50;
const raw = percentile(latencies, COVERAGE);
const target = rounded(raw * MARGIN);

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
const spread = percentile(latencies, 99) / Math.max(percentile(latencies, 50), 1);
console.log(
  `\n  p${COVERAGE} is ${ms(raw)}; with a ${MARGIN}x margin the deadline is ${ms(target)},` +
    ` which covers ${pct(actual)} of this sample.` +
    `\n  The margin is not padding for its own sake: a sample this short sees one window` +
    `\n  of the network, and this one already spans ${spread.toFixed(1)}x from p50 to p99.`,
);
if (spread > 2) {
  console.log(
    `\n  That spread is wide. Re-run with --samples 60 if this machine's network varies,` +
      `\n  or accept more fallbacks: they cost accuracy, not correctness.`,
  );
}

const capped = Math.min(target, CEILING_MS);
if (capped < target) {
  const covered = latencies.filter((l) => l <= capped).length / latencies.length;
  console.log(
    `\n  ${ms(target)} is past the ${ms(CEILING_MS)} ceiling, so ${ms(capped)} is what gets written.` +
      `\n\n  At ${ms(capped)}, ${pct(1 - covered)} of turns on this sample would route by the` +
      `\n  heuristic instead of by jev. That is not broken — the fallback is a real route and` +
      `\n  the turn still runs — but it is most of the value gone, so it is worth knowing:` +
      `\n\n    · the network to api.typesafe.ai is the whole cost here, and it is not local` +
      `\n      to this repo. Re-run in a while; this may be a bad hour rather than a bad link.` +
      `\n    · if your turns are long enough that a second of routing is noise, raise the` +
      `\n      ceiling: --ceiling 3000` +
      `\n    · if they are not, this router may simply not pay for itself from here.`,
  );
}

if (argv.includes("--dry-run")) {
  console.log(`\n  --dry-run: nothing written. Set it yourself with ${DEADLINE_ENV}=${capped}\n`);
  process.exit(0);
}

const previous = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
const line = `${DEADLINE_ENV}=${capped}`;
const next = new RegExp(`^${DEADLINE_ENV}=.*$`, "m").test(previous)
  ? previous.replace(new RegExp(`^${DEADLINE_ENV}=.*$`, "m"), line)
  : `${previous.replace(/\n*$/, "")}\n\n# Written by \`npm run calibrate\`. Per-machine; .env is gitignored.\n${line}\n`;
await writeFile(ENV_PATH, next);

console.log(
  `\n  Wrote ${line} to ${ENV_PATH}` +
    (capped === FALLBACK_DEADLINE_MS ? "  (same as the shipped default)" : "") +
    `\n  Re-run \`npm run bench\` to confirm, and \`npm run eval\` if you changed the catalogue.\n`,
);
