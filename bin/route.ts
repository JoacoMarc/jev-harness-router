/**
 * Route turns and show the work.
 *
 *   npx tsx bin/route.ts "arreglá el bug de auth en el login"
 *   npx tsx bin/route.ts                    # interactive: type turns, see routes
 *   echo "..." | npx tsx bin/route.ts --rerank --deadline 800
 *
 * Interactive mode pays the connection warm-up once instead of once per turn, which is
 * the difference between ~1,150ms and ~350ms a turn. It is the honest way to get a feel
 * for the router, because it is the shape a real harness runs in.
 */
import { defaultDeadlineMs } from "../src/jev.ts";
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
const interactive = !message && process.stdin.isTTY;
if (!message && !interactive) {
  console.error(
    'Usage: npx tsx bin/route.ts "your turn here" [--rerank] [--deadline 500] [--strings]\n' +
      "       npx tsx bin/route.ts            (interactive)",
  );
  process.exit(1);
}

requireKey();

const deadlineMs = Number(value("deadline") ?? defaultDeadlineMs());
const router = createRouter({
  deadlineMs,
  rerank: flag("rerank"),
  ...(flag("strings") ? { structuredSkillCriteria: false } : {}),
  ...transport(),
});

// A one-shot CLI always pays the handshake, which a long-lived harness pays once. Warm
// it first so the printed timing is the one a real turn would see.
if (!flag("cold")) {
  if (interactive) process.stderr.write("warming up... ");
  await router.prewarm();
  if (interactive) process.stderr.write("ready\n");
}

if (interactive) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    `\n  Type a turn and press enter. Ctrl-C to leave.` +
      `\n  model tier / effort · skill · tools · timing and where the answer came from\n`,
  );
  // Ctrl-D rejects the pending question rather than resolving it, and Ctrl-C closes the
  // interface out from under it. Both are how people leave a REPL, so neither should
  // print a stack trace.
  rl.on("close", () => process.exit(0));
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("  > ")).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === ".quit" || line === ".exit") break;
    const r = await router.route({ message: line });
    const source = r.source === "jev" ? r.source : `${r.source}!`;
    console.log(
      `    ${`${r.tier}/${r.effort}`.padEnd(16)} ${(r.skill ?? "—").padEnd(20)} ` +
        `${(r.tools.length ? r.tools.join(",") : "—").padEnd(28)} ${ms(r.telemetry.totalMs).padStart(7)} ${source}`,
    );
    // The reasons are the point: a route you cannot interrogate is a route you cannot fix.
    for (const w of r.why) console.log(`      · ${w}`);
    console.log();
  }
  rl.close();
  console.log();
  process.exit(0);
}

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
