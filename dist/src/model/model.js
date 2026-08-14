/**
 * Model — CRUD operations bound to a table schema.
 */
import { quoteIdent } from "../query/sql.js";
import { tableDDL, indexDDLs } from "../schema/ddl.js";
import { QueryBuilder } from "../query/query-builder.js";
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
export class Model {
    #schema;
    #exec;
    table;
    /**
     * @param exec Executor that runs prepared statements (usually a Sqlo).
     * @param schema The table definition that drives this model's types.
     */
    constructor(exec, schema) {
        this.#exec = exec;
        this.#schema = schema;
        this.table = schema.name;
    }
    // ---- Schema sync ----
    /**
     * Create the table (and indexes) if they do not exist.
     * Must be called explicitly — the ORM will not auto-create tables.
     */
    sync() {
        this.#exec.prepare(tableDDL(this.#schema)).run();
        for (const ddl of indexDDLs(this.#schema)) {
            this.#exec.prepare(ddl).run();
        }
    }
    // ---- INSERT ----
    /**
     * Insert a row and return the full row.
     */
    insert(data) {
        this.#validateKeys(data);
        const cols = Object.keys(data);
        if (cols.length === 0) {
            // INSERT with no columns: use DEFAULT VALUES
            this.#exec.prepare(`INSERT INTO ${quoteIdent(this.table)} DEFAULT VALUES`).run();
            return this.#resolveAfterInsert(data, this.#lastInsertRowid());
        }
        const colIdents = cols.map((c) => quoteIdent(c)).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const values = Object.values(data);
        const stmt = this.#exec.prepare(`INSERT INTO ${quoteIdent(this.table)} (${colIdents}) VALUES (${placeholders})`);
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
    insertMany(rows) {
        if (rows.length === 0)
            return [];
        const tx = this.#exec.transaction;
        if (tx) {
            // Method-form call keeps `this` bound to the executor (Sqlo).
            return tx.call(this.#exec, () => rows.map((r) => this.insert(r)));
        }
        return rows.map((r) => this.insert(r));
    }
    // ---- SELECT ----
    /**
     * Find a row by its primary key (first primaryKey column).
     * Accepts number / bigint for INTEGER keys and string for TEXT/UUID keys.
     * Returns undefined if no rowid-based key column is found — use findOne() instead.
     */
    findById(id) {
        const pkCols = this.#pkColumns();
        if (pkCols.length === 0) {
            throw new Error(`Table "${this.table}" has no primary key column defined. Use findOne() instead.`);
        }
        const where = {};
        where[pkCols[0]] = id;
        return this.findOne(where);
    }
    /**
     * Find a single row matching the condition.
     */
    findOne(where) {
        const qb = this.query();
        qb.where(where);
        return qb.first();
    }
    /**
     * Find all rows matching the optional condition.
     */
    findAll(where) {
        const qb = this.query();
        if (where !== undefined)
            qb.where(where);
        return qb.all();
    }
    /**
     * Convenience: alias for findAll().
     */
    all() {
        return this.findAll();
    }
    // ---- UPDATE ----
    /**
     * Update rows matching the condition. Returns the number of affected rows.
     * The `where` argument is required — use `db.exec(...)` or model query builder for bulk updates.
     */
    update(patch, where) {
        this.#validateKeys(patch);
        const patchKeys = Object.keys(patch);
        if (patchKeys.length === 0)
            return 0;
        const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
        const patchValues = Object.values(patch);
        const qb = new QueryBuilder(this.#exec, this.table);
        qb.where(where);
        const { sql, params } = qb.toSql();
        // Extract WHERE clause from the full SELECT
        const whereIdx = sql.indexOf(' WHERE ');
        if (whereIdx < 0) {
            throw new Error('update() requires a WHERE condition. Use db.exec() for bulk updates.');
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
    delete(where) {
        const qb = new QueryBuilder(this.#exec, this.table);
        qb.where(where);
        const { sql, params } = qb.toSql();
        const whereIdx = sql.indexOf(' WHERE ');
        if (whereIdx < 0) {
            throw new Error('delete() requires a WHERE condition. Use db.exec() for bulk deletes.');
        }
        const whereClause = sql.slice(whereIdx);
        const stmt = this.#exec.prepare(`DELETE FROM ${quoteIdent(this.table)}${whereClause}`);
        const result = stmt.run(...params);
        return Number(result.changes);
    }
    // ---- COUNT / EXISTS ----
    /**
     * Count rows matching the optional condition.
     */
    count(where) {
        const qb = this.query();
        if (where !== undefined)
            qb.where(where);
        return qb.count();
    }
    /**
     * Check if at least one row matches the condition.
     * Uses a LIMIT 1 query — faster than count() on large tables.
     */
    exists(where) {
        return this.findOne(where) !== undefined;
    }
    // ---- Query builder ----
    /**
     * Get a fluent QueryBuilder for this table.
     */
    query() {
        return new QueryBuilder(this.#exec, this.table);
    }
    // ---- Internal ----
    #validateKeys(data) {
        if (typeof data !== 'object' || data === null)
            return;
        const colSet = new Set(Object.keys(this.#schema.columns));
        for (const key of Object.keys(data)) {
            if (!colSet.has(key)) {
                throw new Error(`Unknown column "${key}" on table "${this.table}". ` +
                    `Valid columns: ${[...colSet].join(', ')}`);
            }
        }
    }
    #lastInsertRowid() {
        const row = this.#exec.prepare('SELECT last_insert_rowid() AS "rid"').get();
        return row?.rid ?? 0;
    }
    #resolveAfterInsert(data, lastInsertRowid) {
        const schema = this.#schema;
        // If WITHOUT ROWID, use primary key columns from input
        if (schema.withoutRowId) {
            const pkCols = this.#pkColumns();
            const where = {};
            for (const pk of pkCols) {
                const v = data[pk];
                if (v === undefined) {
                    throw new Error(`Cannot resolve row after insert on WITHOUT ROWID table "${this.table}": ` +
                        `primary key column "${pk}" was not provided in insert data.`);
                }
                where[pk] = v;
            }
            return this.findOne(where);
        }
        // Rowid table: use lastInsertRowid (which is also the INTEGER PRIMARY KEY alias)
        const stmt = this.#exec.prepare(`SELECT * FROM ${quoteIdent(this.table)} WHERE rowid = ?`);
        return stmt.get(lastInsertRowid);
    }
    #pkColumns() {
        return Object.entries(this.#schema.columns)
            .filter(([, col]) => col.primaryKey)
            .map(([name]) => name);
    }
}
//# sourceMappingURL=model.js.map