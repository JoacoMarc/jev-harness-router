import { createHash } from "node:crypto";

/**
 * The shape of a catalogue, and the object the router runs on.
 *
 * A harness describes itself as three plain objects — model tiers, tools, skills — plus
 * an optional list of turns that need no model at all. `defineCatalog` turns that into a
 * `Catalog`, which is what every other module in this package takes. Nothing outside
 * `src/catalog/` names a tool, a skill or a tier; they all reach them through here.
 *
 * The types flow from the spec. `defineCatalog({ ... })` infers the literal tier names
 * and the tool and skill keys, so `route.skill` on a router built from your catalogue is
 * a union of *your* skill ids, and a `switch` over `route.tier` is exhaustiveness-checked
 * against *your* ladder.
 */

// ---------------------------------------------------------------- effort

/** Ordered from least to most reasoning budget. The order is load-bearing. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export function effortIndex(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return effortIndex(a) >= effortIndex(b) ? a : b;
}

export function effortAt(index: number): Effort {
  return EFFORTS[Math.min(Math.max(index, 0), EFFORTS.length - 1)] as Effort;
}

// ---------------------------------------------------------------- cards

export interface ModelCard {
  /** The name the router hands back as `route.tier`. Unique within a catalogue. */
  readonly tier: string;
  /** Whatever your harness passes to its provider. Nothing here parses it. */
  readonly id: string;
  readonly label: string;
  /** What this tier is for, in the harness operator's terms. Never sent to Jev. */
  readonly use: string;
  /**
   * List price in USD per million tokens, for `npm run savings` and anything else that
   * wants to put a number on a routing decision. Never sent to Jev; optional.
   */
  readonly price?: { readonly input: number; readonly output: number };
  /**
   * Patterns that mean "this turn deserves at least this tier", for the offline
   * heuristic only — the fallback when Jev misses the deadline, and the baseline the
   * eval scores against. Jev never sees them.
   *
   * Matched against diacritic-folded text, so write them unaccented: `arregl\w*`
   * catches "arreglá". The cheapest tier declares an empty list: it is the floor, so
   * nothing has to match for a turn to land there.
   */
  readonly hints?: readonly RegExp[];
}

/**
 * What it costs to be wrong about enabling this tool.
 *
 * Enabling a read-only tool nobody needed wastes a little context. Enabling `Bash` on a
 * turn that did not ask for it hands an untrusted user message a shell. The state Jev
 * reads is attacker-influenced by construction, and `jev-1.13` does not treat state as
 * hostile, so the floor has to live here in code rather than in the model's answer.
 */
export const RISKS = ["read", "write", "execute"] as const;
export type Risk = (typeof RISKS)[number];

/** Default Noul probability a tool must clear to be enabled, by risk class. */
export const RISK_THRESHOLD: Record<Risk, number> = {
  read: 0.35,
  write: 0.6,
  execute: 0.8,
};

export interface ToolCard {
  /** What kind of request the tool serves, not what its API looks like. Sent to Jev. */
  readonly description: string;
  readonly risk: Risk;
  /** Overrides `RISK_THRESHOLD[risk]` when this specific tool needs a different bar. */
  readonly threshold?: number;
  /** Always enabled, never asked about. Keeps cheap always-on tools out of the request. */
  readonly always?: true;
  /**
   * Patterns for the offline heuristic only — the fallback when Jev misses the deadline,
   * and the baseline the eval scores against. Jev never sees them; it reads
   * `description`.
   *
   * Matched against diacritic-folded text, so write them unaccented.
   */
  readonly hints?: readonly RegExp[];
}

