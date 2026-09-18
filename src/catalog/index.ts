import { createHash } from "node:crypto";
import { MODELS } from "./models.ts";
import { SKILLS } from "./skills.ts";
import { TOOLS } from "./tools.ts";

export * from "./models.ts";
export * from "./skills.ts";
export * from "./tools.ts";

/**
 * A fingerprint of every catalogue entry that reaches the model.
 *
 * It is part of the cache key: adding a tool or rewording a skill description changes
 * the questions, which changes the answers, so yesterday's cached decision is stale
 * even for a byte-identical turn.
 */
export const CATALOG_VERSION = createHash("sha256")
  .update(JSON.stringify({ MODELS, TOOLS, SKILLS }))
  .digest("hex")
  .slice(0, 12);
