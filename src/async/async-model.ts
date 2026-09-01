/**
 * Async ORM layer — AsyncModel and AsyncQueryBuilder.
 *
 * The "brain on the main thread, hands in the worker" split: the main thread
 * owns all types and query construction (pure functions, zero blocking); the
 * worker is a remote connection that only executes final SQL. These classes
 * mirror the synchronous `Model` and `QueryBuilder` APIs, but every terminal
 * call is a single RPC to the worker.
 *
 * Query construction is deliberately shared with the sync layer:
 * `AsyncQueryBuilder` wraps a real `QueryBuilder` used purely for SQL
 * compilation (`toSql`, `buildWhere`, `buildFirstSql`, …), never for
 * execution; insert/update pipelines reuse the same pure helpers as `Model`.
 * There is exactly one place that knows how a query is built.
 */

import type { TableDef, WhereExpr, SqlFragment, OrderDir } from '../schema/types';
import { quoteIdent } from '../query/sql';
import { tableDDL, indexDDLs } from '../schema/ddl';
import { QueryBuilder, type Executor } from '../query/query-builder';
import {
  validateKeys,
  buildInsertSql,
  resolveAfterInsertSql,
  pkColumns,
} from '../model/model';

// ---------------------------------------------------------------------------
// AsyncExecutor
// ---------------------------------------------------------------------------

/**
 * The async counterpart of the sync `Executor` interface. Implemented by
 * `AsyncSqlo` / `AsyncTransaction`; consumed by `AsyncModel` /
 * `AsyncQueryBuilder`. Every method returns a Promise — each call crosses
 * the worker boundary once.
 */
export interface AsyncExecutor {
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]>;
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined>;
  run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }>;
  exec(sql: string): Promise<void>;
  /**
   * Optionally present transaction support. When absent, batch operations
   * such as `AsyncModel#insertMany` fall back to individual statements.
   */
  transaction?<T>(
    fn: (tx: AsyncTransaction) => Promise<T>,
    options?: { retry?: number },
  ): Promise<T>;
}

/**
 * The explicit transaction handle handed to a transaction callback.
 *
 * All operations performed through the handle are guaranteed to run inside
 * the transaction (the handle dispatches directly to the worker — it cannot
 * be interleaved with other operations). Pass an existing model to
 * {@link AsyncTransaction#model} to get a copy bound to this transaction:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const u = tx.model(users); // type-safe copy bound to the transaction
 *   await u.insert({ name: 'alice' });
 * });
 * ```
 *
 * Nested transactions are available via `tx.transaction(...)` and use
 * SAVEPOINT / RELEASE in the worker.
 */
export interface AsyncTransaction extends AsyncExecutor {
  /**
   * Nest another transaction inside this one. Uses SAVEPOINT / RELEASE in the
   * worker; shares the outer transaction's fate (an inner rollback rolls back
   * only the inner savepoint, an outer rollback takes the inner with it).
   */
  transaction<T>(fn: (tx: AsyncTransaction) => Promise<T>): Promise<T>;
  /**
   * Return a copy of `model` bound to this transaction handle. The returned
   * model has the exact same type; every operation it runs lands inside the
   * transaction. Use this instead of the `db`-bound model inside a
   * transaction callback.
   */
  model<Row extends Record<string, unknown>, Insert, Patch>(
    model: AsyncModel<Row, Insert, Patch>,
  ): AsyncModel<Row, Insert, Patch>;
}

// ---------------------------------------------------------------------------
// AsyncQueryBuilder
// ---------------------------------------------------------------------------

/**
 * An executor that is never used for actual execution. AsyncQueryBuilder only
 * compiles SQL through the wrapped QueryBuilder; final execution always goes
 * through `#exec` (a single RPC). Defensive: if a non-terminal wrapper ever
 * leaked into a sync terminal method, this throws loudly instead of silently
 * running on the main thread.
 */
const UNREACHABLE_EXECUTOR: Executor = {
  prepare(): never {
    throw new Error(
      'AsyncQueryBuilder compiles SQL on the main thread but never executes ' +
        'synchronously — use the async terminal methods (all/first/count/pluck).',
    );
  },
};

/**
 * Fluent async SELECT query builder.
 *
 * Chain the same methods as the sync `QueryBuilder`; only the terminal calls
 * (`all`, `first`, `count`, `pluck`) are async — each runs as a single RPC to
 * the worker. Non-terminal chaining is synchronous and free (SQL stays on the
 * main thread).
 */
