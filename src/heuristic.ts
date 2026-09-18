import { MODELS, type SkillId, type ToolId } from "./catalog/index.ts";
import type { PolicyResult } from "./policy.ts";
import type { TurnInput } from "./types.ts";

/**
 * The route the harness takes when Jev is not involved.
 *
 * Two jobs, on purpose. It is the fallback when the deadline passes, and it is the
 * baseline `npm run eval` measures against — a router that cannot beat a page of
 * regexes is not worth a network call, and the only way to know is to keep the regexes
 * around and score them on the same fixtures.
 *
 * Deliberately not a strawman: it matches the keywords a person would reach for first.
 */

const CONTINUATIONS = new Set([
  "ok", "okay", "oka", "k", "yes", "yeah", "yep", "sure", "thanks", "thank you", "ty",
  "si", "sí", "dale", "listo", "bueno", "perfecto", "genial", "gracias", "joya", "va",
  "continue", "continuá", "continua", "seguí", "segui", "sigue", "go on", "go ahead",
  "next", "done", "👍", "👌", "🙏", "+1",
]);

/**
 * Every pattern below runs against `normalize()`d text, never the raw message.
 *
 * `\w` does not match accented characters, so `arregl\w+` silently fails on "arreglá" —
 * which is most of how this user actually writes. Folding the diacritics away first is
 * cheaper and less error-prone than accent classes in twenty separate patterns.
 */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const DEEP = /\b(refactor\w*|arquitectur\w*|architect\w*|migrat\w*|migrac\w*|redisen\w*|redesign|trade-?offs?|estrateg\w*|strateg\w*|por que|why does|design (a|the)|disen\w*)\b/i;
const MEDIUM = /\b(implement\w*|agreg\w*|add |featur\w*|bug|error|falla|rompe|broken|fix|arregl\w*|test\w*|refactor|integr\w*|debug\w*)\b/i;

const TOOL_HINTS: Partial<Record<ToolId, RegExp>> = {
  Read: /\b(lee|leer|read|mir[a]?\w*|ver|show me|abri\w*|open)\b|\.\w{2,4}\b/i,
  Grep: /\b(busc\w*|search|find|donde|where is|grep|encontr\w*)\b/i,
  Glob: /\b(archivos?|files?|carpeta|folder|directory|directorio)\b/i,
  Edit: /\b(cambi\w*|modific\w*|arregl\w*|fix|updat\w*|edit\w*|renombr\w*|renam\w*|refactor\w*)\b/i,
  Write: /\b(crea\w*|nuevo archivo|new file|escrib\w*|write|gener\w*)\b/i,
  Bash: /\b(corre\w*|ejecut\w*|run|npm|pnpm|yarn|git|build|deploy|instal\w*|tests?|compil\w*)\b/i,
  WebFetch: /https?:\/\//i,
  WebSearch: /\b(busc\w* en (la )?web|google|search online|ultim\w* version|docs? de)\b/i,
  Task: /\b(investig\w*|explor\w*|revisa todo|research|audit\w*)\b/i,
  TodoWrite: /\b(pasos?|steps?|plan|checklist|primero.*despues)\b/i,
};

const SKILL_HINTS: ReadonlyArray<readonly [SkillId, RegExp]> = [
  ["docx-to-trello", /\b(word|docx|documento).*(trello|cards?)|trello.*(word|docx)\b/i],
  ["trello-cli", /\btrello\b/i],
  ["ita-create-pr", /\b(pull request|\bpr\b|abrir? el pr|subir? a review)\b/i],
  ["ita-commit", /\b(commit\w*|commitea\w*)\b/i],
  ["ita-review-code", /\b(revis\w*|review)\b.*\b(codigo|code)\b/i],
  ["security-review", /\b(seguridad|security)\b.*\b(revis\w*|review|audit\w*)\b/i],
  ["ltmsoft-doc-create", /\b(ltm|plantilla de ltm)\b/i],
  ["save-conventions", /\b(claude\.md|convencion|guarda esto)\b/i],
  ["incident-response", /\b(incidente|incident|produccion (esta )?caid\w*|outage|pager)\b/i],
  ["deploy-checklist", /\b(deploy\w*|release|shipp?ear|salir a prod)\b/i],
  ["debug", /\b(stack ?trace|no anda|rompe|falla|error|exception|debug\w*)\b/i],
  ["testing-strategy", /\b(estrategia de test|test plan|que testear|coverage)\b/i],
  ["architecture", /\b(adr|decision de arquitectura|architecture decision)\b/i],
  ["system-design", /\b(disen\w* (un|el) sistema|system design|modelo de datos)\b/i],
  ["documentation", /\b(readme|documentacion|documenta\w*|runbook)\b/i],
  ["tech-debt", /\b(deuda tecnica|tech debt|refactor\w* pendiente)\b/i],
  ["standup", /\b(standup|daily)\b/i],
  ["code-review", /\b(revis\w*|review)\b/i],
  ["xlsx", /\b(excel|xlsx|planilla|spreadsheet|csv)\b/i],
  ["pptx", /\b(powerpoint|pptx|slides?|presentacion)\b/i],
  ["docx", /\b(word|docx)\b/i],
  ["pdf", /\bpdf\b/i],
  ["run", /\b(corre la app|levanta\w*|arranca el server|run the app)\b/i],
  ["init", /\bclaude\.md\b.*\b(crea\w*|nuevo|init)\b/i],
];

/** True when this turn is trivially classifiable and needs no model call at all. */
export function isShortcut(input: TurnInput): boolean {
  const text = input.message.trim();
  if (text.length === 0) return true;
  if (text.startsWith("/")) return true;
  const bare = text.toLowerCase().replace(/[.!¡]+$/, "");
  return CONTINUATIONS.has(bare) || CONTINUATIONS.has(normalize(bare));
}

/** The cheapest possible route, for turns that cannot need anything. */
export function shortcutRoute(input: TurnInput): PolicyResult {
  const text = input.message.trim();
  const why = text.startsWith("/")
    ? ["slash command: the harness already knows what to run"]
    : text.length === 0
      ? ["empty turn"]
      : ["bare continuation"];
  return {
    tier: "fast",
    model: MODELS.fast.id,
    effort: "low",
    tools: [],
    skill: null,
    why,
    diagnostics: emptyDiagnostics(),
  };
}

export function heuristicRoute(input: TurnInput): PolicyResult {
  if (isShortcut(input)) return shortcutRoute(input);

  const text = normalize(`${input.message}\n${input.recentContext ?? ""}`);
  const long = input.message.trim().length > 220;

  const tier = DEEP.test(text) || long ? "deep" : MEDIUM.test(text) ? "balanced" : "fast";
  const effort = tier === "deep" ? "high" : tier === "balanced" ? "medium" : "low";

  const blocked = new Set(input.session?.unavailableTools ?? []);
  const tools = (Object.keys(TOOL_HINTS) as ToolId[]).filter(
    (id) => !blocked.has(id) && TOOL_HINTS[id]?.test(text) === true,
  );

  let skill: SkillId | null = null;
  for (const [id, pattern] of SKILL_HINTS) {
    if (pattern.test(text)) {
      skill = id;
      break;
    }
  }

  return {
    tier,
    model: MODELS[tier].id,
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
