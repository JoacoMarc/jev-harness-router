/**
 * What the routing decision is worth, in list price.
 *
 *   npm run savings                          # route the fixtures, price the model mix
 *   npm run savings -- --tokens 12000,1500   # assume this many in/out tokens per turn
 *   MOCK=1 npm run savings                   # the heuristic's mix, not a measurement
 *
 * Routes every fixture turn through the router and prices the resulting model mix against
 * the alternative every harness starts with: the top tier on every turn. This is a **price
 * mix, not a bill** — it assumes every turn costs the same number of tokens whichever
 * model runs it, and takes the list prices from the catalogue's model cards. A cheaper
 * model that needs more turns to finish the same job is not cheaper; measure that with
 * `modelUsage` from the Agent SDK on your own traffic before believing the percentage.
 */
import { DEFAULT_CATALOG, type Tier } from "../src/catalog/index.ts";
import { createRouter } from "../src/router.ts";
import { USD_PER_INPUT_TOKEN } from "../src/types.ts";
import { loadEnv, pct, pool, readFixtures, requireKey, table, transport } from "./util.ts";

loadEnv();
requireKey();

const argv = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [inTokens, outTokens] = (value("tokens") ?? "10000,1000").split(",").map(Number) as [number, number];

const catalog = DEFAULT_CATALOG;
for (const m of catalog.models) {
  if (!m.price) {
    console.error(`Tier "${m.tier}" has no price on its model card; add one in src/catalog/models.ts.`);
    process.exit(1);
  }
}
const price = (tier: Tier) => catalog.modelFor(tier).price as { input: number; output: number };
const top = catalog.tierAt(catalog.tiers.length - 1);

const fixtures = await readFixtures();
const router = createRouter({ deadlineMs: 20_000, ...transport() });
await router.prewarm();

console.error(`routing ${fixtures.length} turns`);
const routes = await pool(fixtures, 4, (f) => router.route(f));

const count = new Map<Tier, number>(catalog.tiers.map((t) => [t, 0]));
let fallbacks = 0;
let routerTokens = 0;
for (const r of routes) {
  count.set(r.tier, (count.get(r.tier) ?? 0) + 1);
  if (r.source === "fallback") fallbacks += 1;
  routerTokens += r.telemetry.inputTokens;
}

const n = routes.length;
const blendedIn = catalog.tiers.reduce((s, t) => s + ((count.get(t) ?? 0) / n) * price(t).input, 0);
const blendedOut = catalog.tiers.reduce((s, t) => s + ((count.get(t) ?? 0) / n) * price(t).output, 0);

const perTurn = (pIn: number, pOut: number) => (inTokens * pIn + outTokens * pOut) / 1_000_000;
const routedTurn = perTurn(blendedIn, blendedOut);
const topTurn = perTurn(price(top).input, price(top).output);
const routerTurn = (routerTokens / n) * USD_PER_INPUT_TOKEN;

console.log();
console.log(
  table([
    ["  tier", "model", "turns", "share", "$/M in", "$/M out"],
    ...catalog.tiers.map((t) => [
      `  ${t}`,
      catalog.modelFor(t).id,
      String(count.get(t) ?? 0),
      pct((count.get(t) ?? 0) / n),
      price(t).input.toFixed(2),
      price(t).output.toFixed(2),
    ]),
    ["  blended", "", String(n), "100.0%", blendedIn.toFixed(2), blendedOut.toFixed(2)],
  ]),
);
console.log();
console.log(`  source: ${n - fallbacks} routed by jev, ${fallbacks} fell back to the heuristic`);
console.log();
console.log(`  assuming ${inTokens.toLocaleString()} input + ${outTokens.toLocaleString()} output tokens per turn:`);
console.log(
  table([
    ["  always " + top, `$${(topTurn * 1000).toFixed(2)} per 1k turns`],
    ["  routed", `$${(routedTurn * 1000).toFixed(2)} per 1k turns`],
    ["  the router itself", `$${(routerTurn * 1000).toFixed(2)} per 1k turns`],
    ["  net saving", `$${((topTurn - routedTurn - routerTurn) * 1000).toFixed(2)} per 1k turns  (${pct(1 - (routedTurn + routerTurn) / topTurn)})`],
  ]),
);
console.log();
console.log("  Same tokens per turn whichever model runs it, list prices from the catalogue, one");
console.log("  person's fixtures. The percentage is the model mix, not your bill.");
console.log();
