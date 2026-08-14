/**
 * Model — CRUD operations bound to a table schema.
 */

import type { TableDef, WhereExpr, SqlFragment } from '../schema/types.ts';
import { quoteIdent } from '../query/sql.ts';
import { tableDDL, indexDDLs } from '../schema/ddl.ts';
import { QueryBuilder, type Executor } from '../query/query-builder.ts';

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
    this.#validateKeys(data);
    const cols = Object.keys(data as Record<string, unknown>);
    if (cols.length === 0) {
      // INSERT with no columns: use DEFAULT VALUES
      this.#exec.prepare(`INSERT INTO ${quoteIdent(this.table)} DEFAULT VALUES`).run();
      return this.#resolveAfterInsert(data, this.#lastInsertRowid());
    }
    const colIdents = cols.map((c) => quoteIdent(c)).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(data as Record<string, unknown>);
    const stmt = this.#exec.prepare(
      `INSERT INTO ${quoteIdent(this.table)} (${colIdents}) VALUES (${placeholders})`,
    );
    const result = stmt.run(...values);
    return this.#resolveAfterInsert(data, result.lastInsertRowid);
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
    const pkCols = this.#pkColumns();
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
    this.#validateKeys(patch);
    const patchKeys = Object.keys(patch as Record<string, unknown>);
    if (patchKeys.length === 0) return 0;

    const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
    const patchValues = Object.values(patch as Record<string, unknown>);

    const qb = new QueryBuilder<Row>(this.#exec, this.table);
    qb.where(where as WhereExpr<Row>);
    const { sql, params } = qb.toSql();

    // Extract WHERE clause from the full SELECT
    const whereIdx = sql.indexOf(' WHERE ');
    if (whereIdx < 0) {
      throw new Error(
        'update() requires a WHERE condition. Use db.exec() for bulk updates.',
      );
    }
    const whereClause = sql.slice(whereIdx);

    const updateSql = `UPDATE ${quoteIdent(this.table)} SET ${setClause}${whereClause}`;
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
    const { sql, params } = qb.toSql();

    const whereIdx = sql.indexOf(' WHERE ');
    if (whereIdx < 0) {
      throw new Error(
        'delete() requires a WHERE condition. Use db.exec() for bulk deletes.',
      );
    }
    const whereClause = sql.slice(whereIdx);

    const stmt = this.#exec.prepare(`DELETE FROM ${quoteIdent(this.table)}${whereClause}`);
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

  #validateKeys(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const colSet = new Set(Object.keys(this.#schema.columns));
    for (const key of Object.keys(data as Record<string, unknown>)) {
      if (!colSet.has(key)) {
        throw new Error(
          `Unknown column "${key}" on table "${this.table}". ` +
          `Valid columns: ${[...colSet].join(', ')}`,
        );
      }
    }
  }

  #lastInsertRowid(): number | bigint {
    const row = this.#exec.prepare('SELECT last_insert_rowid() AS "rid"').get() as { rid: number | bigint } | undefined;
    return row?.rid ?? 0;
  }

  #resolveAfterInsert(data: unknown, lastInsertRowid: number | bigint): Row {
    const schema = this.#schema;
    // If WITHOUT ROWID, use primary key columns from input
    if (schema.withoutRowId) {
      const pkCols = this.#pkColumns();
      const where: Record<string, unknown> = {};
      for (const pk of pkCols) {
        const v = (data as Record<string, unknown>)[pk];
        if (v === undefined) {
          throw new Error(
            `Cannot resolve row after insert on WITHOUT ROWID table "${this.table}": ` +
            `primary key column "${pk}" was not provided in insert data.`,
          );
        }
        where[pk] = v;
      }
      return this.findOne(where as WhereExpr<Partial<Row>>)!;
    }

    // Rowid table: use lastInsertRowid (which is also the INTEGER PRIMARY KEY alias)
    const stmt = this.#exec.prepare(
      `SELECT * FROM ${quoteIdent(this.table)} WHERE rowid = ?`,
    );
    return stmt.get(lastInsertRowid) as Row;
  }

  #pkColumns(): string[] {
    return Object.entries(this.#schema.columns)
      .filter(([, col]) => col.primaryKey)
      .map(([name]) => name);
  }
}