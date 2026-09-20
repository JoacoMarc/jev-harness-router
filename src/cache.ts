import { createHash } from "node:crypto";
import { DEFAULT_CATALOG } from "./catalog/index.ts";
import type { TurnState } from "./types.ts";

/**
 * A small in-process LRU over routing decisions.
 *
 * TypeSafe has no server-side prefix cache — the `JsonCache` that appears throughout the
 * cookbooks is a local convenience so the docs re-render without spending API calls, not
 * a feature of the API. If repeated turns are to be free, it happens here.
 *
 * The catalogue fingerprint is part of the key: adding a tool changes the questions,
 * which changes the answers, so a decision cached before the edit is stale even for a
 * byte-identical turn.
 */
export class Lru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max = 256) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // Re-insert so the most recently used entry sits at the tail.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/** `catalogVersion` is `Catalog.version`: the fingerprint of what the model was shown. */
export function cacheKey(state: TurnState, catalogVersion: string = DEFAULT_CATALOG.version): string {
  return createHash("sha256")
    .update(catalogVersion)
    .update("::")
    .update(JSON.stringify(state))
    .digest("hex")
    .slice(0, 32);
}
