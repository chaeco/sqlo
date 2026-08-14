/**
 * Sqlo — the core class wrapping a `node:sqlite` DatabaseSync instance.
 */
import { type DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { TableDef, MigrationDef, MigrationStatus, RowOf, InsertOf, PatchOf } from '../schema/types.js';
import { Model } from '../model/model.js';
import type { Executor } from '../query/query-builder.js';
/**
 * SQLite journal modes for `PRAGMA journal_mode`.
 *
 * - `DELETE` (default) — rollback journal deleted after each commit
 * - `TRUNCATE` — journal truncated instead of deleted (fewer fsyncs)
 * - `PERSIST` — journal header zeroed, file kept
 * - `MEMORY` — journal kept in memory (fast, crash-unsafe)
 * - `WAL` — write-ahead log (readers don't block the writer)
 * - `OFF` — no journaling (largest risk of database corruption)
 */
export type SqliteJournalMode = 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF';
export interface SqloOptions {
    path?: string;
    open?: boolean;
    readBigInts?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    busyTimeout?: number;
    /**
     * Journal mode applied via `PRAGMA journal_mode` on open.
     * Defaults to SQLite's own default (`DELETE`). Use `'WAL'` for concurrent
     * read/write workloads; WAL is persistent on file databases but a no-op on
     * `:memory:` databases (they are always in-memory journaling).
     */
    journalMode?: SqliteJournalMode;
}
export interface MigrateOptions {
    /**
     * Database schema whose migration history is managed.
     * Defaults to 'main'; pass the name of an attached database to manage
     * its migrations independently.
     */
    schema?: string;
}
/**
 * The Sqlo ORM — a thin, synchronous wrapper over a `node:sqlite`
 * `DatabaseSync` connection.
 *
 * Provides typed models (`define`), parameter-bound query helpers
 * (`all` / `get` / `run`), transactions, SQL-file migrations, and raw access
 * to the underlying instance. SQLite-only, zero native dependencies.
 */
export declare class Sqlo implements Executor {
    #private;
    /**
     * Open (or create) a SQLite database.
     *
     * ```ts
     * const db = new Sqlo({ path: ':memory:' });
     * const db = new Sqlo({ path: './app.db' });
     * ```
     */
    constructor(options?: SqloOptions | string);
    /**
     * Returns the raw `node:sqlite` DatabaseSync instance for direct use.
     */
    raw(): DatabaseSyncType;
    /**
     * Execute a SQL string directly (no parameter binding).
     */
    exec(sql: string): void;
    /**
     * Prepare a statement and return all rows.
     */
    all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
    /**
     * Prepare a statement and return the first row, or undefined.
     */
    get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
    /**
     * Prepare a statement, execute it, and return the result info.
     */
    run(sql: string, ...params: unknown[]): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
    /**
     * Implement the Executor interface for QueryBuilder / Model.
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
     * Run a function inside a transaction.
     * Nested transactions use SAVEPOINT / RELEASE.
     *
     * ```ts
     * db.transaction(() => {
     *   db.exec('INSERT ...');
     * });
     * ```
     */
    transaction<T>(fn: () => T): T;
    /**
     * Attach another SQLite database file to this connection.
     *
     * After attaching, its tables are addressable with a `schema.table` name:
     *
     * ```ts
     * db.attach('./data/aux.db', 'aux');
     * const model = db.define({ name: 'aux.items', columns: { ... } });
     * ```
     *
     * The database name (`aux`) is validated as a safe identifier; the file
     * path is passed as a bound parameter (never concatenated).
     */
    attach(path: string, name: string): void;
    /**
     * Detach a previously attached database. Its schema name becomes
     * unavailable for further queries.
     */
    detach(name: string): void;
    /**
     * Define a model for a table.
     *
     * ```ts
     * const users = db.define({
     *   name: 'users',
     *   columns: {
     *     id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
     *     name: { type: 'TEXT', notNull: true },
     *   },
     * });
     * ```
     *
     * Does **not** create the table — call `users.sync()` or `db.syncAll()`.
     */
    define<const S extends TableDef>(schema: S): Model<RowOf<S>, InsertOf<S>, PatchOf<S>>;
    /**
     * Create all defined tables and indexes.
     */
    syncAll(): void;
    /**
     * Run pending migrations.
     * Returns the list of newly applied migrations.
     *
     * By default migrations are tracked against the main database. Pass
     * `{ schema: 'aux' }` to manage the migrations of an attached database —
     * the version table is created inside that schema, so each database keeps
     * an independent migration history.
     *
     * ```ts
     * db.attach('./audit.db', 'audit');
     * db.migrate(auditMigrations, { schema: 'audit' });
     * ```
     */
    migrate(migrations: MigrationDef[], options?: MigrateOptions): MigrationDef[];
    /**
     * List all migrations with their applied status.
     * Pass `{ schema }` to inspect an attached database's migration history.
     */
    migrationStatus(migrations: MigrationDef[], options?: MigrateOptions): MigrationStatus[];
    /**
     * Close the database connection.
     */
    close(): void;
}
//# sourceMappingURL=sqlo.d.ts.map