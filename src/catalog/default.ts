import { MODELS } from "./models.ts";
import { COMMAND_PREFIX, CONTINUATIONS } from "./shortcuts.ts";
import { SKILLS } from "./skills.ts";
import { TOOLS } from "./tools.ts";
import { defineCatalog, type NO_SKILL, type SkillIdOf, type TierOf, type ToolIdOf } from "./types.ts";

/**
 * The catalogue the router runs on when you do not hand it one.
 *
 * It is the author's own harness — Claude tiers, Claude Code's tools, one team's skills
 * — and it is here so `createRouter()` with no arguments does something real, and so
 * the fixtures, the eval and the bench have a fixed target. As a dependency you almost
 * certainly want `createRouter({ catalog: defineCatalog({ ... }) })` instead.
 */
export const DEFAULT_CATALOG = defineCatalog({
  models: MODELS,
  tools: TOOLS,
  skills: SKILLS,
  shortcuts: { commandPrefix: COMMAND_PREFIX, continuations: CONTINUATIONS },
});

export type DefaultCatalog = typeof DEFAULT_CATALOG;
export type DefaultCatalogSpec = DefaultCatalog["spec"];

/** The default catalogue's tier names. Generic code uses `TierOf<C>` instead. */
export type Tier = TierOf<DefaultCatalogSpec>;
/** The default catalogue's tool ids. Generic code uses `ToolIdOf<C>` instead. */
export type ToolId = ToolIdOf<DefaultCatalogSpec>;
/** The default catalogue's skill ids. Generic code uses `SkillIdOf<C>` instead. */
export type SkillId = SkillIdOf<DefaultCatalogSpec>;
export type SkillChoice = SkillId | typeof NO_SKILL;

export const TIERS: readonly Tier[] = DEFAULT_CATALOG.tiers;
export const TOOL_IDS: readonly ToolId[] = DEFAULT_CATALOG.toolIds;
export const SKILL_IDS: readonly SkillId[] = DEFAULT_CATALOG.skillIds;
export const CATALOG_VERSION: string = DEFAULT_CATALOG.version;
