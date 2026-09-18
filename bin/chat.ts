/**
 * Route a turn, then actually run it.
 *
 *   npm run chat
 *   npm run chat -- "arreglá el bug de auth en el login"
 *
 * This is the half the router does not do. `bin/route.ts` prints a decision; this takes
 * that decision and sends the turn to the model it chose, at the effort it chose, with
 * the skill it chose appended after the cached prefix — and shows you the reply, what it
 * cost, and how much of the prompt the provider served from cache.
 *
 * It does **not** execute tools. The router decides which tools a turn should have; a
 * real harness turns that into tool definitions and an execute loop with whatever
 * sandboxing it needs. An example that ran model-chosen shell commands on your machine
 * would be a bad thing to ship. The tool decision is shown and handed to the model as
 * context; running it is your harness's job.
 */
import { SKILLS, SKILL_IDS, TOOLS, modelFor } from "../src/catalog/index.ts";
import { PROVIDER } from "../src/catalog/provider.ts";
import { createRouter } from "../src/router.ts";
import { systemPromptParts } from "../src/prompt.ts";
import { complete, hasProviderKey, ProviderError } from "../src/provider.ts";
import type { Message } from "../src/provider.ts";
import type { RouteDecision } from "../src/types.ts";
import { loadEnv, ms, requireKey } from "./util.ts";

loadEnv();
requireKey();

if (!hasProviderKey()) {
  console.error(
    `\n  ${PROVIDER.apiKeyEnv} is not set.\n` +
      `  Add it to .env, or change provider in src/catalog/provider.ts —\n` +
      `  that file lists Anthropic, OpenAI, Groq, OpenRouter, Ollama and friends.\n`,
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const oneShot = argv.filter((a) => !a.startsWith("--")).join(" ");

/**
 * The stable half of the system prompt.
 *
 * Built once and never varied, because that is the whole point: it carries the cache
 * breakpoint, and the router's suggestion goes after it. If this string moved between
 * turns the provider's prompt cache would miss every time.
 */
const ROSTER = [
  "You are a coding assistant inside a harness.",
  "",
  "Skills available to this session. Load one only if it fits what the user asked for:",
  ...SKILL_IDS.map((id) => `- ${id}: ${SKILLS[id].description}`),
].join("\n");

/** Recent turns, kept short: the router degrades on state it does not need. */
const HISTORY_TURNS = 6;
const CONTEXT_CHARS = 400;

const router = createRouter();
const history: Message[] = [];

function describe(route: RouteDecision): string {
  const tools = route.tools.length ? route.tools.join(", ") : "none";
  return (
    `    router  ${modelFor(route.tier).label} · effort ${route.effort} · ` +
    `skill ${route.skill ?? "none"} · tools ${tools}` +
    `\n            ${ms(route.telemetry.totalMs)} to decide, via ${route.source}`
  );
}

async function turn(message: string): Promise<void> {
  const recentContext = history
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-CONTEXT_CHARS);

  const route = await router.route({ message, recentContext });
  console.log(describe(route));

  const { cached, suffix } = systemPromptParts(ROSTER, route);
  // The tool decision reaches the model as context rather than as callable tools. See
  // the note at the top: this example decides, it does not execute.
  const toolNote = route.tools.length
    ? `\n\n<tools_enabled>\nThe harness has enabled: ${route.tools
        .map((t) => `${t} (${TOOLS[t].description})`)
        .join("; ")}\n</tools_enabled>`
    : "";

  history.push({ role: "user", content: message });
  try {
    const reply = await complete({
      model: route.model,
      effort: route.effort,
      systemCached: cached,
      systemSuffix: suffix + toolNote,
      messages: history.slice(-HISTORY_TURNS * 2),
    });
    history.push({ role: "assistant", content: reply.text });

    const cache = reply.cachedTokens > 0 ? `, ${reply.cachedTokens} from cache` : "";
    console.log(
      `    model   ${reply.model} · ${ms(reply.ms)} · ` +
        `${reply.inputTokens} in${cache} / ${reply.outputTokens} out\n`,
    );
    console.log(reply.text.replace(/^/gm, "  "));
    console.log();
  } catch (error) {
    history.pop();
    if (error instanceof ProviderError) {
      console.error(`\n    provider error ${error.message}\n`);
      // A model id the router chose but the provider does not have is the likeliest
      // cause, and it is a catalogue problem rather than a routing one.
      if (error.status === 404 || error.status === 400) {
        console.error(
          `    Check that "${route.model}" exists on this provider.` +
            ` Model ids live in src/catalog/models.ts.\n`,
        );
      }
    } else {
      console.error(`\n    ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

process.stderr.write("warming up... ");
await router.prewarm();
process.stderr.write("ready\n");

if (oneShot) {
  await turn(oneShot);
  process.exit(0);
}

const { createInterface } = await import("node:readline/promises");
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));

console.log(
  `\n  Routing to ${PROVIDER.kind}, then running the turn there.` +
    `\n  Type a turn and press enter. Ctrl-C to leave.\n`,
);

for (;;) {
  let line: string;
  try {
    line = (await rl.question("  > ")).trim();
  } catch {
    break;
  }
  if (!line) continue;
  if (line === ".quit" || line === ".exit") break;
  if (line === ".reset") {
    history.length = 0;
    console.log("    history cleared\n");
    continue;
  }
  await turn(line);
}
rl.close();
console.log();
process.exit(0);
