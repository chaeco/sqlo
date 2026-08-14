/**
 * Fluent SQLite query builder.
 * Generates SELECT statements with parameter binding.
 */
import type { SqlFragment, WhereExpr, OrderDir } from '../schema/types.js';
export interface Executor {
    /**
     * Prepare a SQL statement and expose its bound execution methods.
     * Implemented by `Sqlo`; every generated query flows through here so that
     * all values are passed as bound parameters.
     */
    prepare(sql: string): {
        all(...params: unknown[]): Record<string, unknown>[];
        get(...params: unknown[]): Record<string, unknown> | undefined;
        run(...params: unknown[]): {
            changes: number | bigint;
            lastInsertRowid: number | bigint;
        };
    };
    /**
     * Run a function inside a transaction. Optional — when absent, batch
     * operations such as Model#insertMany fall back to individual statements.
     */
    transaction?<T>(fn: () => T): T;
}
/**
 * Fluent SQLite SELECT query builder.
 *
 * Builds a parameter-bound SELECT statement through method chaining and
 * executes it with `all()` / `first()` / `count()` / `pluck()`. Obtain one
 * via `model.query()`.
 */
export declare class QueryBuilder<Row extends Record<string, unknown> = Record<string, unknown>> {
    #private;
    /**
     * @param exec Executor that runs prepared statements (usually a Sqlo).
     * @param table Table name to query (`"table"` or `"schema.table"`).
     */
    constructor(exec: Executor, table: string);
    /**
     * Restrict the SELECT to the given columns (quoted as identifiers).
     * Calling with no arguments resets to `SELECT *`.
     */
    select(...cols: string[]): this;
    /** Emit `SELECT DISTINCT` to de-duplicate result rows. */
    distinct(): this;
    /** INNER JOIN `table` on a `sql\`...\`` ON clause. */
    join(table: string, on: SqlFragment): this;
    /** LEFT JOIN `table` on a `sql\`...\`` ON clause. */
    leftJoin(table: string, on: SqlFragment): this;
    /** RIGHT JOIN `table` on a `sql\`...\`` ON clause. */
    rightJoin(table: string, on: SqlFragment): this;
    /** FULL OUTER JOIN `table` on a `sql\`...\`` ON clause. */
    fullJoin(table: string, on: SqlFragment): this;
    /**
     * Add a condition combined with the existing ones via AND.
     * Accepts a plain-object expression (`{ age: { gte: 18 } }`, `{ id: [1,2] }`,
     * `{ name: null }`) or a `sql\`...\`` fragment.
     */
    where(cond: WhereExpr<Row> | SqlFragment): this;
    /**
     * Add a condition combined with the existing ones via OR.
     * Same accepted shapes as `where()`.
     */
    orWhere(cond: WhereExpr<Row> | SqlFragment): this;
    /**
     * Append a raw SQL fragment as an AND condition (no param binding).
     * Prefer `where(sql\`...\`)` for safety.
     */
    raw(fragment: SqlFragment | string): this;
    /** GROUP BY the given columns (quoted as identifiers). */
    groupBy(...cols: string[]): this;
    /** HAVING condition on aggregated groups — same shapes as `where()`. */
    having(cond: WhereExpr<Row> | SqlFragment): this;
    /**
     * ORDER BY a column (quoted) or a `sql\`...\`` fragment, with an optional
     * direction (`'ASC'` default, or `'DESC'`).
     */
    orderBy(col: string | SqlFragment, dir?: OrderDir): this;
    /** LIMIT the number of returned rows (bound as a parameter). */
    limit(n: number): this;
    /** OFFSET the result window (bound as a parameter; usually paired with `limit()`). */
    offset(n: number): this;
    /**
     * Returns the compiled SQL string and bound parameters.
     */
    toSql(): {
        sql: string;
        params: unknown[];
    };
    /**
     * Execute and return all matching rows.
     */
    all(): Row[];
    /**
     * Execute and return the first row, or undefined if none.
     * Does not mutate the builder — the underlying LIMIT 1 is applied on a
     * copy, so the builder stays reusable afterwards.
     */
    first(): Row | undefined;
    /**
     * Execute COUNT query.
     */
    count(): number;
    /**
     * Execute and return values of a single column.
     * Does not mutate the builder — projection is applied on a copy.
     */
    pluck<C extends keyof Row>(col: C): Row[C][];
}
//# sourceMappingURL=query-builder.d.ts.map