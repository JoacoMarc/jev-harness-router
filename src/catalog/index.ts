/**
 * Everything a harness needs to describe itself to the router.
 *
 * `defineCatalog` and the card types are the public surface. The `MODELS` / `TOOLS` /
 * `SKILLS` objects and `DEFAULT_CATALOG` are the shipped example, exported so a clone
 * can edit them in place and so the eval has a fixed target.
 */
export * from "./types.ts";
export * from "./default.ts";
export { MODELS } from "./models.ts";
export { TOOLS } from "./tools.ts";
export { SKILLS } from "./skills.ts";
export { COMMAND_PREFIX, CONTINUATIONS } from "./shortcuts.ts";
export * from "./provider.ts";
