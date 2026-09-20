import {
  DEFAULT_CATALOG,
  EFFORTS,
  effortAt,
  type Catalog,
  type CatalogSpec,
  type DefaultCatalogSpec,
  type SkillIdOf,
  type TierOf,
  type ToolIdOf,
} from "./catalog/index.ts";
import type { PolicyResult } from "./policy.ts";
import type { TurnInput } from "./types.ts";

/**
 * The route the harness takes when Jev is not involved.
 *
 * Two jobs, on purpose. It is the fallback when the deadline passes, and it is the
 * baseline `npm run eval` scores against — a router that cannot beat a page of regexes
 * is not worth a network call, and the only way to know is to keep the regexes around
 * and score them on the same fixtures.
 *
 * **Nothing here names a tool, a skill or a tier.** Every pattern lives on the catalogue
 * entry it belongs to, so replacing the catalogue replaces the heuristic with it. A card
 * with no `hints` simply never fires, which is a fine place to start.
 */

/**
 * Folds diacritics away before matching.
 *
 * `\w` does not match accented characters, so `arregl\w*` silently fails on "arreglá".
 * Folding once here is cheaper and far less error-prone than accent classes in fifty
 * separate patterns spread across three catalogue files.
 */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Message length past which a turn is treated as substantial regardless of wording. */
export const LONG_MESSAGE_CHARS = 220;

const fallbackCatalog = <C extends CatalogSpec>(): Catalog<C> =>
  DEFAULT_CATALOG as unknown as Catalog<C>;

/** True when this turn is trivially classifiable and needs no model call at all. */
export function isShortcut<C extends CatalogSpec = DefaultCatalogSpec>(
  input: TurnInput,
  catalog: Catalog<C> = fallbackCatalog<C>(),
): boolean {
  const text = input.message.trim();
  if (text.length === 0) return true;
  if (catalog.commandPrefix.test(text)) return true;
  const bare = text.toLowerCase().replace(/[.!¡]+$/, "");
  return catalog.continuations.has(bare) || catalog.continuations.has(normalize(bare));
}

/** The cheapest possible route, for turns that cannot need anything. */
export function shortcutRoute<C extends CatalogSpec = DefaultCatalogSpec>(
  input: TurnInput,
  catalog: Catalog<C> = fallbackCatalog<C>(),
): PolicyResult<C> {
  const text = input.message.trim();
  const why = catalog.commandPrefix.test(text)
    ? ["slash command: the harness already knows what to run"]
    : text.length === 0
      ? ["empty turn"]
      : ["bare continuation"];
  const tier = catalog.tierAt(0);
  return {
    tier,
    model: catalog.modelFor(tier).id,
    effort: effortAt(0),
    tools: [],
    skill: null,
    why,
    diagnostics: emptyDiagnostics(),
  };
}

/** Takes the card, not its hints, so a card that declares none is still assignable. */
const matches = (card: { readonly hints?: readonly RegExp[] }, text: string): boolean =>
  card.hints?.some((hint) => hint.test(text)) === true;

export function heuristicRoute<C extends CatalogSpec = DefaultCatalogSpec>(
  input: TurnInput,
  catalog: Catalog<C> = fallbackCatalog<C>(),
): PolicyResult<C> {
  if (isShortcut(input, catalog)) return shortcutRoute(input, catalog);

  const text = normalize(`${input.message}\n${input.recentContext ?? ""}`);
  const ladder = catalog.tiers.length;

  // The highest tier whose hints fire wins; the cheapest tier is the floor and needs no
  // hints of its own. A long message is treated as at least the middle of the ladder,
  // because length is evidence the wording may not carry.
  let index = 0;
  catalog.models.forEach((model, i) => {
    if (matches(model, text)) index = Math.max(index, i);
  });
  if (input.message.trim().length > LONG_MESSAGE_CHARS) {
    index = Math.max(index, Math.floor((ladder - 1) / 2));
  }
  const tier: TierOf<C> = catalog.tierAt(index);

  // Effort rides the same ladder, scaled to however many levels each one has.
  const effort = effortAt(
    ladder <= 1 ? 0 : Math.round((index / (ladder - 1)) * (EFFORTS.length - 1)),
  );

  const blocked = new Set(input.session?.unavailableTools ?? []);
  const tools: ToolIdOf<C>[] = catalog.toolIds.filter(
    (id) => !blocked.has(id) && matches(catalog.toolCard(id), text),
  );

  // First match wins, so catalogue order is precedence: specific entries above general.
  let skill: SkillIdOf<C> | null = null;
  for (const id of catalog.skillIds) {
    if (matches(catalog.skillCard(id), text)) {
      skill = id;
      break;
    }
  }

  return {
    tier,
    model: catalog.modelFor(tier).id,
    effort,
    tools,
    skill,
    why: ["keyword heuristic"],
    diagnostics: emptyDiagnostics(),
  };
}

function emptyDiagnostics(): PolicyResult["diagnostics"] {
  return {
    difficulty: 0,
    difficultyConfidence: 0,
    scope: 0,
    intent: "",
    intentConfidence: 0,
    gate: 0,
    gateValues: {},
    skillTop: "",
    skillConfidence: 0,
    skillMargin: 0,
    toolProbabilities: {},
    rerankWorthwhile: false,
  };
}