export interface SkillCard {
  /** What kind of request the skill serves. Sent to Jev on every turn. */
  readonly description: string;
  /** The neighbouring skill this one keeps getting confused with. */
  readonly notFor?: string;
  readonly examples?: readonly string[];
  /**
   * The longer text, sent **only on the second hop**.
   *
   * This is what makes a rerank worth its round trip: the wide pass ranks every skill on
   * one line each, and the finalists are then re-read against something the ranking never
   * saw. Without it the second call re-reads identical criteria and buys nothing. Paste a
   * paragraph of the skill's own documentation.
   */
  readonly detail?: string;
  /**
   * Patterns for the offline heuristic only — the fallback when Jev misses the deadline,
   * and the baseline the eval scores against. Jev never sees them; it reads
   * `description`, `notFor` and `examples`.
   *
   * Matched against diacritic-folded text, so write them unaccented.
   */
  readonly hints?: readonly RegExp[];
}

export interface ShortcutSpec {
  /** A turn matching this is the harness's own command, already routed by definition. */
  readonly commandPrefix?: RegExp;
  /**
   * Bare acknowledgements and continuations, lowercased and with trailing punctuation
   * stripped before lookup. Matched as written and with diacritics folded away.
   */
  readonly continuations?: Iterable<string>;
}

// ---------------------------------------------------------------- the spec

export interface CatalogSpec {
  /**
   * Ordered cheapest and fastest first. **The order is the capability ladder** — policy
   * escalates by index, so an entry's position matters more than its name.
   */
  readonly models: readonly ModelCard[];
  /** Keyed by whatever your harness calls the tool. */
  readonly tools: Readonly<Record<string, ToolCard>>;
  /**
   * Keyed by skill id. **Declaration order is the heuristic's precedence**: the offline
   * fallback takes the first card whose `hints` match, so specific entries go above
   * general ones. Jev does not care — a Choice's criteria is a map.
   */
  readonly skills: Readonly<Record<string, SkillCard>>;
  readonly shortcuts?: ShortcutSpec;
}

export type TierOf<C extends CatalogSpec> = C["models"][number]["tier"];
export type ToolIdOf<C extends CatalogSpec> = Extract<keyof C["tools"], string>;
export type SkillIdOf<C extends CatalogSpec> = Extract<keyof C["skills"], string>;

/** The no-match outcome. Not a skill: the absence of one. */
export const NO_SKILL = "none";

/** Choice options are capped by the API; `none` takes one of them. */
export const MAX_CHOICE_OPTIONS = 255;

export const DEFAULT_COMMAND_PREFIX = /^\//;

// ---------------------------------------------------------------- the catalogue

/**
 * A catalogue the router can run on: the spec, plus everything derived from it once.
 *
 * Build one with `defineCatalog`, which keeps the literal types; `new Catalog(spec)`
 * works too but widens them unless the spec is `as const`.
 */
export class Catalog<C extends CatalogSpec = CatalogSpec> {
  readonly models: C["models"];
  readonly tiers: readonly TierOf<C>[];
  readonly tools: C["tools"];
  readonly toolIds: readonly ToolIdOf<C>[];
  readonly skills: C["skills"];
  readonly skillIds: readonly SkillIdOf<C>[];
  readonly commandPrefix: RegExp;
  readonly continuations: ReadonlySet<string>;
  /**
   * A fingerprint of every entry that reaches the model.
   *
   * It is part of the cache key: adding a tool or rewording a skill description changes
   * the questions, which changes the answers, so yesterday's cached decision is stale
   * even for a byte-identical turn. Hints are regexes and never reach the model, so they
   * are not part of it.
   */
  readonly version: string;

  private readonly byTier: ReadonlyMap<string, ModelCard>;

