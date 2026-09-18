/**
 * Route one turn and show the work.
 *
 *   npx tsx bin/route.ts "arreglá el bug de auth en el login"
 *   echo "..." | npx tsx bin/route.ts --rerank --deadline 800
 */
import { DEFAULT_DEADLINE_MS } from "../src/jev.ts";
import { createRouter } from "../src/router.ts";
import { renderSkillBlock } from "../src/prompt.ts";
import { USD_PER_INPUT_TOKEN } from "../src/types.ts";
import { loadEnv, ms, requireKey, table, transport } from "./util.ts";

loadEnv();

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const message = positional.join(" ") || (await readStdin()).trim();
if (!message) {
  console.error('Usage: npx tsx bin/route.ts "your turn here" [--rerank] [--deadline 400]');
  process.exit(1);
}

requireKey();

const deadlineMs = Number(value("deadline") ?? DEFAULT_DEADLINE_MS);
const router = createRouter({
  deadlineMs,
  rerank: flag("rerank"),
  ...(flag("strings") ? { structuredSkillCriteria: false } : {}),
  ...transport(),
});

// A one-shot CLI always pays the handshake, which a long-lived harness pays once. Warm
// it first so the printed timing is the one a real turn would see.
if (!flag("cold")) await router.prewarm();

const route = await router.route({ message });
const { telemetry: t } = route;

console.log();
console.log(`  turn      ${JSON.stringify(message)}`);
console.log();
console.log(
  table([
    ["  model", route.model, `(${route.tier})`],
    ["  effort", route.effort, ""],
    ["  tools", route.tools.length ? route.tools.join(", ") : "—", ""],
    ["  skill", route.skill ?? "—", ""],
    ["  source", route.source, `${t.hops} hop${t.hops === 1 ? "" : "s"}`],
  ]),
);
console.log();
console.log(
  `  ${ms(t.totalMs)} total, ${ms(t.jevMs)} in jev (deadline ${ms(deadlineMs)})` +
    `  ·  ${t.inputTokens} in / ${t.outputTokens} out` +
    `  ·  $${(t.inputTokens * USD_PER_INPUT_TOKEN * 1000).toFixed(4)} per 1k turns` +
    (t.model ? `  ·  ${t.model}` : ""),
);
console.log();
for (const line of route.why) console.log(`  · ${line}`);
console.log();
console.log("  appended after the cached system-prompt prefix:");
console.log(
  renderSkillBlock(route)
    .trim()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n"),
);
console.log();
