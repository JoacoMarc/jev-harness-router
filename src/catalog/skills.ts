/**
 * The skill catalogue.
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

export interface SkillCard {
  readonly description: string;
  readonly notFor?: string;
  readonly examples?: readonly string[];
}

export const SKILLS = {
  "ita-commit": {
    description: "Commit staged work with a Conventional Commits message in the ITA team format.",
    notFor: "Opening a pull request, which is ita-create-pr.",
    examples: ["commiteá esto", "hacé el commit de los cambios"],
  },
  "ita-create-pr": {
    description: "Open a GitHub pull request using the ITA template: title, description, checklist.",
    notFor: "Making the commit itself, which is ita-commit.",
    examples: ["abrí el PR", "subí esto a review"],
  },
  "ita-review-code": {
    description: "Review ITA team code for bugs, security, performance and quality before it merges.",
    notFor: "A security-only audit of a branch, which is security-review.",
    examples: ["revisá este código", "mirá si esto está bien"],
  },
  "trello-cli": {
    description: "Read or change Trello boards, lists and cards from the command line.",
    examples: ["qué tengo en el Trello", "movelo a En Progreso"],
  },
  "docx-to-trello": {
    description: "Turn a Word document of numbered items into one Trello backlog card per item.",
    notFor: "Ordinary Trello operations with no document involved, which is trello-cli.",
    examples: ["pasá este word a Trello", "importá el doc como cards"],
  },
  "save-conventions": {
    description: "Record a project convention, pattern or technical note into CLAUDE.md.",
    examples: ["guardá esta convención", "anotá esto en el CLAUDE.md"],
  },
  "ltmsoft-doc-create": {
    description: "Produce a branded LTM Software PDF: proposal, technical document or report.",
    notFor: "A plain .docx file with no LTM branding, which is docx.",
    examples: ["armá la propuesta con la plantilla de LTM"],
  },
  "code-review": {
    description: "Review the current diff, a PR or a branch for correctness bugs and cleanups.",
    notFor: "Reviewing code against the ITA team playbook, which is ita-review-code.",
    examples: ["revisá el diff antes de mergear", "is this change safe?"],
  },
  "security-review": {
    description: "Audit the pending changes on this branch specifically for security problems.",
    examples: ["revisá esto por seguridad", "any injection risk in this branch?"],
  },
  debug: {
    description: "Work backwards from an error, stack trace or regression to its root cause.",
    examples: ["esto rompe desde el deploy", "TypeError en el login"],
  },
  "testing-strategy": {
    description: "Decide what to test and how: coverage, test architecture, a test plan.",
    notFor: "Diagnosing a specific failing test, which is debug.",
    examples: ["qué deberíamos testear acá", "armá el plan de tests"],
  },
  architecture: {
    description: "Write or evaluate an architecture decision record weighing named alternatives.",
    notFor: "Designing a new system from requirements, which is system-design.",
    examples: ["Kafka o SQS para esto", "escribí el ADR de la decisión"],
  },
  "system-design": {
    description: "Design a system, service boundary, API shape or data model from requirements.",
    notFor: "Choosing between two named technologies, which is architecture.",
    examples: ["diseñá el servicio de notificaciones", "cómo modelamos esto"],
  },
  documentation: {
    description: "Write technical documentation: a README, API docs, a runbook, an onboarding guide.",
    examples: ["escribí el README", "documentá este endpoint"],
  },
  "deploy-checklist": {
    description: "Verify a release is safe to ship: migrations, flags, CI, approvals, rollback triggers.",
    examples: ["vamos a deployar, chequeá todo", "listos para release?"],
  },
  "incident-response": {
    description: "Run a live incident: triage severity, communicate status, then write the postmortem.",
    notFor: "Debugging a bug that is not currently paging anyone, which is debug.",
    examples: ["producción está caída", "escribí el postmortem"],
  },
  "tech-debt": {
    description: "Find, categorise and prioritise refactoring work and code health problems.",
    examples: ["qué deberíamos refactorizar", "cómo está la salud del código"],
  },
  standup: {
    description: "Turn recent commits, PRs and ticket moves into a standup update.",
    examples: ["armá mi update del daily", "qué hice ayer"],
  },
  init: {
    description: "Create a CLAUDE.md documenting this codebase for the first time.",
    examples: ["creá el CLAUDE.md de este repo"],
  },
  run: {
    description: "Launch this project's app and confirm a change works in the real thing.",
    notFor: "Running the test suite, which needs no skill.",
  },
  docx: {
    description: "Create, read or edit a Word .docx file.",
    notFor: "An LTM-branded PDF, which is ltmsoft-doc-create.",
    examples: ["armá un word con esto", "leé el .docx"],
  },
  xlsx: {
    description: "Create, read or edit a spreadsheet: .xlsx, .csv or .tsv.",
    examples: ["pasá esto a Excel", "arreglá la planilla"],
  },
  pptx: {
    description: "Create, read or edit a PowerPoint .pptx deck.",
    examples: ["armá las slides", "leé el pptx"],
  },
  pdf: {
    description: "Read, merge, split, fill or otherwise manipulate a PDF file.",
    notFor: "Producing an LTM-branded PDF from scratch, which is ltmsoft-doc-create.",
    examples: ["juntá estos PDFs", "extraé las tablas del pdf"],
  },
} as const satisfies Record<string, SkillCard>;

export type SkillId = keyof typeof SKILLS;

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** The no-match outcome. Not a skill: the absence of one. */
export const NO_SKILL = "none";
export type SkillChoice = SkillId | typeof NO_SKILL;

export function isSkillId(value: string): value is SkillId {
  return Object.hasOwn(SKILLS, value);
}
