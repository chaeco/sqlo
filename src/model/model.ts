/**
 * Model — CRUD operations bound to a table schema.
 */

import type { TableDef, WhereExpr, SqlFragment } from '../schema/types';
import { quoteIdent } from '../query/sql';
import { tableDDL, indexDDLs } from '../schema/ddl';
import { QueryBuilder, type Executor } from '../query/query-builder';

// ---------------------------------------------------------------------------
// Pure insert helpers
//
// The INSERT pipeline is shared between the synchronous `Model` and the async
// `AsyncModel`: both validate keys, compile the same SQL, and resolve the row
// the same way. Keeping these as pure functions (schema + data in, SQL + params
// out) means there is exactly one place that knows how an insert is built.
// ---------------------------------------------------------------------------

/**
 * Validate that every key in `data` is a declared column of the table.
 * Unknown keys are a programming error — surface them eagerly.
 */
export function validateKeys(schema: TableDef, table: string, data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const colSet = new Set(Object.keys(schema.columns));
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (!colSet.has(key)) {
      throw new Error(
        `Unknown column "${key}" on table "${table}". ` +
        `Valid columns: ${[...colSet].join(', ')}`,
      );
    }
  }
}

/**
 * The primary key column names of a schema (in declaration order).
 */
export function pkColumns(schema: TableDef): string[] {
  return Object.entries(schema.columns)
    .filter(([, col]) => col.primaryKey)
    .map(([name]) => name);
}

/**
 * Compile an INSERT statement for `data`. Returns the SQL, the bound values,
 * and whether the insert uses `DEFAULT VALUES` (no explicit columns).
 */
