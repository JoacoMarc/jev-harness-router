import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Fetch } from "@typesafe-ai/sdk";
import { isMock, mockFetch } from "../src/mock.ts";
import type { TurnInput } from "../src/types.ts";

/** Loads .env if it is there. Node 22 can do this itself; nothing else needs to. */
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

export function requireKey(): void {
  if (isMock()) {
    console.error("MOCK=1 — answers come from the local heuristic, not from Jev. Numbers below are not measurements.\n");
    return;
  }
  if (process.env.TYPESAFE_API_KEY) return;
  console.error(
    "TYPESAFE_API_KEY is not set. Put it in .env (see .env.example) or export it.\n" +
      "Keys live at https://console.typesafe.ai/settings/keys",
  );
  process.exit(1);
}

/** The transport every entry point uses: the real one, or the mock under MOCK=1. */
export function transport(): { fetch?: Fetch } {
  return isMock() ? { fetch: mockFetch() } : {};
}

/**
 * Runs tasks with a concurrency limit, preserving input order.
 *
 * Bounded on purpose: the rate limit is 1,200 requests a minute, and a fixture sweep
 * that fires everything at once measures the queue rather than the model.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T);
        process.stderr.write(".");
      }
    }),
  );
  process.stderr.write("\n");
  return results;
}

/** One labelled turn: the input, plus what the route should have been. */
export interface Fixture extends TurnInput {
  readonly id: string;
  readonly expect: {
    readonly tier?: string;
    readonly tools?: readonly string[];
    readonly skill?: string | null;
  };
}

export async function readFixtures(path = "fixtures/turns.jsonl"): Promise<Fixture[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => JSON.parse(line) as Fixture);
}

/**
 * The percentile convention used across the reference projects: nearest-rank on the
 * sorted sample, clamped to the ends.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export const ms = (n: number): string => `${n.toFixed(0)}ms`;
export const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const widths = (rows[0] as readonly string[]).map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] as number) : cell.padStart(widths[i] as number)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Jaccard-style agreement between two tool sets, so a near miss is not scored as a miss. */
export function setScore(
  got: readonly string[],
  want: readonly string[],
): { precision: number; recall: number; exact: boolean } {
  const g = new Set(got);
  const w = new Set(want);
  const hits = [...g].filter((x) => w.has(x)).length;
  return {
    precision: g.size === 0 ? (w.size === 0 ? 1 : 0) : hits / g.size,
    recall: w.size === 0 ? 1 : hits / w.size,
    exact: g.size === w.size && hits === g.size,
  };
}
