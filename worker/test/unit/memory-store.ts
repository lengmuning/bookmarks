import type { Row, Store } from "../../src/v2/logic";

// Returns copies so a missing put() in the logic shows up as a lost write,
// the same way it would against SQLite.
export class MemoryStore implements Store {
  rows = new Map<string, Row>();
  seq = 0;

  get(url: string): Row | null {
    const row = this.rows.get(url);
    return row ? structuredClone(row) : null;
  }

  put(row: Row): void {
    this.rows.set(row.url, structuredClone(row));
  }

  all(): Row[] {
    return [...this.rows.values()].map(row => structuredClone(row));
  }

  countActive(): number {
    return [...this.rows.values()].filter(row => !row.removed).length;
  }

  countInSafari(): number {
    return [...this.rows.values()].filter(row => !row.removed && (row.owner === "safari" || row.inSafari)).length;
  }

  currentSeq(): number {
    return this.seq;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  row(url: string): Row {
    const row = this.rows.get(url);
    if (!row) throw new Error(`no row for ${url}`);
    return row;
  }
}
