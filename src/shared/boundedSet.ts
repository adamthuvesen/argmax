/**
 * Insertion-ordered bounded Set / Map primitives. Drops the oldest entries
 * once size exceeds the cap so long-running main-process state doesn't grow
 * without bound. Built on top of native Map (insertion order is part of the
 * spec) so the cost is O(1) per add/touch and O(1) per evict.
 *
 * Use BoundedSet for membership dedupe (e.g. "have we notified this PR/sha
 * pair already?"). Use BoundedMap when the cache needs a value.
 */

export class BoundedSet<T> {
  private readonly entries = new Map<T, true>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("BoundedSet capacity must be >= 1");
  }

  has(value: T): boolean {
    return this.entries.has(value);
  }

  /** Adds a value; if full, evicts the oldest. Returns true if newly added. */
  add(value: T): boolean {
    if (this.entries.has(value)) return false;
    this.entries.set(value, true);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return true;
  }

  delete(value: T): boolean {
    return this.entries.delete(value);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class BoundedMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("BoundedMap capacity must be >= 1");
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Inserts or updates; if newly inserted and over capacity, evicts the oldest. */
  set(key: K, value: V): void {
    const wasPresent = this.entries.has(key);
    this.entries.set(key, value);
    if (!wasPresent && this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
