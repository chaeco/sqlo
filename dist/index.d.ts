import { DatabaseSync } from 'node:sqlite';

/**
 * Sqlo type definitions.
 * All canonical types live here — column definitions, table schemas,
 * type inference helpers, and where expression operators.
 */
declare const SQL_FRAGMENT: unique symbol;
declare const SQL_IDENT: unique symbol;
interface SqlFragment {
    readonly [SQL_FRAGMENT]: true;
    readonly text: string;
    readonly params: readonly unknown[];
}
interface Ident {
    readonly [SQL_IDENT]: true;
    readonly value: string;
}
type RefAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
type SqliteType = keyof TypeToJs;
interface ColumnDef<T extends string = SqliteType> {
    /** SQLite column type (e.g. 'INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'). Any SQLite type name is allowed (type affinity), but known names are constrained by `SqliteType` for typo protection. */
    type: T;
    primaryKey?: boolean;
    autoIncrement?: boolean;
    notNull?: boolean;
    unique?: boolean;
    collate?: string;
    /** Default value — literal number/string/boolean/null, or a sql\`...\` fragment */
    default?: unknown;
    /** CHECK constraint — a sql\`...\` fragment or plain SQL expression (no bound params) */
    check?: SqlFragment | string;
    /** Foreign key reference */
    references?: {
        table: string;
        column: string;
        onDelete?: RefAction;
        onUpdate?: RefAction;
    };
}
type IndexColumn = string | {
    name: string;
    direction?: 'ASC' | 'DESC';
};
interface IndexDef {
    name: string;
    columns: readonly IndexColumn[];
    unique?: boolean;
    /** Partial index predicate — a sql\`...\` fragment or plain SQL expression (no bound params) */
    where?: SqlFragment | string;
}
interface TableDef<C extends Record<string, ColumnDef<string>> = Record<string, ColumnDef<string>>> {
    name: string;
    columns: C;
    indexes?: readonly IndexDef[];
    /** Table-level CHECK constraints as sql\`...\` fragments or plain SQL expressions (no bound params) */
    checks?: readonly (SqlFragment | string)[];
    /** Appends STRICT to CREATE TABLE (SQLite ≥3.37) */
    strict?: boolean;
    /** Appends WITHOUT ROWID */
    withoutRowId?: boolean;
}
interface TypeToJs {
    INTEGER: number;
    REAL: number;
    NUMERIC: number;
    BOOLEAN: number;
    DOUBLE: number;
    FLOAT: number;
    DECIMAL: number;
    TINYINT: number;
    SMALLINT: number;
    MEDIUMINT: number;
    BIGINT: number;
    INT: number;
    INT2: number;
    INT8: number;
    BLOB: Uint8Array;
    TEXT: string;
    CHAR: string;
    VARCHAR: string;
    NCHAR: string;
    NVARCHAR: string;
    CLOB: string;
    DATETIME: string;
    DATE: string;
    TIMESTAMP: string;
}
type ColumnValue<D extends ColumnDef<string>> = D['type'] extends keyof TypeToJs ? TypeToJs[D['type']] : string;
type IsNullable<D extends ColumnDef<string>> = D['notNull'] extends true ? false : D['primaryKey'] extends true ? false : D['autoIncrement'] extends true ? false : true;
type HasProp<O, K extends PropertyKey> = K extends keyof O ? true : false;
type IsRequiredInInput<D extends ColumnDef<string>> = D['autoIncrement'] extends true ? false : D['primaryKey'] extends true ? (D['autoIncrement'] extends true ? false : true) : IsNullable<D> extends true ? false : HasProp<D, 'default'> extends true ? false : true;
type ColumnRowValue<D extends ColumnDef<string>> = IsNullable<D> extends true ? ColumnValue<D> | null : ColumnValue<D>;
type ColumnPatchValue<D extends ColumnDef<string>> = IsNullable<D> extends true ? ColumnValue<D> | null | undefined : ColumnValue<D> | undefined;
type RowOf<S extends TableDef> = {
    [K in keyof S['columns']]: ColumnRowValue<S['columns'][K]>;
};
type InsertOf<S extends TableDef> = {
    [K in keyof S['columns'] as IsRequiredInInput<S['columns'][K]> extends true ? K : never]: ColumnValue<S['columns'][K]>;
} & {
    [K in keyof S['columns'] as IsRequiredInInput<S['columns'][K]> extends true ? never : K]?: IsNullable<S['columns'][K]> extends true ? ColumnValue<S['columns'][K]> | null : ColumnValue<S['columns'][K]>;
} & {};
type PatchOf<S extends TableDef> = {
    [K in keyof S['columns'] as S['columns'][K]['autoIncrement'] extends true ? never : K]?: ColumnPatchValue<S['columns'][K]>;
};
interface WhereOps<T> {
    eq?: T;
    ne?: T;
    gt?: T;
    gte?: T;
    lt?: T;
    lte?: T;
    like?: string;
    notLike?: string;
    glob?: string;
    notGlob?: string;
    in?: readonly T[];
    notIn?: readonly T[];
    between?: readonly [T, T];
    is?: unknown;
    isNot?: unknown;
    isNull?: boolean;
    notNull?: boolean;
}
type WhereValue<T> = T | null | readonly T[] | WhereOps<T>;
type WhereExpr<T> = {
    [K in keyof T]?: WhereValue<T[K]>;
};
type OrderDir = 'asc' | 'desc' | 'ASC' | 'DESC';
interface MigrationDef {
    name: string;
    /** SQL string or callback receiving the raw Sqlo instance */
    up: string | ((db: {
        exec(sql: string): void;
    }) => void);
    down?: string | ((db: {
        exec(sql: string): void;
    }) => void);
}
interface MigrationStatus {
    name: string;
    appliedAt: string | null;
}
interface SqlOptions {
    path: string;
    readBigInts?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
    busyTimeout?: number;
}

