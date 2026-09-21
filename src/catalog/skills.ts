/**
 * The skill catalogue.
 *
 * ── The shipped default. ─────────────────────────────────────────────────────
 * Using the package as a dependency? Pass your own to `createRouter({ catalog })`
 * via `defineCatalog` and leave this file alone. Cloned the repo? Edit it here.
 * `SkillId` and `route.skill` derive from the keys.
 *
 * **Declaration order is the heuristic's precedence.** Jev does not care — a
 * Choice's criteria is a map — but the offline fallback takes the first card
 * whose `hints` match, so specific entries go above general ones. `docx-to-trello`
 * sits above `trello-cli` here, and `team-code-review` above `code-review`, for
 * exactly that reason.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Exactly one skill applies to a turn, or none does, so this is a Choice with an
 * explicit `none` option — every routing Choice needs a no-match escape hatch, or the
 * closest wrong option wins by default.
 *
 * `description` says what kind of request the skill serves. `notFor` names the
 * neighbouring skill it keeps getting confused with; it is unused in the default
 * string criteria and only materialises in the structured variant, which `bin/eval.ts`
 * A/B-tests. The docs recommend structured criteria but publish no measurement for
 * them, and this request runs on every turn, so it earns its tokens or it stays off.
 */

import type { SkillCard } from "./types.ts";

