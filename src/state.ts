import { TOOL_IDS, type ToolId } from "./catalog/index.ts";
import type { TurnInput, TurnState } from "./types.ts";

/**
 * Budgets. These are the latency knob.
 *
 * Every question in a request shares one state, and the state is re-read for each of
 * them, so state size sets both the token bill and the round-trip time. It also sets
 * accuracy: `jev-1.13` degrades as unrelated material grows around the decision
 * ("context rot"). The skill-suggestion cookbook's router state is two fields; the
 * agent-assist demo windows its conversation to six messages. Nothing here is generous
 * by accident.
 */
export const MESSAGE_MAX_CHARS = 1_200;
export const CONTEXT_MAX_CHARS = 600;
export const MAX_OPEN_FILES = 8;
export const MAX_RECENT_TOOLS = 4;

/** Keeps the head and the tail, which is where intent lives; drops the middle. */
export function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const head = Math.ceil(max * 0.7);
  const tail = max - head;
  return `${clean.slice(0, head)} […] ${clean.slice(-tail)}`;
}

/** Tools the harness can actually offer this turn. The rest never reach the model. */
export function availableTools(input: TurnInput): ToolId[] {
  const blocked = new Set(input.session?.unavailableTools ?? []);
  return TOOL_IDS.filter((id) => !blocked.has(id));
}

/**
 * Builds the object Jev evaluates.
 *
 * Known facts go in as facts. The model is only asked for the judgment code cannot make,
 * which is step one of the documented method: direct evidence stays in code.
 */
export function buildState(input: TurnInput): TurnState {
  const s = input.session ?? {};
  const session: Record<string, unknown> = {};
  if (s.turnIndex !== undefined) {
    session.turn_index = s.turnIndex;
    session.is_first_turn = s.turnIndex === 0;
  }
  if (s.cwdKind) session.project_kind = s.cwdKind;
  if (s.openFiles?.length) session.open_files = s.openFiles.slice(0, MAX_OPEN_FILES);
  if (s.lastToolsUsed?.length) {
    session.tools_used_last_turn = s.lastToolsUsed.slice(-MAX_RECENT_TOOLS);
  }
  if (s.lastTier) session.previous_turn_model_tier = s.lastTier;

  const blocked = input.session?.unavailableTools ?? [];

  return {
    latest_user_message: truncate(input.message, MESSAGE_MAX_CHARS),
    recent_context: truncate(input.recentContext ?? "", CONTEXT_MAX_CHARS),
    session,
    unavailable_tools: [...blocked],
  };
}