  constructor(readonly spec: C) {
    validate(spec);
    this.models = spec.models;
    this.tiers = spec.models.map((m) => m.tier) as TierOf<C>[];
    this.tools = spec.tools;
    this.toolIds = Object.keys(spec.tools) as ToolIdOf<C>[];
    this.skills = spec.skills;
    this.skillIds = Object.keys(spec.skills) as SkillIdOf<C>[];
    this.commandPrefix = spec.shortcuts?.commandPrefix ?? DEFAULT_COMMAND_PREFIX;
    this.continuations = new Set(spec.shortcuts?.continuations ?? []);
    this.byTier = new Map(spec.models.map((m) => [m.tier, m]));
    this.version = createHash("sha256")
      .update(
        JSON.stringify({
          models: spec.models,
          tools: spec.tools,
          skills: spec.skills,
          continuations: [...this.continuations],
        }),
      )
      .digest("hex")
      .slice(0, 12);
  }

  modelFor(tier: TierOf<C>): ModelCard {
    const card = this.byTier.get(tier);
    if (!card) throw new Error(`Unknown tier "${tier}". It is not in this catalogue.`);
    return card;
  }

  tierIndex(tier: TierOf<C>): number {
    return this.tiers.indexOf(tier);
  }

  /** The tier at `index`, clamped to the ladder. */
  tierAt(index: number): TierOf<C> {
    return this.tiers[Math.min(Math.max(index, 0), this.tiers.length - 1)] as TierOf<C>;
  }

  /** Never de-escalate silently: returns whichever tier is more capable. */
  maxTier(a: TierOf<C>, b: TierOf<C>): TierOf<C> {
    return this.tierIndex(a) >= this.tierIndex(b) ? a : b;
  }

  toolCard(id: ToolIdOf<C>): ToolCard {
    return this.tools[id] as ToolCard;
  }

  skillCard(id: SkillIdOf<C>): SkillCard {
    return this.skills[id] as SkillCard;
  }

  thresholdFor(id: ToolIdOf<C>): number {
    const card = this.toolCard(id);
    return card.threshold ?? RISK_THRESHOLD[card.risk];
  }

  isToolId(value: string): value is ToolIdOf<C> {
    return Object.hasOwn(this.tools, value);
  }

  isSkillId(value: string): value is SkillIdOf<C> {
    return Object.hasOwn(this.skills, value);
  }
}

/**
 * Builds a `Catalog` and keeps the literal types of everything in it.
 *
 * ```ts
 * const catalog = defineCatalog({
 *   models: [
 *     { tier: "small", id: "gpt-5-mini", label: "Mini", use: "…" },
 *     { tier: "large", id: "gpt-5", label: "Full", use: "…" },
 *   ],
 *   tools: { read_file: { description: "…", risk: "read" } },
 *   skills: { deploy: { description: "…" } },
 * });
 * const router = createRouter({ catalog });
 * const route = await router.route({ message });
 * route.tier;  // "small" | "large"
 * route.skill; // "deploy" | null
 * ```
 */
export function defineCatalog<const C extends CatalogSpec>(spec: C): Catalog<C> {
  return new Catalog(spec);
}

function validate(spec: CatalogSpec): void {
  if (spec.models.length === 0) throw new Error("A catalogue needs at least one model tier.");
  const tiers = new Set<string>();
  for (const m of spec.models) {
    if (tiers.has(m.tier)) throw new Error(`Duplicate tier "${m.tier}" in catalogue.models.`);
    tiers.add(m.tier);
  }
  for (const [what, ids] of [
    ["tools", Object.keys(spec.tools)],
    ["skills", Object.keys(spec.skills)],
  ] as const) {
    if (ids.includes(NO_SKILL)) {
      throw new Error(
        `"${NO_SKILL}" is reserved for the no-match option; rename that entry in catalogue.${what}.`,
      );
    }
    if (ids.length + 1 > MAX_CHOICE_OPTIONS) {
      throw new Error(
        `catalogue.${what} has ${ids.length} entries; the API caps a Choice at ${MAX_CHOICE_OPTIONS} options including "${NO_SKILL}".`,
      );
    }
    for (const id of ids) {
      if (id.includes("::")) {
        throw new Error(
          `"${id}" in catalogue.${what}: ids cannot contain "::", it separates question namespaces.`,
        );
      }
    }
  }
}
