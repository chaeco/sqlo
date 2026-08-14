/**
 * Model — CRUD operations bound to a table schema.
 */
import type { TableDef, WhereExpr, SqlFragment } from '../schema/types.js';
import { QueryBuilder, type Executor } from '../query/query-builder.js';
/**
 * Typed CRUD operations bound to a single table schema.
 *
 * Created via `db.define(schema)`. Insert/read/update/delete methods are
 * type-driven by the schema's row, insert, and patch types. Tables are
 * created explicitly with `sync()` — never automatically.
 */
export declare class Model<Row extends Record<string, unknown>, Insert, Patch> {
    #private;
    readonly table: string;
    /**
     * @param exec Executor that runs prepared statements (usually a Sqlo).
     * @param schema The table definition that drives this model's types.
     */
    constructor(exec: Executor, schema: TableDef);
    /**
     * Create the table (and indexes) if they do not exist.
     * Must be called explicitly — the ORM will not auto-create tables.
     */
    sync(): void;
    /**
     * Insert a row and return the full row.
     */
    insert(data: Insert): Row;
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
    insertMany(rows: Insert[], options?: {
        chunkSize?: number;
    }): Row[];
    /**
     * Find a row by its primary key (first primaryKey column).
     * Accepts number / bigint for INTEGER keys and string for TEXT/UUID keys.
     * Returns undefined if no rowid-based key column is found — use findOne() instead.
     */
    findById(id: number | bigint | string): Row | undefined;
    /**
     * Find a single row matching the condition.
     */
    findOne(where: WhereExpr<Partial<Row>> | SqlFragment): Row | undefined;
    /**
     * Find all rows matching the optional condition.
     */
    findAll(where?: WhereExpr<Partial<Row>> | SqlFragment): Row[];
    /**
     * Convenience: alias for findAll().
     */
    all(): Row[];
    /**
     * Update rows matching the condition. Returns the number of affected rows.
     * The `where` argument is required — use `db.exec(...)` or model query builder for bulk updates.
     */
    update(patch: Patch, where: WhereExpr<Partial<Row>> | SqlFragment): number;
    /**
     * Delete rows matching the condition. Returns the number of deleted rows.
     * The `where` argument is required.
     */
    delete(where: WhereExpr<Partial<Row>> | SqlFragment): number;
    /**
     * Delete all rows in the table. Returns the number of deleted rows.
     *
     * Explicit escape hatch — unlike `delete()`, no WHERE is required. Use for
     * test resets or full-table cleanup. (Deleting all rows never drops the
     * table or resets AUTOINCREMENT sequences.)
     */
    deleteAll(): number;
    /**
     * Count rows matching the optional condition.
     */
    count(where?: WhereExpr<Partial<Row>> | SqlFragment): number;
    /**
     * Check if at least one row matches the condition.
     * Uses a LIMIT 1 query — faster than count() on large tables.
     */
    exists(where: WhereExpr<Partial<Row>> | SqlFragment): boolean;
    /**
     * Get a fluent QueryBuilder for this table.
     */
    query(): QueryBuilder<Row>;
}
//# sourceMappingURL=model.d.ts.map