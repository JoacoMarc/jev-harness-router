/**
 * Route a turn, then run it on the Claude Agent SDK with the routed options.
 *
 *   npm run example:agent-sdk -- "explicame qué hace src/router.ts"
 *
 * Needs `TYPESAFE_API_KEY` for the router and whatever the Agent SDK needs to run Claude
 * Code (an `ANTHROPIC_API_KEY`, or a logged-in Claude Code). Runs in **plan mode**, so the
 * agent can read this repository but not change it — a demo that edits files or runs
 * model-chosen shell commands on your machine is not something to ship as an example.
 * Drop `permissionMode` in your own harness and let the routed tool set do its job.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadEnv, ms, requireKey } from "../bin/util.ts";
import { toQueryOptions } from "../src/adapters/agent-sdk.ts";
import { createRouter } from "../src/router.ts";

loadEnv();
requireKey();

// `.env.example` ships `ANTHROPIC_API_KEY=your-key-here`. A placeholder is worse than no
// key: it shadows the Claude Code login the SDK would otherwise pick up.
if (process.env.ANTHROPIC_API_KEY === "your-key-here") delete process.env.ANTHROPIC_API_KEY;

const message = process.argv.slice(2).join(" ") || "explicame qué hace src/router.ts";

const router = createRouter();
await router.prewarm();
const route = await router.route({ message });

// The demo is read-only, so the read tools are always there; the router still decides
// everything else — and in your harness, it decides these too.
const routed = toQueryOptions(route, { alwaysTools: ["Read", "Glob", "Grep"] });

console.log(`\n  turn     ${JSON.stringify(message)}`);
console.log(`  routed   ${route.tier} -> ${routed.model} · effort ${routed.effort} · ${ms(route.telemetry.totalMs)} (${route.source})`);
console.log(`  tools    ${routed.tools?.join(", ") ?? "—"}`);
console.log(`  skill    ${route.skill ?? "—"}`);
for (const w of route.why) console.log(`    · ${w}`);
console.log();

const started = performance.now();
try {
  for await (const m of query({
    prompt: message,
    options: {
      ...routed,
      cwd: process.cwd(),
      permissionMode: "plan",
      maxTurns: 8,
    },
  })) {
    if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "text") console.log(block.text);
        else if (block.type === "tool_use") console.log(`  [${block.name}]`);
      }
    } else if (m.type === "result") {
      console.log(`\n  ${m.subtype} in ${ms(performance.now() - started)} · ${m.num_turns} turns · $${m.total_cost_usd.toFixed(4)}`);
      for (const [model, u] of Object.entries(m.modelUsage)) {
        console.log(
          `  ${model}: ${u.inputTokens} in / ${u.outputTokens} out · ${u.cacheReadInputTokens} cached · $${u.costUSD.toFixed(4)}`,
        );
      }
    }
  }
} catch (error) {
  // The SDK surfaces Claude Code's own failure text — usually a missing or invalid key.
  console.error(`
  the Agent SDK could not run the turn: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
