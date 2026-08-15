/**
 * The authority's durable collections, plus the journal that makes a
 * multi-collection mutation atomic.
 *
 * The predecessor of this module hand-rolled rollback: every transaction
 * captured `const previousX = map.get(key)` for each collection it expected to
 * touch, then restored that list in a `catch`. The write set and the restore
 * set were maintained separately by hand, in methods several hundred lines
 * long, so they could — and did — drift apart. Here a write records its own
 * undo, so rollback cannot omit a collection the operation actually wrote.
 */

/** Undo record for one write, captured before the write lands. */
interface JournalEntry {
  readonly undo: () => void;
}

export class AuthorityJournal {
  #entries: JournalEntry[] | undefined;

  get open(): boolean {
    return this.#entries !== undefined;
  }

  record(entry: JournalEntry): void {
    this.#entries?.push(entry);
  }

  /**
   * Runs one atomic mutation. Nested calls join the outermost transaction, so
   * a helper that transacts internally cannot commit independently of the
   * caller that failed after it.
   */
  run<T>(operation: () => T): T {
    if (this.#entries !== undefined) return operation();
    const entries: JournalEntry[] = [];
    this.#entries = entries;
    try {
      const result = operation();
      this.#entries = undefined;
      return result;
    } catch (error) {
      this.#entries = undefined;
      // Reverse order: a key written twice returns to its original value.
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        entries[index]?.undo();
      }
      throw error;
    }
  }
}

/**
 * A `Map` whose mutations are undoable inside a journal transaction.
 *
 * It deliberately exposes the `Map` surface rather than a bespoke API: the
 * backend contract's fault-injection hooks replace `set` on a live collection
 * to simulate a mid-transaction durability failure, and that technique has to
 * keep working against the real thing.
 */
export class JournalledMap<V> implements Iterable<[string, V]> {
  readonly #inner = new Map<string, V>();

  constructor(private readonly journal: AuthorityJournal) {}

  get size(): number {
    return this.#inner.size;
  }

  get(key: string): V | undefined {
    return this.#inner.get(key);
  }

  has(key: string): boolean {
    return this.#inner.has(key);
  }

  set(key: string, value: V): this {
    this.#capture(key);
    this.#inner.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    this.#capture(key);
    return this.#inner.delete(key);
  }

  clear(): void {
    for (const key of [...this.#inner.keys()]) this.#capture(key);
    this.#inner.clear();
  }

  keys(): IterableIterator<string> {
    return this.#inner.keys();
  }

  values(): IterableIterator<V> {
    return this.#inner.values();
  }

  entries(): IterableIterator<[string, V]> {
    return this.#inner.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.#inner[Symbol.iterator]();
  }

  #capture(key: string): void {
    if (!this.journal.open) return;
    const inner = this.#inner;
    const existed = inner.has(key);
    const prior = inner.get(key);
    this.journal.record({
      undo: () => {
        if (existed) inner.set(key, prior as V);
        else inner.delete(key);
      },
    });
  }
}
