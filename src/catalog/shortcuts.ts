/**
 * Turns that need no model call at all.
 *
 * ── The shipped default. ─────────────────────────────────────────────────────
 * These are language- and harness-specific. The list below covers Spanish and
 * English. As a dependency, pass your own under `shortcuts` in `defineCatalog`;
 * in a clone, edit it here. Empty it if your harness never sees bare
 * acknowledgements.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the cheapest lane in the router and the only one that costs nothing, so it is
 * worth keeping accurate. It is also the documented first step of building with System
 * One: direct evidence stays in code, and a slash command is direct evidence.
 */

/** A turn starting with this is the harness's own command, already routed by definition. */
export const COMMAND_PREFIX = /^\//;

/**
 * Bare acknowledgements and continuations, lowercased and with trailing punctuation
 * stripped before lookup. Matched twice: as written, and with diacritics folded away, so
 * "sí" is caught by either spelling.
 */
export const CONTINUATIONS: ReadonlySet<string> = new Set([
  // English
  "ok", "okay", "oka", "k", "yes", "yeah", "yep", "sure", "thanks", "thank you", "ty",
  "continue", "go on", "go ahead", "next", "done",
  // Spanish
  "si", "sí", "dale", "listo", "bueno", "perfecto", "genial", "gracias", "joya", "va",
  "continuá", "continua", "seguí", "segui", "sigue",
  // Wordless
  "👍", "👌", "🙏", "+1",
]);