/**
 * Fluent SQLite query builder.
 * Generates SELECT statements with parameter binding.
 */

interface Executor {
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
declare class QueryBuilder<Row extends Record<string, unknown> = Record<string, unknown>> {
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
     * Build only the WHERE clause (with params) for the current query state.
     * Returns `{ clause, params }` where `clause` is the full
     * `WHERE ...` fragment (or `''` when no conditions were added).
     *
     * Used by `Model#update` / `Model#delete` to compose UPDATE/DELETE
     * statements without re-parsing a complete SELECT — avoids fragile
     * string slicing on the compiled SQL.
     */
    buildWhere(): {
        clause: string;
        params: unknown[];
    };
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

/**
 * Model — CRUD operations bound to a table schema.
 */

/**
 * Typed CRUD operations bound to a single table schema.
 *
 * Created via `db.define(schema)`. Insert/read/update/delete methods are
 * type-driven by the schema's row, insert, and patch types. Tables are
 * created explicitly with `sync()` — never automatically.
 */
declare class Model<Row extends Record<string, unknown>, Insert, Patch> {
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

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Logging event categories. */
type LogEvent = 'query' | 'transaction' | 'schema' | 'connection' | 'migrate';
interface LogEntry {
    /** Severity. */
    level: LogLevel;
    /** Event category. */
    event: LogEvent;
    /** Human-readable summary. */
    message: string;
    /** The SQL involved (if any). */
    sql?: string;
    /** Bound parameters (if any). */
    params?: unknown[];
    /** Query / operation duration in milliseconds. */
    durationMs?: number;
    /** Extra context (e.g. transaction depth, migration name). */
    detail?: string;
    /** Timestamp (ms since epoch). */
    timestamp: number;
}

/**
 * Sqlo — the core class wrapping a `node:sqlite` DatabaseSync instance.
 */

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
type SqliteJournalMode = 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL' | 'OFF';
interface SqloOptions {
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
    /**
     * Behaviour logging window. Provide a callback to observe what Sqlo does —
     * queries, transactions, schema operations, connection lifecycle. Logging
     * is opt-in and never affects behaviour.
     *
     * @example
     * new Sqlo({ path: './app.db', onLog: (e) => console.log(e) })
     */
    onLog?: (entry: LogEntry) => void;
    /**
     * Minimum level emitted through `onLog`. Defaults to `'warn'` (warn + error).
     * Set to `'debug'` to observe every query.
     */
    logLevel?: LogLevel;
}
interface MigrateOptions {
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
declare class Sqlo implements Executor {
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
    raw(): DatabaseSync;
    /**
     * Whether the underlying database connection is still open.
     *
     * Useful for lifecycle management (e.g. checking a cached instance from a
     * `MultiSqlo` pool, or a worker-owned instance) before using it.
     */
    get isOpen(): boolean;
    /**
     * The SQLite library version (e.g. `3.46.0`).
     */
    get version(): string;
    /**
     * All attached databases with their schema name and backing file path.
     *
     * The first entry is always `main`. Attached databases (via `attach()`) are
     * listed after it. In-memory databases (`:memory:`) report an empty file path.
     *
     * Rows are normalized to plain objects (node:sqlite returns null-prototype rows).
     *
     * @example
     * db.databaseList()
     * // → [{ name: 'main', file: '/private/tmp/app.db' },
     * //    { name: 'audit', file: '/private/tmp/audit.db' }]
     */
    databaseList(): Array<{
        name: string;
        file: string;
    }>;
    /**
     * Check whether a table exists (optionally in a specific attached schema).
     *
     * Lightweight alternative to `reflectTableSchema` when you only need an
     * existence check — e.g. before `sync()`/`migrate()`, or in setup logic.
     *
     * @param name Table name, optionally `schema.table` (e.g. `'audit.logs'`).
     */
    tableExists(name: string): boolean;
    /**
     * Create an online backup of the current database to another file.
     *
     * Uses SQLite's `VACUUM INTO` (available since SQLite 3.27), which takes a
     * consistent snapshot even while the database is in use. The target path is
     * parameter-bound. Useful for pre-migration snapshots, scheduled backups, or
     * per-user backups in a `MultiSqlo` setup.
     *
     * @param target File path of the backup to create.
     */
    backup(target: string): void;
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
     *
     * Production concurrency: SQLite is single-writer, so concurrent writers can
     * hit `SQLITE_BUSY`. Pass `{ retry: n }` to automatically re-run the whole
     * transaction (from a fresh `BEGIN`) with exponential backoff when the
     * database is locked. Other errors propagate immediately. Retries only apply
     * to top-level transactions — a nested (SAVEPOINT) transaction belongs to an
     * outer one and is never retried.
     *
     * @example
     * db.transaction(() => {
     *   orders.insert({ ... });
     * }, { retry: 5 });
     */
    transaction<T>(fn: () => T, options?: {
        retry?: number;
    }): T;
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

/**
 * MultiSqlo — per-user database isolation for multi-tenant applications.
 *
 * Each user (tenant) gets their own independent SQLite database file and a
 * dedicated Sqlo connection. Data is fully isolated — nothing is shared
 * across users.
 *
 * ```ts
 * const pool = new MultiSqlo({
 *   dir: './data',
 *   migrations: [/* baseline schema for every new user's database *\/],
 * });
 *
 * const userDb = pool.for('user-123');   // cached; created + migrated on first access
 * const posts = userDb.define({ name: 'posts', ... });
 * ```
 */

interface MultiSqloOptions {
    /** Directory that holds one database file per user. */
    dir: string;
    /**
     * Baseline migrations applied to a user's database the first time it is
     * accessed (i.e. when the database file is created). Existing databases
     * are never re-migrated — Sqlo tracks applied migrations by name.
     */
    migrations?: MigrationDef[];
    /**
     * Connection options forwarded to each user's `Sqlo` instance
     * (e.g. `enableForeignKeyConstraints`).
     */
    options?: SqloOptions;
    /**
     * Map a userId to a database file name (without extension). Defaults to
     * `${userId}.db`. Must not introduce path separators.
     */
    fileName?: (userId: string) => string;
}
/**
 * Per-user database manager for multi-tenant applications.
 *
 * Each user (tenant) gets their own independent SQLite database file and a
 * dedicated Sqlo connection, so data is fully isolated across users. New
 * databases are created and baseline-migrated automatically on first access.
 */
declare class MultiSqlo {
    #private;
    /**
     * @param opts Directory to store per-user databases, baseline migrations,
     *   connection options, and an optional file-name strategy.
     */
    constructor(opts: MultiSqloOptions);
    /**
     * Get the Sqlo instance for a user, creating and migrating their database
     * on first access. The instance is cached and reused across calls.
     *
     * @throws if `userId` is not a safe file name component.
     */
    for(userId: string): Sqlo;
    /**
     * Whether a user's instance is currently open (cached).
     */
    has(userId: string): boolean;
    /**
     * Close a single user's database connection.
     */
    close(userId: string): void;
    /**
     * Close every open user database and clear the cache.
     */
    closeAll(): void;
    /**
     * Number of currently open (cached) user instances.
     */
    get size(): number;
}

/** SQLite result codes (subset — the ones application code branches on). */
declare const SQLITE: {
    /** SQLITE_ERROR — generic SQL error or missing database. */
    readonly ERROR: 1;
    /** SQLITE_BUSY — the database file is locked (another connection is writing). */
    readonly BUSY: 5;
    /** SQLITE_LOCKED — a table in the database is locked. */
    readonly LOCKED: 6;
    /** SQLITE_READONLY — attempt to write a readonly database. */
    readonly READONLY: 8;
    /** SQLITE_INTERRUPT — operation interrupted by `interrupt()`. */
    readonly INTERRUPT: 9;
    /** SQLITE_CORRUPT — the database file is corrupt. */
    readonly CORRUPT: 11;
    /** SQLITE_FULL — disk full. */
    readonly FULL: 13;
    /** SQLITE_CONSTRAINT — a UNIQUE / NOT NULL / CHECK / FK constraint failed. */
    readonly CONSTRAINT: 19;
};
/** The shape of errors raised by `node:sqlite` (an `Error` with SQLite codes). */
interface SqliteErrorLike extends Error {
    errcode?: number;
    errstr?: string;
}
/**
 * Type guard — is this an error caused by the database being locked
 * (`SQLITE_BUSY`, errcode 5)? SQLite is single-writer (see README); a busy
 * error means another connection holds the write lock. In production this is
 * the signal to back off and retry.
 */
declare function isBusyError(e: unknown): e is SqliteErrorLike;
/**
 * Type guard — is this a constraint violation (`SQLITE_CONSTRAINT`, errcode
 * 19)? Covers UNIQUE, NOT NULL, CHECK and foreign-key violations.
 */
declare function isConstraintError(e: unknown): e is SqliteErrorLike;

/**
 * Safe SQL composition helpers.
 *
 * - `sql\`...\`` — tagged template that builds a SqlFragment with bound params.
 * - `sql.ident('col')` — safely quoted identifier.
 * - `sql.raw(text, params?)` — manual fragment.
 * - `quoteIdent(name)` — double-quote and escape a SQL identifier.
 */

/**
 * Double-quote a SQL identifier (table name, column name), splitting on `.`.
 * Throws on invalid characters.
 */
declare function quoteIdent(name: string): string;
/**
 * Quote a table reference (supports "table AS alias").
 */
declare function quoteTable(table: string): string;
/**
 * Tagged template for safe SQL composition.
 *
 * ```ts
 * sql\`SELECT * FROM users WHERE name = ${name}\`
 * ```
 *
 * Interpolated values become `?` placeholders with auto-collected parameters.
 * Use `sql.ident(...)` to interpolate identifiers (safe auto-quoting).
 */
declare function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment;
declare namespace sql {
    var ident: (name: string) => Ident;
}
/**
 * Create a SqlFragment manually (no param binding applied — caller is responsible).
 */
declare function raw(text: string, params?: readonly unknown[]): SqlFragment;
/**
 * Type guard — is `v` a `SqlFragment` (created by `sql\`...\`` or `raw()`)?
 */
declare function isFragment(v: unknown): v is SqlFragment;
/**
 * Type guard — is `v` an `Ident` (created by `sql.ident()`)?
 */
declare function isIdent(v: unknown): v is Ident;

/**
 * DDL (Data Definition Language) generators.
 * Translates a TableDef into CREATE TABLE / CREATE INDEX statements.
 */

/**
 * Generate the column definition fragment (everything after the column
 * name) for a single column: type, constraints, defaults, CHECK, and
 * foreign key references.
 *
 * @param col The column definition.
 * @returns A fragment like `TEXT NOT NULL DEFAULT 'draft'` or
 *   `INTEGER PRIMARY KEY AUTOINCREMENT`.
 */
declare function columnDDL(col: ColumnDef<string>): string;
/**
 * Generate a `CREATE TABLE IF NOT EXISTS` statement from a table definition.
 * Columns, table-level CHECK constraints, `STRICT` and `WITHOUT ROWID`
 * options are all included.
 *
 * @param schema The table definition.
 * @returns A complete `CREATE TABLE IF NOT EXISTS "name" (...)` statement.
 */
declare function tableDDL(schema: TableDef): string;
/**
 * Generate `CREATE [UNIQUE] INDEX IF NOT EXISTS` statements for every index
 * declared in the table definition, including partial-index `WHERE` clauses
 * and per-column sort directions.
 *
 * @param schema The table definition.
 * @returns One `CREATE INDEX` statement per declared index; an empty array
 *   when the schema declares no indexes.
 */
declare function indexDDLs(schema: TableDef): string[];

/**
 * Schema diff — compare two table definitions and produce migration guidance.
 *
 * Sqlo never applies schema changes automatically (#30: SQL-file migrations
 * only). This module is the "planning aid": it tells you exactly what SQL
 * would be needed to move from one table definition to another, split into
 * safe statements (which you can run via ALTER TABLE / CREATE INDEX) and
 * warnings (changes SQLite cannot apply in place — those require a
 * table-rebuild migration written by hand).
 */

interface SchemaDiff {
    /** Column names added in `to` but absent in `from`. */
    addedColumns: string[];
    /** Column names present in `from` but removed in `to`. */
    removedColumns: string[];
    /** Columns whose type or constraints changed. */
    changedColumns: string[];
    /** Index names added in `to`. */
    addedIndexes: string[];
    /** Index names present in `from` but removed in `to`. */
    removedIndexes: string[];
    /**
     * SQL statements that can be executed directly to bring the schema up to
     * date (ALTER TABLE ADD COLUMN, CREATE INDEX IF NOT EXISTS).
     */
    statements: string[];
    /**
     * Human-readable warnings for changes that cannot be applied in place
     * (e.g. changing a column type, tightening NOT NULL) — these require a
     * table-rebuild migration.
     */
    warnings: string[];
}
/**
 * Compare two table definitions and produce migration guidance.
 */
declare function schemaDiff(from: TableDef, to: TableDef): SchemaDiff;
/**
 * Generate a ready-to-save migration SQL file from a schema diff.
 * The caller is expected to review and save the result as a `.sql` migration
 * file, then run it through `db.migrate()`.
 */
declare function generateMigrationSql(from: TableDef, to: TableDef, header?: string): string;

/**
 * Schema introspection — read the *actual* table structure from the
 * database and turn it into a TableDef that can be diffed against the
 * schema in your code.
 *
 * Real-world workflow: your database file already exists (created by an
 * older version), your code holds the latest schema. Introspect the live
 * table, then `schemaDiff(actual, desired)` to see exactly which columns /
 * indexes are missing and generate a migration.
 */

/**
 * Read a table's actual structure from the database.
 *
 * Returns a `TableDef` whose columns/indexes mirror what SQLite currently
 * has, suitable for passing as the `from` argument to `schemaDiff()`.
 *
 * ```ts
 * const actual = reflectTableSchema(db, 'users');
 * const diff = schemaDiff(actual, desiredSchema);
 * ```
 *
 * Detected: columns (type / notNull / primaryKey / default), indexes
 * (unique / partial), table options (strict / withoutRowId).
 *
 * Not detected (SQLite does not expose them via PRAGMA): column-level
 * CHECK expressions, column references (foreign keys), COLLATE. These are
 * best read from your schema files / migrations instead.
 */
declare function reflectTableSchema(exec: Executor, table: string): TableDef;

/**
 * Load table definitions from JSON.
 *
 * Table schemas are plain data, so they can live in `.json` files and be
 * loaded at runtime — useful for configuration-driven or multi-tenancy
 * setups. The loaded definition goes through the same `db.define()` schema
 * validation as object literals.
 *
 * Note: CHECK/WHERE constraints must be plain SQL strings in JSON (a JSON
 * file cannot express a bound-parameter fragment). This matches the
 * `SqlFragment | string` acceptance in `TableDef`.
 */

/**
 * Synchronously load a table definition from a JSON file.
 *
 * ```json
 * {
 *   "name": "users",
 *   "columns": {
 *     "id":   { "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
 *     "name": { "type": "TEXT", "notNull": true },
 *     "age":  { "type": "INTEGER", "check": "age >= 0" }
 *   },
 *   "indexes": [
 *     { "name": "idx_users_name", "columns": ["name"] }
 *   ]
 * }
 * ```
 */
declare function loadTableDefSync(jsonPath: string): TableDef;

/**
 * Migration utilities — file loader and runner helpers.
 *
 * Core migration logic lives in `Sqlo.migrate()` and `Sqlo.migrationStatus()`.
 * This module provides the file‑based loader.
 */

/**
 * Synchronously load migrations from a directory.
 *
 * - `.sql` files: treated as up‑only migrations (the entire file content is the SQL).
 * - `.mjs` / `.js` / `.cjs` files: must default‑export a `MigrationDef` or an array of `MigrationDef`.
 *
 * Files are sorted alphabetically by name.
 */
declare function loadMigrationsSync(dir: string): MigrationDef[];
/**
 * Asynchronously load migrations from a directory using `import()`.
 *
 * Handles `.sql`, `.mjs`, `.js`, and `.cjs` files.
 */
declare function loadMigrations(dir: string): Promise<MigrationDef[]>;

/**
 * Async wrapper for Sqlo.
 *
 * Removes database operations from the main thread by delegating to a
 * worker thread. This prevents synchronous SQLite operations from blocking
 * the event loop in web server / request‑handling contexts.
 *
 * ⚠️  Honest disclaimer:
 * The underlying SQLite is still synchronous.  Using the async wrapper
 * only avoids event‑loop blocking — it does not make SQLite concurrent.
 * SQLite's single‑writer lock still applies.
 */
/**
 * Async wrapper around Sqlo that delegates database operations to a worker
 * thread, avoiding event-loop blocking in request-handling contexts.
 *
 * **Honest disclaimer:** SQLite underneath is still synchronous and
 * single-writer. `AsyncSqlo` only avoids event-loop blocking — it does not
 * make SQLite concurrent, and multi-process writes still surface as lock
 * timeout errors.
 */
declare class AsyncSqlo {
    #private;
    /**
     * @param path Database file path (or `':memory:'`) opened inside the worker.
     * @param options Options forwarded to the worker's `DatabaseSync` constructor.
     */
    constructor(path: string, options?: Record<string, unknown>);
    /**
     * Execute a SQL string (no return value).
     */
    exec(sql: string): Promise<void>;
    /**
     * Execute and return all rows.
     */
    all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
    /**
     * Execute and return the first row, or undefined.
     */
    get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    /**
     * Execute and return { changes, lastInsertRowid }.
     *
     * `changes` / `lastInsertRowid` may be `bigint` when the worker returns
     * large integers — coerce with `Number()` if you need a plain number.
     */
    run(sql: string, ...params: unknown[]): Promise<{
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    }>;
    /**
     * Close the worker and its database connection.
     */
    close(): Promise<void>;
    /**
     * Terminate the worker immediately (without graceful shutdown).
     */
    terminate(): void;
}

export { AsyncSqlo, Model, MultiSqlo, QueryBuilder, SQLITE, Sqlo, columnDDL, generateMigrationSql, indexDDLs, isBusyError, isConstraintError, isFragment, isIdent, loadMigrations, loadMigrationsSync, loadTableDefSync, quoteIdent, quoteTable, raw, reflectTableSchema, schemaDiff, sql, tableDDL };
export type { ColumnDef, ColumnValue, Ident, IndexDef, InsertOf, LogEntry, LogEvent, LogLevel, MigrateOptions, MigrationDef, MigrationStatus, MultiSqloOptions, OrderDir, PatchOf, RefAction, RowOf, SchemaDiff, SqlFragment, SqlOptions, SqliteErrorLike, SqliteType, SqloOptions, TableDef, TypeToJs, WhereExpr, WhereOps, WhereValue };