export function buildInsertSql(
  _schema: TableDef,
  table: string,
  data: unknown,
): { sql: string; values: unknown[]; isEmpty: boolean } {
  // Explicit `undefined` means "not provided" — same as an absent key. Keeping
  // it would make node:sqlite reject the binding with an opaque TypeError.
  const entries = Object.entries(data as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  const cols = entries.map(([k]) => k);
  if (cols.length === 0) {
    // INSERT with no columns: use DEFAULT VALUES
    return { sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`, values: [], isEmpty: true };
  }
  const colIdents = cols.map((c) => quoteIdent(c)).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const values = entries.map(([, v]) => v);
  return {
    sql: `INSERT INTO ${quoteIdent(table)} (${colIdents}) VALUES (${placeholders})`,
    values,
    isEmpty: false,
  };
}

/**
 * Compile the SELECT that resolves a row after insert — by `lastInsertRowid`
 * on rowid tables, or by its primary-key columns on WITHOUT ROWID tables.
 */
export function resolveAfterInsertSql(
  schema: TableDef,
  table: string,
  data: unknown,
  lastInsertRowid: number | bigint,
): { sql: string; params: unknown[] } {
  if (schema.withoutRowId) {
    const pks = pkColumns(schema);
    const where: Record<string, unknown> = {};
    for (const pk of pks) {
      const v = (data as Record<string, unknown>)[pk];
      if (v === undefined) {
        throw new Error(
          `Cannot resolve row after insert on WITHOUT ROWID table "${table}": ` +
          `primary key column "${pk}" was not provided in insert data.`,
        );
      }
      where[pk] = v;
    }
    const conds = Object.entries(where).map(([k]) => `${quoteIdent(k)} = ?`);
    return { sql: `SELECT * FROM ${quoteIdent(table)} WHERE ${conds.join(' AND ')}`, params: Object.values(where) };
  }
  // Rowid table: use lastInsertRowid (which is also the INTEGER PRIMARY KEY alias)
  return { sql: `SELECT * FROM ${quoteIdent(table)} WHERE rowid = ?`, params: [lastInsertRowid] };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Typed CRUD operations bound to a single table schema.
 *
 * Created via `db.define(schema)`. Insert/read/update/delete methods are
 * type-driven by the schema's row, insert, and patch types. Tables are
 * created explicitly with `sync()` — never automatically.
 */
export class Model<Row extends Record<string, unknown>, Insert, Patch> {
  readonly #schema: TableDef;
  readonly #exec: Executor;
  readonly table: string;

  /**
   * @param exec Executor that runs prepared statements (usually a Sqlo).
   * @param schema The table definition that drives this model's types.
   */
  constructor(exec: Executor, schema: TableDef) {
    this.#exec = exec;
    this.#schema = schema;
    this.table = schema.name;
  }

  // ---- Schema sync ----

  /**
   * Create the table (and indexes) if they do not exist.
   * Must be called explicitly — the ORM will not auto-create tables.
   */
  sync(): void {
    this.#exec.prepare(tableDDL(this.#schema)).run();
    for (const ddl of indexDDLs(this.#schema)) {
      this.#exec.prepare(ddl).run();
    }
  }

  // ---- INSERT ----

  /**
   * Insert a row and return the full row.
   */
  insert(data: Insert): Row {
    validateKeys(this.#schema, this.table, data);
    const { sql, values, isEmpty } = buildInsertSql(this.#schema, this.table, data);
    const result = this.#exec.prepare(sql).run(...values);
    const rid = isEmpty ? this.#lastInsertRowid() : result.lastInsertRowid;
    const { sql: selSql, params } = resolveAfterInsertSql(this.#schema, this.table, data, rid);
    return this.#exec.prepare(selSql).get(...params) as Row;
  }

  /**
   * Insert multiple rows atomically — either all succeed or none are kept.
   *
   * Wrapped in a transaction when the executor supports it (Sqlo does).
   * When called inside an outer `db.transaction(...)`, this nests via
   * SAVEPOINT and participates in the outer commit/rollback.
   */
  /**
   * Insert multiple rows and return the inserted rows (with generated ids).
   * Wrapped in a transaction when the executor supports it (Sqlo does).
   * When called inside an outer `db.transaction(...)`, this nests via
   * SAVEPOINT and participates in the outer commit/rollback.
   *
   * For very large batches, pass `{ chunkSize }` to insert in chunks — each
   * chunk gets its own transaction (when not already inside an outer
   * transaction), keeping write-lock hold time and memory bounded. Errors
   * within a chunk roll back only that chunk; previously committed chunks
   * stay.
   *
   * @example
   * model.insertMany(rows, { chunkSize: 1000 });
   */
  insertMany(rows: Insert[], options?: { chunkSize?: number }): Row[] {
    if (rows.length === 0) return [];
    const chunkSize = options?.chunkSize ?? rows.length;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error(
        `insertMany: chunkSize must be a positive integer, got ${options?.chunkSize}.`,
      );
    }
    const tx = this.#exec.transaction;
    const results: Row[] = [];

    if (chunkSize >= rows.length) {
      // Single batch — keep the existing atomic behaviour.
      if (tx) {
        return tx.call(this.#exec, () => rows.map((r) => this.insert(r))) as Row[];
      }
      return rows.map((r) => this.insert(r));
    }

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      if (tx) {
        const inserted = tx.call(this.#exec, () =>
          chunk.map((r) => this.insert(r)),
        ) as Row[];
        results.push(...inserted);
      } else {
        results.push(...chunk.map((r) => this.insert(r)));
      }
    }
    return results;
  }

  // ---- SELECT ----

  /**
   * Find a row by its primary key (first primaryKey column).
   * Accepts number / bigint for INTEGER keys and string for TEXT/UUID keys.
   * Returns undefined if no rowid-based key column is found — use findOne() instead.
   */
  findById(id: number | bigint | string): Row | undefined {
    const pkCols = pkColumns(this.#schema);
    if (pkCols.length === 0) {
      throw new Error(
        `Table "${this.table}" has no primary key column defined. Use findOne() instead.`,
      );
    }
    const where: Record<string, unknown> = {};
    where[pkCols[0]!] = id;
    return this.findOne(where as WhereExpr<Partial<Row>>);
  }

  /**
   * Find a single row matching the condition.
   */
  findOne(where: WhereExpr<Partial<Row>> | SqlFragment): Row | undefined {
    const qb = this.query();
    qb.where(where as WhereExpr<Row>);
    return qb.first();
  }

  /**
   * Find all rows matching the optional condition.
   */
  findAll(where?: WhereExpr<Partial<Row>> | SqlFragment): Row[] {
    const qb = this.query();
    if (where !== undefined) qb.where(where as WhereExpr<Row>);
    return qb.all();
  }

  /**
   * Convenience: alias for findAll().
   */
  all(): Row[] {
    return this.findAll();
  }

  // ---- UPDATE ----

  /**
   * Update rows matching the condition. Returns the number of affected rows.
   * The `where` argument is required — use `db.exec(...)` or model query builder for bulk updates.
   */
  update(patch: Patch, where: WhereExpr<Partial<Row>> | SqlFragment): number {
    validateKeys(this.#schema, this.table, patch);
    // Explicit `undefined` means "not patched" (matching the PatchOf type) —
    // never bind it, node:sqlite would reject it with an opaque TypeError.
    const patchEntries = Object.entries(patch as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    const patchKeys = patchEntries.map(([k]) => k);
    if (patchKeys.length === 0) return 0;

    const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
    const patchValues = patchEntries.map(([, v]) => v);

    const qb = new QueryBuilder<Row>(this.#exec, this.table);
    qb.where(where as WhereExpr<Row>);
    const { clause, params } = qb.buildWhere();
    if (!clause) {
      throw new Error(
        'update() requires a WHERE condition. Use db.exec() for bulk updates.',
      );
    }

    const updateSql = `UPDATE ${quoteIdent(this.table)} SET ${setClause}${clause}`;
    const stmt = this.#exec.prepare(updateSql);
    const result = stmt.run(...patchValues, ...params);
    return Number(result.changes);
  }

  // ---- DELETE ----

  /**
   * Delete rows matching the condition. Returns the number of deleted rows.
   * The `where` argument is required.
   */
  delete(where: WhereExpr<Partial<Row>> | SqlFragment): number {
    const qb = new QueryBuilder<Row>(this.#exec, this.table);
    qb.where(where as WhereExpr<Row>);
    const { clause, params } = qb.buildWhere();
    if (!clause) {
      throw new Error(
        'delete() requires a WHERE condition. Use db.exec() for bulk deletes.',
      );
    }

    const stmt = this.#exec.prepare(`DELETE FROM ${quoteIdent(this.table)}${clause}`);
    const result = stmt.run(...params);
    return Number(result.changes);
  }

  /**
   * Delete all rows in the table. Returns the number of deleted rows.
   *
   * Explicit escape hatch — unlike `delete()`, no WHERE is required. Use for
   * test resets or full-table cleanup. (Deleting all rows never drops the
   * table or resets AUTOINCREMENT sequences.)
   */
  deleteAll(): number {
    const stmt = this.#exec.prepare(`DELETE FROM ${quoteIdent(this.table)}`);
    const result = stmt.run();
    return Number(result.changes);
  }

  // ---- COUNT / EXISTS ----

  /**
   * Count rows matching the optional condition.
   */
  count(where?: WhereExpr<Partial<Row>> | SqlFragment): number {
    const qb = this.query();
    if (where !== undefined) qb.where(where as WhereExpr<Row>);
    return qb.count();
  }

  /**
   * Check if at least one row matches the condition.
   * Uses a LIMIT 1 query — faster than count() on large tables.
   */
  exists(where: WhereExpr<Partial<Row>> | SqlFragment): boolean {
    return this.findOne(where) !== undefined;
  }

  // ---- Query builder ----

  /**
   * Get a fluent QueryBuilder for this table.
   */
  query(): QueryBuilder<Row> {
    return new QueryBuilder<Row>(this.#exec, this.table);
  }

  // ---- Internal ----

  #lastInsertRowid(): number | bigint {
    const row = this.#exec.prepare('SELECT last_insert_rowid() AS "rid"').get() as { rid: number | bigint } | undefined;
    return row?.rid ?? 0;
  }
}