export const SKILLS = {
  "docx-to-trello": {
    description: "Turn a Word document of numbered items into one Trello backlog card per item.",
    notFor: "Ordinary Trello operations with no document involved, which is trello-cli.",
    examples: ["pasá este word a Trello", "importá el doc como cards"],
    detail:
      "Reads a .docx whose body is a numbered list and creates one Trello card per item, in the Backlog. The document is the input; Trello is the output. If there is no document, this is not the skill.",
    hints: [/\b(word|docx|documento)\b.*\b(trello|cards?)\b|\btrello\b.*\b(word|docx)\b/i],
  },
  "trello-cli": {
    description: "Read or change Trello boards, lists and cards from the command line.",
    examples: ["qué tengo en el Trello", "movelo a En Progreso"],
    detail:
      "Board, list and card operations through the Trello CLI: listing what is open, moving a card between lists, adding or commenting. Works from an existing board; it does not import anything.",
    hints: [/\btrello\b/i],
  },
  "create-pr": {
    description: "Open a GitHub pull request using the team template: title, description, checklist.",
    notFor: "Making the commit itself, which is commit.",
    examples: ["abrí el PR", "subí esto a review"],
    detail:
      "Opens a pull request against the current branch using the team template: a title in Conventional Commits form, a description of what changed and why, a reviewer checklist. Assumes the work is already committed and pushed.",
    hints: [/\b(pull request|pr\b|abrir? el pr|subir? a review)\b/i],
  },
  "commit": {
    description: "Commit staged work with a Conventional Commits message in the team's format.",
    notFor: "Opening a pull request, which is create-pr.",
    examples: ["commiteá esto", "hacé el commit de los cambios"],
    detail:
      "Stages the right files and writes a Conventional Commits message in the team's format. Ends at the commit: it does not push and it does not open anything.",
    hints: [/\b(commit\w*|commitea\w*)\b/i],
  },
  "team-code-review": {
    description: "Review the team's code for bugs, security, performance and quality before it merges.",
    notFor: "A security-only audit of a branch, which is security-review.",
    examples: ["revisá este código", "mirá si esto está bien"],
    detail:
      "Reviews a change against the team's own playbook — their conventions, their past incidents, their definition of done — as well as for bugs, security and performance. Use when the standard being applied is the team's, not a generic one.",
    hints: [/\b(revis\w*|review)\b.*\b(codigo|code)\b/i],
  },
  "security-review": {
    description: "Audit the pending changes on this branch specifically for security problems.",
    examples: ["revisá esto por seguridad", "any injection risk in this branch?"],
    detail:
      "Audits the pending changes on the current branch for security problems specifically: injection, authentication and authorization gaps, secret handling, unsafe deserialization, dependency risk. Narrower and deeper than a general review.",
    hints: [/\b(seguridad|security)\b.*\b(revis\w*|review|audit\w*)\b/i],
  },
  "ltmsoft-doc-create": {
    description: "Produce a branded LTM Software PDF: proposal, technical document or report.",
    notFor: "A plain .docx file with no LTM branding, which is docx.",
    examples: ["armá la propuesta con la plantilla de LTM"],
    detail:
      "Renders content into a branded LTM Software PDF through the LaTeX template: cover page, table of contents, the black header with the logo, purple-header tables. The output is always a PDF, never an editable document.",
    hints: [/\b(ltm|plantilla de ltm)\b/i],
  },
  "save-conventions": {
    description: "Record a project convention, pattern or technical note into CLAUDE.md.",
    examples: ["guardá esta convención", "anotá esto en el CLAUDE.md"],
    hints: [/\b(claude\.md|convencion|guarda esto)\b/i],
  },
  "incident-response": {
    description: "Run a live incident: triage severity, communicate status, then write the postmortem.",
    notFor: "Debugging a bug that is not currently paging anyone, which is debug.",
    examples: ["producción está caída", "escribí el postmortem"],
    hints: [/\b(incidente|incident|produccion (esta )?caid\w*|outage|pager)\b/i],
  },
  "deploy-checklist": {
    description: "Verify a release is safe to ship: migrations, flags, CI, approvals, rollback triggers.",
    examples: ["vamos a deployar, chequeá todo", "listos para release?"],
    hints: [/\b(deploy\w*|release|shipp?ear|salir a prod)\b/i],
  },
  debug: {
    description: "Work backwards from an error, stack trace or regression to its root cause.",
    examples: ["esto rompe desde el deploy", "TypeError en el login"],
    detail:
      "Works backwards from a symptom — an error, a stack trace, a regression, a test that passes locally and fails in CI — to the root cause, then to a fix. Starts from something that is already broken.",
    hints: [/\b(stack ?trace|no anda|rompe|falla|error|exception|debug\w*)\b/i],
  },
  "testing-strategy": {
    description: "Decide what to test and how: coverage, test architecture, a test plan.",
    notFor: "Diagnosing a specific failing test, which is debug.",
    examples: ["qué deberíamos testear acá", "armá el plan de tests"],
    hints: [/\b(estrategia de test|test plan|que testear|coverage)\b/i],
  },
  architecture: {
    description: "Write or evaluate an architecture decision record weighing named alternatives.",
    notFor: "Designing a new system from requirements, which is system-design.",
    examples: ["Kafka o SQS para esto", "escribí el ADR de la decisión"],
    detail:
      "Writes or evaluates an architecture decision record: the decision, the alternatives that were weighed, the trade-offs, the consequences. Assumes the options are already named.",
    hints: [/\b(adr|decision de arquitectura|architecture decision)\b/i],
  },
  "system-design": {
    description: "Design a system, service boundary, API shape or data model from requirements.",
    notFor: "Choosing between two named technologies, which is architecture.",
    examples: ["diseñá el servicio de notificaciones", "cómo modelamos esto"],
    detail:
      "Designs a system, a service boundary, an API shape or a data model from requirements and constraints. Produces a design where none existed.",
    hints: [/\b(disen\w* (un|el) sistema|system design|modelo de datos)\b/i],
  },
  documentation: {
    description: "Write technical documentation: a README, API docs, a runbook, an onboarding guide.",
    examples: ["escribí el README", "documentá este endpoint"],
    hints: [/\b(readme|documentacion|documenta\w*|runbook)\b/i],
  },
  "tech-debt": {
    description: "Find, categorise and prioritise refactoring work and code health problems.",
    examples: ["qué deberíamos refactorizar", "cómo está la salud del código"],
    hints: [/\b(deuda tecnica|tech debt|refactor\w* pendiente)\b/i],
  },
  standup: {
    description: "Turn recent commits, PRs and ticket moves into a standup update.",
    examples: ["armá mi update del daily", "qué hice ayer"],
    hints: [/\b(standup|daily)\b/i],
  },
  run: {
    description: "Launch this project's app and confirm a change works in the real thing.",
    notFor: "Running the test suite, which needs no skill.",
    hints: [/\b(corre la app|levanta\w*|arranca el server|run the app)\b/i],
  },
  init: {
    description: "Create a CLAUDE.md documenting this codebase for the first time.",
    examples: ["creá el CLAUDE.md de este repo"],
    hints: [/\bclaude\.md\b.*\b(crea\w*|nuevo|init)\b/i],
  },
  "code-review": {
    description: "Review the current diff, a PR or a branch for correctness bugs and cleanups.",
    notFor: "Reviewing code against the team's playbook, which is team-code-review.",
    examples: ["revisá el diff antes de mergear", "is this change safe?"],
    detail:
      "Reviews a diff, a pull request or a branch for correctness bugs first, then for reuse, simplification and efficiency. Generic standards, not any one team's playbook.",
    hints: [/\b(revis\w*|review)\b/i],
  },
  xlsx: {
    description: "Create, read or edit a spreadsheet: .xlsx, .csv or .tsv.",
    examples: ["pasá esto a Excel", "arreglá la planilla"],
    hints: [/\b(excel|xlsx|planilla|spreadsheet|csv)\b/i],
  },
  pptx: {
    description: "Create, read or edit a PowerPoint .pptx deck.",
    examples: ["armá las slides", "leé el pptx"],
    hints: [/\b(powerpoint|pptx|slides?|presentacion)\b/i],
  },
  docx: {
    description: "Create, read or edit a Word .docx file.",
    notFor: "An LTM-branded PDF, which is ltmsoft-doc-create.",
    examples: ["armá un word con esto", "leé el .docx"],
    detail:
      "Creates, reads or edits Word .docx and .dotx files: tables of contents, page numbers, letterheads, tracked changes, find-and-replace. The deliverable is an editable Word file.",
    hints: [/\b(word|docx)\b/i],
  },
  pdf: {
    description: "Read, merge, split, fill or otherwise manipulate a PDF file.",
    notFor: "Producing an LTM-branded PDF from scratch, which is ltmsoft-doc-create.",
    examples: ["juntá estos PDFs", "extraé las tablas del pdf"],
    detail:
      "Reads, merges, splits, rotates, watermarks, fills, encrypts or OCRs an existing PDF. Operates on PDFs that already exist.",
    hints: [/\bpdf\b/i],
  },
} as const satisfies Record<string, SkillCard>;
