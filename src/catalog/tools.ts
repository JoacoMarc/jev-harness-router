/**
 * The harness tool catalogue.
 *
 * ── The shipped default. ─────────────────────────────────────────────────────
 * Using the package as a dependency? Pass your own to `createRouter({ catalog })`
 * via `defineCatalog` and leave this file alone. Cloned the repo? Edit it here.
 * `ToolId`, the question set and `route.tools` all derive from the keys.
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

import type { ToolCard } from "./types.ts";

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
