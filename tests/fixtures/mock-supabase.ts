/**
 * Mock Supabase Client for testing
 *
 * Provides an in-memory store that mimics the Supabase API.
 * Supports: from().select/insert/update/upsert, rpc(), functions.invoke()
 */

type Row = Record<string, any>;

interface MockStore {
  [table: string]: Row[];
}

interface MockRpcHandlers {
  [name: string]: (params: any) => any;
}

interface MockFunctionHandlers {
  [name: string]: (opts?: { body?: any }) => any;
}

/** Resolve column value, supporting JSON path operator ->> (e.g. "metadata->>source") */
function resolveColumn(row: Row, column: string): any {
  if (column.includes("->>")) {
    const [baseCol, jsonKey] = column.split("->>");
    const base = row[baseCol];
    if (base && typeof base === "object") return base[jsonKey];
    return undefined;
  }
  return row[column];
}

function matchFilter(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    switch (f.op) {
      case "eq":
        if (resolveColumn(row, f.column) !== f.value) return false;
        break;
      case "neq":
        if (resolveColumn(row, f.column) === f.value) return false;
        break;
      case "like": {
        const pattern = String(f.value).replace(/%/g, ".*");
        if (!new RegExp(`^${pattern}$`).test(String(resolveColumn(row, f.column) ?? "")))
          return false;
        break;
      }
      case "ilike":
        if (
          !String(resolveColumn(row, f.column) ?? "")
            .toLowerCase()
            .includes(String(f.value).replace(/%/g, "").toLowerCase())
        )
          return false;
        break;
      case "in":
        if (!Array.isArray(f.value) || !f.value.includes(resolveColumn(row, f.column)))
          return false;
        break;
      case "not.is":
        if (resolveColumn(row, f.column) === null || resolveColumn(row, f.column) === undefined)
          return false;
        break;
      case "gte":
        if (resolveColumn(row, f.column) < f.value) return false;
        break;
      case "lte":
        if (resolveColumn(row, f.column) > f.value) return false;
        break;
      case "gt":
        if (resolveColumn(row, f.column) <= f.value) return false;
        break;
      case "lt":
        if (resolveColumn(row, f.column) >= f.value) return false;
        break;
    }
  }
  return true;
}

interface Filter {
  column: string;
  op: string;
  value: any;
}

class MockQueryBuilder {
  private store: MockStore;
  private table: string;
  private filters: Filter[] = [];
  private _selectCalled = false;
  private _order: Array<{ column: string; ascending: boolean }> = [];
  private _limit: number | null = null;
  private _single = false;
  private _insertData: Row | Row[] | null = null;
  private _updateData: Row | null = null;
  private _upsertData: Row | null = null;
  private _upsertConflict: string | null = null;
  private _mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private _orFilters: string | null = null;

  constructor(store: MockStore, table: string) {
    this.store = store;
    this.table = table;
    if (!this.store[table]) this.store[table] = [];
  }

  select(_columns?: string) {
    this._selectCalled = true;
    // Only set mode to select if no write operation was initiated
    if (this._mode === "select") {
      this._mode = "select";
    }
    // Otherwise keep the current mode (insert/update) and just mark that select was called
    return this;
  }

  insert(data: Row | Row[]) {
    this._insertData = data;
    this._mode = "insert";
    return this;
  }

  update(data: Row) {
    this._updateData = data;
    this._mode = "update";
    return this;
  }

  upsert(data: Row, opts?: { onConflict?: string }) {
    this._upsertData = data;
    this._upsertConflict = opts?.onConflict ?? null;
    this._mode = "upsert";
    return this;
  }

  delete() {
    this._mode = "delete";
    return this;
  }

  eq(column: string, value: any) {
    this.filters.push({ column, op: "eq", value });
    return this;
  }

  neq(column: string, value: any) {
    this.filters.push({ column, op: "neq", value });
    return this;
  }

  like(column: string, value: string) {
    this.filters.push({ column, op: "like", value });
    return this;
  }

  ilike(column: string, value: string) {
    this.filters.push({ column, op: "ilike", value });
    return this;
  }

  in(column: string, values: any[]) {
    this.filters.push({ column, op: "in", value: values });
    return this;
  }

  or(filterStr: string) {
    // Parse PostgREST OR filter string: "col.op.val,col.op.val"
    this._orFilters = filterStr;
    return this;
  }

  filter(column: string, op: string, value: any) {
    // Support PostgREST-style casting (e.g. "id::text") — strip the cast for in-memory matching
    const cleanColumn = column.replace(/::.*$/, "");
    this.filters.push({ column: cleanColumn, op, value });
    return this;
  }

  not(column: string, op: string, value: any) {
    this.filters.push({ column, op: `not.${op}`, value });
    return this;
  }

  gte(column: string, value: any) {
    this.filters.push({ column, op: "gte", value });
    return this;
  }

  lte(column: string, value: any) {
    this.filters.push({ column, op: "lte", value });
    return this;
  }

