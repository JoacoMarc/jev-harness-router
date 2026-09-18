/**
 * The harness tool catalogue.
 *
 * ── Edit this file to make the router yours. ─────────────────────────────────
 * Replace the entries with the tools your harness can actually offer. `ToolId`,
 * the question set and `route.tools` all derive from the keys, so nothing else
 * needs touching.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Tool selection is multi-label: several tools can apply to one turn, and it is
 * perfectly normal for none to apply. That rules out a Choice, which is relative and
 * always settles on a winner. Each tool gets its own Noul, which is absolute and can
 * come back low for every tool at once.
 *
 * Descriptions say what kind of request the tool serves, not what its API looks like.
 * Jev matches on meaning, so "read a file the user named" separates turns better than
 * "reads a file from the filesystem".
 */

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

export const TOOLS = {
  Read: {
    description:
      "Open a specific file the user named or pointed at, to look at its contents.",
    risk: "read",
    hints: [/\b(lee|leer|read|mir[a]?\w*|ver|show me|abri\w*|open)\b|\.\w{2,4}\b/i],
  },
  Glob: {
    description:
      "Find files by name or path pattern when the user does not know where something lives.",
    risk: "read",
    hints: [/\b(archivos?|files?|carpeta|folder|directory|directorio)\b/i],
  },
  Grep: {
    description:
      "Search the codebase for a symbol, string, or pattern to locate where something is defined or used.",
    risk: "read",
    hints: [/\b(busc\w*|search|find|donde|where is|grep|encontr\w*)\b/i],
  },
  Edit: {
    description:
      "Change code or text in a file that already exists, to fix, refactor, or extend it.",
    risk: "write",
    hints: [/\b(cambi\w*|modific\w*|arregl\w*|fix|updat\w*|edit\w*|renombr\w*|renam\w*|refactor\w*)\b/i],
  },
  Write: {
    description:
      "Create a new file, or replace an existing one wholesale.",
    risk: "write",
    hints: [/\b(crea\w*|nuevo archivo|new file|escrib\w*|write|gener\w*)\b/i],
  },
  NotebookEdit: {
    description: "Modify cells in a Jupyter notebook (.ipynb).",
    risk: "write",
    hints: [/\b(notebook|jupyter|ipynb)\b/i],
  },
  Bash: {
    description:
      "Run a shell command: build, test, install, inspect git history, or drive a CLI.",
    risk: "execute",
    hints: [/\b(corre\w*|ejecut\w*|run|npm|pnpm|yarn|git|build|deploy|instal\w*|tests?|compil\w*)\b/i],
  },
  WebFetch: {
    description:
      "Read a specific web page or API the user linked to, or documentation for a named library.",
    risk: "read",
    hints: [/https?:\/\//i],
  },
  WebSearch: {
    description:
      "Look something up on the open web because the answer is not in this repository and no URL was given.",
    risk: "read",
    hints: [/\b(busc\w* en (la )?web|google|search online|ultim\w* version|docs? de)\b/i],
  },
  Task: {
    description:
      "Delegate a broad, open-ended search or a long independent sub-job to a separate agent.",
    risk: "read",
    threshold: 0.6,
    hints: [/\b(investig\w*|explor\w*|revisa todo|research|audit\w*)\b/i],
  },
  TodoWrite: {
    description:
      "Track the steps of a multi-step job the user asked for, so progress is visible.",
    risk: "write",
    threshold: 0.65,
    hints: [/\b(pasos?|steps?|plan|checklist|primero.*despues)\b/i],
  },
} as const satisfies Record<string, ToolCard>;

export type ToolId = keyof typeof TOOLS;

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];

export function thresholdFor(id: ToolId): number {
  const card: ToolCard = TOOLS[id];
  return card.threshold ?? RISK_THRESHOLD[card.risk];
}

export function isToolId(value: string): value is ToolId {
  return Object.hasOwn(TOOLS, value);
}