export class AsyncQueryBuilder<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly #qb: QueryBuilder<Row>;
  readonly #exec: AsyncExecutor;

  /**
   * @param exec AsyncExecutor that executes compiled SQL (an AsyncSqlo).
   * @param table Table name to query (`"table"` or `"schema.table"`).
   */
  constructor(exec: AsyncExecutor, table: string) {
    this.#exec = exec;
    this.#qb = new QueryBuilder<Row>(UNREACHABLE_EXECUTOR, table);
  }

  // ---- SELECT ----

  /** Restrict the SELECT to the given columns (quoted as identifiers). */
  select(...cols: string[]): this {
    this.#qb.select(...cols);
    return this;
  }

  /** Emit `SELECT DISTINCT` to de-duplicate result rows. */
  distinct(): this {
    this.#qb.distinct();
    return this;
  }

  // ---- JOIN ----

  /** INNER JOIN `table` on a `sql\`...\`` ON clause. */
  join(table: string, on: SqlFragment): this {
    this.#qb.join(table, on);
    return this;
  }

  /** LEFT JOIN `table` on a `sql\`...\`` ON clause. */
  leftJoin(table: string, on: SqlFragment): this {
    this.#qb.leftJoin(table, on);
    return this;
  }

  /** RIGHT JOIN `table` on a `sql\`...\`` ON clause. */
  rightJoin(table: string, on: SqlFragment): this {
    this.#qb.rightJoin(table, on);
    return this;
  }

  /** FULL OUTER JOIN `table` on a `sql\`...\`` ON clause. */
  fullJoin(table: string, on: SqlFragment): this {
    this.#qb.fullJoin(table, on);
    return this;
  }

  // ---- WHERE ----

  /** Add an AND condition — plain-object expression or `sql\`...\`` fragment. */
  where(cond: WhereExpr<Row> | SqlFragment): this {
    this.#qb.where(cond);
    return this;
  }

  /** Add an OR condition — same accepted shapes as `where()`. */
  orWhere(cond: WhereExpr<Row> | SqlFragment): this {
    this.#qb.orWhere(cond);
    return this;
  }

  /** Append a raw SQL fragment as an AND condition (no param binding). */
  raw(fragment: SqlFragment | string): this {
    this.#qb.raw(fragment);
    return this;
  }

  // ---- GROUP / HAVING / ORDER ----

  /** GROUP BY the given columns (quoted as identifiers). */
  groupBy(...cols: string[]): this {
    this.#qb.groupBy(...cols);
    return this;
  }

  /** HAVING condition on aggregated groups — same shapes as `where()`. */
  having(cond: WhereExpr<Row> | SqlFragment): this {
    this.#qb.having(cond);
    return this;
  }

  /** ORDER BY a column (quoted) or a `sql\`...\`` fragment, with direction. */
  orderBy(col: string | SqlFragment, dir: OrderDir = 'ASC'): this {
    this.#qb.orderBy(col, dir);
    return this;
  }

  /** LIMIT the number of returned rows (bound as a parameter). */
  limit(n: number): this {
    this.#qb.limit(n);
    return this;
  }

  /** OFFSET the result window (bound as a parameter; usually paired with `limit()`). */
  offset(n: number): this {
    this.#qb.offset(n);
    return this;
  }

  // ---- Build SQL (pure, synchronous) ----

  /** Build only the WHERE clause (with params) — used for UPDATE/DELETE composition. */
  buildWhere(): { clause: string; params: unknown[] } {
    return this.#qb.buildWhere();
  }

  /** Return the compiled SQL string and bound parameters. */
  toSql(): { sql: string; params: unknown[] } {
    return this.#qb.toSql();
  }

  /** Compile the `first()` query (LIMIT 1 copy of the builder). Pure. */
  buildFirstSql(): { sql: string; params: unknown[] } {
    return this.#qb.buildFirstSql();
  }

  /** Compile the `count()` query (COUNT(*) over the builder). Pure. */
  buildCountSql(): { sql: string; params: unknown[] } {
    return this.#qb.buildCountSql();
  }

  /** Compile the `pluck(col)` query (projection copy of the builder). Pure. */
  buildPluckSql<C extends keyof Row>(col: C): { sql: string; params: unknown[] } {
    return this.#qb.buildPluckSql(col);
  }

  // ---- Execute (one RPC each) ----

  /** Execute and return all matching rows. */
  async all(): Promise<Row[]> {
    const { sql, params } = this.toSql();
    return this.#exec.all<Row>(sql, ...params);
  }

  /** Execute and return the first row, or undefined if none. */
  async first(): Promise<Row | undefined> {
    const { sql, params } = this.buildFirstSql();
    return this.#exec.get<Row>(sql, ...params);
  }

  /** Execute the COUNT query. */
  async count(): Promise<number> {
    const { sql, params } = this.buildCountSql();
    const row = await this.#exec.get<{ c: number }>(sql, ...params);
    return row?.c ?? 0;
  }

  /** Execute and return values of a single column. */
  async pluck<C extends keyof Row>(col: C): Promise<Row[C][]> {
    const { sql, params } = this.buildPluckSql(col);
    const rows = await this.#exec.all<Row>(sql, ...params);
    return rows.map((r) => r[col]);
  }
}