  gt(column: string, value: any) {
    this.filters.push({ column, op: "gt", value });
    return this;
  }

  lt(column: string, value: any) {
    this.filters.push({ column, op: "lt", value });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }) {
    this._order.push({ column, ascending: opts?.ascending ?? true });
    return this;
  }

  limit(n: number) {
    this._limit = n;
    return this;
  }

  single() {
    this._single = true;
    return this._execute();
  }

  then(resolve: (value: any) => void, reject?: (reason: any) => void) {
    const result = this._execute();
    return Promise.resolve(result).then(resolve, reject);
  }

  private _execute(): { data: any; error: any } {
    const rows = this.store[this.table] ?? [];

    switch (this._mode) {
      case "insert": {
        const items = Array.isArray(this._insertData) ? this._insertData : [this._insertData!];
        const inserted: Row[] = [];
        for (const item of items) {
          const row = {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...item,
          };
          rows.push(row);
          inserted.push(row);
        }
        this.store[this.table] = rows;

        if (this._selectCalled) {
          return { data: this._single ? (inserted[0] ?? null) : inserted, error: null };
        }
        return { data: null, error: null };
      }

      case "update": {
        const updated: Row[] = [];
        for (const row of rows) {
          if (matchFilter(row, this.filters)) {
            Object.assign(row, this._updateData, { updated_at: new Date().toISOString() });
            updated.push(row);
          }
        }
        if (this._selectCalled) {
          return { data: this._single ? (updated[0] ?? null) : updated, error: null };
        }
        return { data: null, error: null };
      }

      case "upsert": {
        const conflictCol = this._upsertConflict ?? "id";
        const existing = rows.find((r) => r[conflictCol] === this._upsertData![conflictCol]);
        if (existing) {
          Object.assign(existing, this._upsertData, { updated_at: new Date().toISOString() });
          return { data: this._single ? existing : [existing], error: null };
        } else {
          const row = {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            ...this._upsertData,
          };
          rows.push(row);
          this.store[this.table] = rows;
          return { data: this._single ? row : [row], error: null };
        }
      }
      case "delete": {
        const _before = rows.length;
        const remaining = rows.filter((r) => !matchFilter(r, this.filters));
        const deleted = rows.filter((r) => matchFilter(r, this.filters));
        this.store[this.table] = remaining;
        if (this._selectCalled) {
          return { data: this._single ? (deleted[0] ?? null) : deleted, error: null };
        }
        return { data: null, error: null };
      }
      default: {
        let filtered = this._applyFilters(rows);
        filtered = this._applyOrder(filtered);
        if (this._limit !== null) filtered = filtered.slice(0, this._limit);
        return { data: this._single ? (filtered[0] ?? null) : filtered, error: null };
      }
    }
  }

  private _applyFilters(rows: Row[]): Row[] {
    let filtered = rows.filter((r) => matchFilter(r, this.filters));

    // Apply OR filter if set (PostgREST format: "col.op.val,col.op.val")
    if (this._orFilters) {
      const conditions = this._orFilters.split(",");
      filtered = filtered.filter((row) =>
        conditions.some((cond) => {
          const parts = cond.split(".");
          if (parts.length < 3) return false;
          const col = parts[0];
          const op = parts[1];
          const val = parts.slice(2).join(".");
          const filter: Filter = { column: col, op, value: val };
          return matchFilter(row, [filter]);
        }),
      );
    }

    return filtered;
  }

  private _applyOrder(rows: Row[]): Row[] {
    const sorted = [...rows];
    for (const o of this._order.reverse()) {
      sorted.sort((a, b) => {
        const va = a[o.column];
        const vb = b[o.column];
        if (va < vb) return o.ascending ? -1 : 1;
        if (va > vb) return o.ascending ? 1 : -1;
        return 0;
      });
    }
    return sorted;
  }
}

export function createMockSupabase(initialData?: MockStore) {
  const store: MockStore = initialData ? JSON.parse(JSON.stringify(initialData)) : {};
  const rpcHandlers: MockRpcHandlers = {};
  const functionHandlers: MockFunctionHandlers = {};

  const client = {
    from(table: string) {
      return new MockQueryBuilder(store, table);
    },

    rpc(name: string, params?: any) {
      const handler = rpcHandlers[name];
      if (handler) {
        return Promise.resolve({ data: handler(params), error: null });
      }
      return Promise.resolve({ data: null, error: { message: `Unknown RPC: ${name}` } });
    },

    functions: {
      invoke(name: string, opts?: { body?: any }) {
        const handler = functionHandlers[name];
        if (handler) {
          return Promise.resolve({ data: handler(opts), error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
    },

    // Test helpers
    _store: store,
    _registerRpc(name: string, handler: (params: any) => any) {
      rpcHandlers[name] = handler;
    },
    _getTable(table: string): Row[] {
      return store[table] ?? [];
    },
    _registerFunction(name: string, handler: (opts?: { body?: any }) => any) {
      functionHandlers[name] = handler;
    },
    _reset() {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };

  return client as any;
}