// ---------------------------------------------------------------------------
// AsyncModel
// ---------------------------------------------------------------------------

/**
 * Async typed CRUD operations bound to a single table schema — the async
 * mirror of `Model`, created via `AsyncSqlo#define(schema)`.
 *
 * Insert/read/update/delete methods are type-driven by the schema's row,
 * insert, and patch types and share their SQL construction with the sync
 * layer. Tables are created explicitly with `sync()` — never automatically.
 * Every method returns a Promise; each call crosses the worker boundary once.
 */
export class AsyncModel<Row extends Record<string, unknown>, Insert, Patch> {
  readonly #schema: TableDef;
  readonly #exec: AsyncExecutor;
  readonly table: string;

  /**
   * @param exec AsyncExecutor that executes prepared statements (an AsyncSqlo).
   * @param schema The table definition that drives this model's types.
   */
  constructor(exec: AsyncExecutor, schema: TableDef) {
    this.#exec = exec;
    this.#schema = schema;
    this.table = schema.name;
  }

  // ---- Schema sync ----

  /**
   * Create the table (and indexes) if they do not exist.
   * Must be called explicitly — the ORM will not auto-create tables.
   */
  async sync(): Promise<void> {
    await this.#exec.exec(tableDDL(this.#schema));
    for (const ddl of indexDDLs(this.#schema)) {
      await this.#exec.exec(ddl);
    }
  }

  // ---- INSERT ----

  /**
   * Insert a row and return the full row.
   */
  async insert(data: Insert): Promise<Row> {
    validateKeys(this.#schema, this.table, data);
    const { sql, values, isEmpty } = buildInsertSql(this.#schema, this.table, data);
    const result = await this.#exec.run(sql, ...values);
    const rid = isEmpty ? await this.#lastInsertRowid() : result.lastInsertRowid;
    const { sql: selSql, params } = resolveAfterInsertSql(this.#schema, this.table, data, rid);
    return (await this.#exec.get(selSql, ...params)) as Row;
  }

  /**
   * Insert multiple rows atomically — either all succeed or none are kept.
   *
   * Wrapped in a transaction when the executor supports it (AsyncSqlo does).
   * When called inside an outer `db.transaction(...)`, this nests via
   * SAVEPOINT and participates in the outer commit/rollback.
   *
   * For very large batches, pass `{ chunkSize }` to insert in chunks — each
   * chunk gets its own transaction (when not already inside an outer
   * transaction), keeping write-lock hold time and memory bounded. Errors
   * within a chunk roll back only that chunk; previously committed chunks
   * stay.
   */
  async insertMany(rows: Insert[], options?: { chunkSize?: number }): Promise<Row[]> {
    if (rows.length === 0) return [];
    const chunkSize = options?.chunkSize ?? rows.length;
    const tx = this.#exec.transaction;
    const results: Row[] = [];

    // Inside a transaction, insert through a model bound to the handle — the
    // `db`-bound execution path is serialized behind the active transaction
    // and would deadlock if used here.
    const insertAll = async (exec: AsyncExecutor, list: Insert[]): Promise<Row[]> => {
      const m = new AsyncModel<Row, Insert, Patch>(exec, this.#schema);
      const out: Row[] = [];
      for (const r of list) out.push(await m.insert(r));
      return out;
    };

    if (chunkSize >= rows.length) {
      // Single batch — keep the existing atomic behaviour.
      if (tx) {
        return (await this.#exec.transaction!(async (t) => insertAll(t, rows))) as Row[];
      }
      return insertAll(this.#exec, rows);
    }

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      if (tx) {
        const inserted = (await this.#exec.transaction!(async (t) => insertAll(t, chunk))) as Row[];
        results.push(...inserted);
      } else {
        results.push(...(await insertAll(this.#exec, chunk)));
      }
    }
    return results;
  }

  // ---- SELECT ----

  /**
   * Find a row by its primary key (first primaryKey column).
   * Accepts number / bigint for INTEGER keys and string for TEXT/UUID keys.
   */
  async findById(id: number | bigint | string): Promise<Row | undefined> {
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

  /** Find a single row matching the condition. */
  async findOne(where: WhereExpr<Partial<Row>> | SqlFragment): Promise<Row | undefined> {
    const qb = this.query();
    qb.where(where as WhereExpr<Row>);
    return qb.first();
  }

  /** Find all rows matching the optional condition. */
  async findAll(where?: WhereExpr<Partial<Row>> | SqlFragment): Promise<Row[]> {
    const qb = this.query();
    if (where !== undefined) qb.where(where as WhereExpr<Row>);
    return qb.all();
  }

  /** Convenience: alias for findAll(). */
  async all(): Promise<Row[]> {
    return this.findAll();
  }

  // ---- UPDATE ----

  /**
   * Update rows matching the condition. Returns the number of affected rows.
   * The `where` argument is required.
   */
  async update(patch: Patch, where: WhereExpr<Partial<Row>> | SqlFragment): Promise<number> {
    validateKeys(this.#schema, this.table, patch);
    const patchKeys = Object.keys(patch as Record<string, unknown>);
    if (patchKeys.length === 0) return 0;

    const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
    const patchValues = Object.values(patch as Record<string, unknown>);

    const qb = new QueryBuilder<Row>(UNREACHABLE_EXECUTOR, this.table);
    qb.where(where as WhereExpr<Row>);
    const { clause, params } = qb.buildWhere();
    if (!clause) {
      throw new Error(
        'update() requires a WHERE condition. Use db.exec() for bulk updates.',
      );
    }

    const result = await this.#exec.run(
      `UPDATE ${quoteIdent(this.table)} SET ${setClause}${clause}`,
      ...patchValues,
      ...params,
    );
    return Number(result.changes);
  }

  // ---- DELETE ----

  /**
   * Delete rows matching the condition. Returns the number of deleted rows.
   * The `where` argument is required.
   */
  async delete(where: WhereExpr<Partial<Row>> | SqlFragment): Promise<number> {
    const qb = new QueryBuilder<Row>(UNREACHABLE_EXECUTOR, this.table);
    qb.where(where as WhereExpr<Row>);
    const { clause, params } = qb.buildWhere();
    if (!clause) {
      throw new Error(
        'delete() requires a WHERE condition. Use db.exec() for bulk deletes.',
      );
    }

    const result = await this.#exec.run(
      `DELETE FROM ${quoteIdent(this.table)}${clause}`,
      ...params,
    );
    return Number(result.changes);
  }

  /**
   * Delete all rows in the table. Returns the number of deleted rows.
   * Explicit escape hatch — unlike `delete()`, no WHERE is required.
   */
  async deleteAll(): Promise<number> {
    const result = await this.#exec.run(`DELETE FROM ${quoteIdent(this.table)}`);
    return Number(result.changes);
  }

  // ---- COUNT / EXISTS ----

  /** Count rows matching the optional condition. */
  async count(where?: WhereExpr<Partial<Row>> | SqlFragment): Promise<number> {
    const qb = this.query();
    if (where !== undefined) qb.where(where as WhereExpr<Row>);
    return qb.count();
  }

  /** Check if at least one row matches the condition (LIMIT 1 query). */
  async exists(where: WhereExpr<Partial<Row>> | SqlFragment): Promise<boolean> {
    return (await this.findOne(where)) !== undefined;
  }

  // ---- Query builder ----

  /** Get a fluent AsyncQueryBuilder for this table. */
  query(): AsyncQueryBuilder<Row> {
    return new AsyncQueryBuilder<Row>(this.#exec, this.table);
  }

  /**
   * Return a copy of this model bound to a different executor (e.g. an
   * `AsyncTransaction` handle), keeping the exact same type. Use it inside a
   * transaction callback via `tx.model(...)`.
   */
  withExecutor(exec: AsyncExecutor): AsyncModel<Row, Insert, Patch> {
    return new AsyncModel<Row, Insert, Patch>(exec, this.#schema);
  }

  // ---- Internal ----

  async #lastInsertRowid(): Promise<number | bigint> {
    const row = await this.#exec.get<{ rid: number | bigint }>(
      'SELECT last_insert_rowid() AS "rid"',
    );
    return row?.rid ?? 0;
  }
}