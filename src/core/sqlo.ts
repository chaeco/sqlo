/**
 * Sqlo — the core class wrapping a `node:sqlite` DatabaseSync instance.
 */

import { DatabaseSync, type DatabaseSync as DatabaseSyncType } from 'node:sqlite';

type SQLInputValue = number | bigint | string | Uint8Array | null;
import type { TableDef, MigrationDef, MigrationStatus, RowOf, InsertOf, PatchOf } from '../schema/types.ts';
import { Model } from '../model/model.ts';
import type { Executor } from '../query/query-builder.ts';
import { quoteIdent } from '../query/sql.ts';
import { isBusyError } from './error.ts';
import { shouldLog, type LogEntry, type LogLevel, type LogEvent } from './logging.ts';

// ---------------------------------------------------------------------------
// SqloOptions
// ---------------------------------------------------------------------------

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
export type SqliteJournalMode =
  | 'DELETE'
  | 'TRUNCATE'
  | 'PERSIST'
  | 'MEMORY'
  | 'WAL'
  | 'OFF';

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

export interface MigrateOptions {
  /**
   * Database schema whose migration history is managed.
   * Defaults to 'main'; pass the name of an attached database to manage
   * its migrations independently.
   */
  schema?: string;
}

// ---------------------------------------------------------------------------
// Sqlo class
// ---------------------------------------------------------------------------

/**
 * The Sqlo ORM — a thin, synchronous wrapper over a `node:sqlite`
 * `DatabaseSync` connection.
 *
 * Provides typed models (`define`), parameter-bound query helpers
 * (`all` / `get` / `run`), transactions, SQL-file migrations, and raw access
 * to the underlying instance. SQLite-only, zero native dependencies.
 */
export class Sqlo implements Executor {
  readonly #db: DatabaseSyncType;
  readonly #options: Required<Omit<SqloOptions, 'onLog'>> & { onLog?: (entry: LogEntry) => void };
  #models: Map<string, { sync(): void }> = new Map();
  #closed = false;
  /** Re-entry guard: prevents an `onLog` callback from triggering new log events. */
  #logging = false;

  /**
   * Open (or create) a SQLite database.
   *
   * ```ts
   * const db = new Sqlo({ path: ':memory:' });
   * const db = new Sqlo({ path: './app.db' });
   * ```
   */
  constructor(options: SqloOptions | string = {}) {
    const opts: SqloOptions = typeof options === 'string' ? { path: options } : { ...options };
    const path = opts.path ?? ':memory:';

    this.#options = {
      path,
      open: opts.open ?? true,
      readBigInts: opts.readBigInts ?? false,
      enableForeignKeyConstraints: opts.enableForeignKeyConstraints ?? true,
      enableDoubleQuotedStringLiterals: opts.enableDoubleQuotedStringLiterals ?? false,
      allowExtension: opts.allowExtension ?? false,
      busyTimeout: opts.busyTimeout ?? 0,
      journalMode: opts.journalMode ?? 'DELETE',
      logLevel: opts.logLevel ?? 'warn',
      ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
    };

    this.#db = new DatabaseSync(path, {
      open: this.#options.open,
      readBigInts: this.#options.readBigInts,
      enableForeignKeyConstraints: this.#options.enableForeignKeyConstraints,
      enableDoubleQuotedStringLiterals: this.#options.enableDoubleQuotedStringLiterals,
      allowExtension: this.#options.allowExtension,
    });

    if (this.#options.busyTimeout > 0) {
      this.#db.exec(`PRAGMA busy_timeout = ${this.#options.busyTimeout}`);
    }
    if (opts.journalMode !== undefined && opts.journalMode !== 'DELETE') {
      this.#db.exec(`PRAGMA journal_mode = ${this.#options.journalMode}`);
    }

    this.#log('connection', `open database ${path === ':memory:' ? '(in-memory)' : path}`, {
      detail: `journalMode=${this.#options.journalMode}, fk=${this.#options.enableForeignKeyConstraints}`,
    });
  }

  // ---- Raw access ----

  /**
   * Returns the raw `node:sqlite` DatabaseSync instance for direct use.
   */
  raw(): DatabaseSyncType {
    return this.#db;
  }

  // ---- Connection state & introspection ----

  /**
   * Whether the underlying database connection is still open.
   *
   * Useful for lifecycle management (e.g. checking a cached instance from a
   * `MultiSqlo` pool, or a worker-owned instance) before using it.
   */
  get isOpen(): boolean {
    return this.#db.isOpen;
  }

  /**
   * The SQLite library version (e.g. `3.46.0`).
   */
  get version(): string {
    this.#ensureOpen();
    const row = this.#db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    return row.v;
  }

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
  databaseList(): Array<{ name: string; file: string }> {
    this.#ensureOpen();
    const rows = this.#db.prepare('PRAGMA database_list').all() as Array<{
      name: string;
      file: string;
    }>;
    return rows.map((r) => ({ name: r.name, file: r.file }));
  }

  /**
   * Check whether a table exists (optionally in a specific attached schema).
   *
   * Lightweight alternative to `reflectTableSchema` when you only need an
   * existence check — e.g. before `sync()`/`migrate()`, or in setup logic.
   *
   * @param name Table name, optionally `schema.table` (e.g. `'audit.logs'`).
   */
  tableExists(name: string): boolean {
    this.#ensureOpen();
    let schema: string | undefined;
    let table = name;
    const dot = name.indexOf('.');
    if (dot > 0) {
      schema = name.slice(0, dot);
      table = name.slice(dot + 1);
    }
    const sql = schema
      ? `SELECT 1 FROM ${quoteIdent(schema)}.sqlite_master WHERE type = 'table' AND tbl_name = ?`
      : 'SELECT 1 FROM sqlite_master WHERE type = \'table\' AND tbl_name = ?';
    const row = this.#db.prepare(sql).get(table) as { 1: number } | undefined;
    return row !== undefined;  }

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
  backup(target: string): void {
    this.#ensureOpen();
    const started = performance.now();
    this.#db.prepare('VACUUM INTO ?').run(target);
    this.#log('connection', `backup to ${target}`, { detail: `took ${(performance.now() - started).toFixed(1)}ms` });
  }

  // ---- Low-level helpers ----

  /**
   * Execute a SQL string directly (no parameter binding).
   */
  exec(sql: string): void {
    this.#ensureOpen();
    const started = performance.now();
    this.#db.exec(sql);
    this.#log('query', `exec: ${sql}`, { sql, durationMs: performance.now() - started });
  }

  /**
   * Prepare a statement and return all rows.
   */
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    this.#ensureOpen();
    const started = performance.now();
    const stmt = this.#db.prepare(sql);
    const rows = plainRows(stmt.all(...params as SQLInputValue[]) as T[]);
    this.#log('query', `all: ${sql}`, { sql, params, durationMs: performance.now() - started });
    return rows;
  }

  /**
   * Prepare a statement and return the first row, or undefined.
   */
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    this.#ensureOpen();
    const started = performance.now();
    const stmt = this.#db.prepare(sql);
    const row = plainRow(stmt.get(...params as SQLInputValue[]) as T | undefined);
    this.#log('query', `get: ${sql}`, { sql, params, durationMs: performance.now() - started });
    return row;
  }

  /**
   * Prepare a statement, execute it, and return the result info.
   */
  run(
    sql: string,
    ...params: unknown[]
  ): { changes: number | bigint; lastInsertRowid: number | bigint } {
    this.#ensureOpen();
    const started = performance.now();
    const stmt = this.#db.prepare(sql);
    const result = stmt.run(...params as SQLInputValue[]);
    this.#log('query', `run: ${sql}`, { sql, params, durationMs: performance.now() - started });
    return result;
  }

  /**
   * Implement the Executor interface for QueryBuilder / Model.
   */
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  } {
    this.#ensureOpen();
    const stmt = this.#db.prepare(sql);
    const self = this;
    return {
      all(...params: unknown[]): Record<string, unknown>[] {
        const started = performance.now();
        const rows = plainRows(stmt.all(...params as SQLInputValue[]) as Record<string, unknown>[]);
        self.#log('query', `all: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return rows;
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        const started = performance.now();
        const row = plainRow(stmt.get(...params as SQLInputValue[]) as Record<string, unknown> | undefined);
        self.#log('query', `get: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return row;
      },
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
        const started = performance.now();
        const result = stmt.run(...params as SQLInputValue[]);
        self.#log('query', `run: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return result;
      },
    };
  }

  // ---- Behaviour logging ----

  /**
   * Emit a behaviour log entry through the configured `onLog` window,
   * filtered by `logLevel`. No-op when no window is configured.
   *
   * Re-entrancy guard: while `onLog` is executing, any further `#log` calls
   * are dropped. This prevents an `onLog` callback that itself performs
   * database operations (e.g. writing logs to a table) from recursively
   * triggering new log events.
   */
  #log(
    event: LogEvent,
    message: string,
    fields?: { sql?: string; params?: unknown[]; durationMs?: number; detail?: string; level?: LogLevel },
  ): void {
    const onLog = this.#options.onLog;
    if (!onLog) return;
    if (this.#logging) return; // drop nested events — never recurse
    const level = fields?.level ?? 'info';
    if (!shouldLog(level, this.#options.logLevel)) return;
    const entry: LogEntry = {
      level,
      event,
      message,
      timestamp: Date.now(),
      ...(fields?.sql !== undefined ? { sql: fields.sql } : {}),
      ...(fields?.params !== undefined ? { params: fields.params } : {}),
      ...(fields?.durationMs !== undefined ? { durationMs: Math.round(fields.durationMs * 10) / 10 } : {}),
      ...(fields?.detail !== undefined ? { detail: fields.detail } : {}),
    };
    this.#logging = true;
    try {
      onLog(entry);
    } catch {
      // A user log handler must never break the database operation.
    } finally {
      this.#logging = false;
    }
  }

  // ---- Transaction ----

  #txDepth = 0;

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
  transaction<T>(fn: () => T, options?: { retry?: number }): T {
    this.#ensureOpen();

    // Nested transactions (SAVEPOINT) are never retried — they share the outer
    // transaction's fate and can't be re-entered independently.
    if (this.#txDepth > 0 || (options?.retry ?? 0) <= 0) {
      return this.#transactionOnce(fn);
    }

    const maxRetries = options!.retry!;
    let attempt = 0;
    for (;;) {
      try {
        return this.#transactionOnce(fn);
      } catch (err) {
        if (!isBusyError(err) || attempt >= maxRetries) throw err;
        attempt++;
        this.#log('transaction', `retry transaction (attempt ${attempt}/${maxRetries}) after SQLITE_BUSY`, {
          detail: `backoff delay computed for attempt ${attempt}`,
          level: 'warn',
        });
        // Exponential backoff: 50ms, 100ms, 200ms, ...
        const delay = 50 * 2 ** (attempt - 1);
        const deadline = Date.now() + delay;
        // Busy-wait via Atomics.wait is not available in the main thread; a
        // synchronous sleep is the honest way to back off in a sync-first API.
        while (Date.now() < deadline) {
          // spin
        }
      }
    }
  }

  #transactionOnce<T>(fn: () => T): T {
    this.#ensureOpen();
    const isTop = this.#txDepth === 0;
    if (isTop) {
      this.#db.exec('BEGIN');
      this.#log('transaction', 'BEGIN transaction');
    } else {
      this.#db.exec(`SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
      this.#log('transaction', `BEGIN SAVEPOINT (depth ${this.#txDepth})`);
    }
    this.#txDepth++;

    try {
      const result = fn();
      this.#txDepth--;
      if (this.#txDepth === 0) {
        this.#db.exec('COMMIT');
        this.#log('transaction', 'COMMIT transaction');
      } else {
        this.#db.exec(`RELEASE SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
        this.#log('transaction', `RELEASE SAVEPOINT (depth ${this.#txDepth})`);
      }
      return result;
    } catch (err) {
      this.#txDepth--;
      if (this.#txDepth === 0) {
        this.#db.exec('ROLLBACK');
        this.#log('transaction', 'ROLLBACK transaction', { level: 'warn' });
      } else {
        this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
        this.#log('transaction', `ROLLBACK TO SAVEPOINT (depth ${this.#txDepth})`, { level: 'warn' });
      }
      throw err;
    }
  }

  // ---- Multiple databases (ATTACH / DETACH) ----

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
  attach(path: string, name: string): void {
    this.#ensureOpen();
    const ident = quoteIdent(name);
    // The schema name cannot be a bound parameter — it's an identifier, so
    // it is validated and quoted; the file path is always bound.
    this.#db.prepare(`ATTACH DATABASE ? AS ${ident}`).run(path);
    this.#log('connection', `ATTACH database "${name}" from ${path}`);
  }

  /**
   * Detach a previously attached database. Its schema name becomes
   * unavailable for further queries.
   */
  detach(name: string): void {
    this.#ensureOpen();
    this.#db.exec(`DETACH DATABASE ${quoteIdent(name)}`);
    this.#log('connection', `DETACH database "${name}"`);
  }

  // ---- Schema & Model ----

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
  define<const S extends TableDef>(
    schema: S,
  ): Model<RowOf<S>, InsertOf<S>, PatchOf<S>> {
    this.#ensureOpen();
    // Validate the schema
    const { errors, warnings } = validateSchema(schema);
    if (errors.length > 0) {
      throw new Error(
        `Invalid schema for table "${schema.name}":\n  ${errors.join('\n  ')}`,
      );
    }
    for (const warning of warnings) {
      process.emitWarning(warning, { code: 'SQLO_SCHEMA_WARNING' });
    }

    // Foreign keys: warn when the schema declares references but the
    // connection has foreign-key enforcement disabled — the declared
    // ON DELETE / ON UPDATE actions would silently not fire.
    if (!this.#options.enableForeignKeyConstraints && schemaHasReferences(schema)) {
      process.emitWarning(
        `Table "${schema.name}" declares foreign key references but the connection has ` +
        'foreign key enforcement disabled (enableForeignKeyConstraints: false). ' +
        'ON DELETE / ON UPDATE actions will NOT fire. Enable the option to enforce them.',
        { code: 'SQLO_FOREIGN_KEYS_DISABLED' },
      );
    }

    const model = new Model<RowOf<S>, InsertOf<S>, PatchOf<S>>(this, schema);
    this.#models.set(schema.name, model);
    this.#log('schema', `define model for "${schema.name}"`, {
      detail: `${Object.keys(schema.columns).length} columns, ${schema.indexes?.length ?? 0} indexes`,
    });
    return model;
  }

  /**
   * Create all defined tables and indexes.
   */
  syncAll(): void {
    this.#ensureOpen();
    for (const model of this.#models.values()) {
      model.sync();
    }
  }

  // ---- Migration ----

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
  migrate(migrations: MigrationDef[], options?: MigrateOptions): MigrationDef[] {
    this.#ensureOpen();
    const schema = options?.schema ?? 'main';
    this.#ensureMigrationTable(schema);

    const applied = this.#getAppliedMigrations(schema);
    const pending = migrations.filter((m) => !applied.has(m.name));

    for (const m of pending) {
      // Participate in an outer transaction when present (nested via SAVEPOINT),
      // otherwise open a dedicated transaction per migration so that already
      // applied migrations survive a later failure.
      if (this.#txDepth === 0) {
        this.#db.exec('BEGIN');
      } else {
        this.#db.exec(`SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
      }
      this.#txDepth++;
      try {
        this.#applyMigration(m, schema);
        this.#log('migrate', `applied migration "${m.name}"`, { detail: `schema "${schema}"` });
        this.#txDepth--;
        if (this.#txDepth === 0) {
          this.#db.exec('COMMIT');
        } else {
          this.#db.exec(`RELEASE SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
        }
      } catch (err) {
        this.#txDepth--;
        this.#log('migrate', `migration "${m.name}" failed`, { detail: `schema "${schema}"`, level: 'error' });
        if (this.#txDepth === 0) {
          this.#db.exec('ROLLBACK');
        } else {
          this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
        }
        throw new Error(
          `Migration "${m.name}" failed. DB has been rolled back.`,
          { cause: err },
        );
      }
    }

    if (pending.length > 0) {
      this.#log('migrate', `applied ${pending.length} migration(s)`, { detail: `schema "${schema}"` });
    } else {
      this.#log('migrate', 'no pending migrations', { detail: `schema "${schema}"` });
    }

    return pending;
  }

  /**
   * List all migrations with their applied status.
   * Pass `{ schema }` to inspect an attached database's migration history.
   */
  migrationStatus(migrations: MigrationDef[], options?: MigrateOptions): MigrationStatus[] {
    this.#ensureOpen();
    const schema = options?.schema ?? 'main';
    this.#ensureMigrationTable(schema);
    const applied = this.#getAppliedMigrations(schema);

    return migrations.map((m) => ({
      name: m.name,
      appliedAt: applied.get(m.name) ?? null,
    }));
  }

  // ---- Close ----

  /**
   * Close the database connection.
   */
  close(): void {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
      this.#log('connection', 'close database');
    }
  }

  // ---- Internal ----

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error('Database is closed.');
    }
  }

  #migrationTableRef(schema: string): string {
    // 'main' is the default schema — keep the historical bare table name
    // (`_sqlo_migrations`) so existing databases keep their migration history.
    // Any other schema is an attached database: quote it explicitly.
    return schema === 'main'
      ? '"_sqlo_migrations"'
      : `${quoteIdent(schema)}."_sqlo_migrations"`;
  }

  #ensureMigrationTable(schema: string): void {
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#migrationTableRef(schema)} (
        "name" TEXT PRIMARY KEY NOT NULL,
        "applied_at" TEXT NOT NULL
      )`,
    );
  }

  #getAppliedMigrations(schema: string): Map<string, string> {
    const rows = this.#db.prepare(
      `SELECT "name", "applied_at" FROM ${this.#migrationTableRef(schema)} ORDER BY "name"`,
    ).all() as { name: string; applied_at: string }[];
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.name, row.applied_at);
    }
    return map;
  }

  #applyMigration(m: MigrationDef, schema: string): void {
    const ts = new Date().toISOString();

    if (typeof m.up === 'string') {
      this.#db.exec(m.up);
    } else {
      m.up({ exec: (sql: string) => this.#db.exec(sql) });
    }

    this.#db.prepare(
      `INSERT INTO ${this.#migrationTableRef(schema)} ("name", "applied_at") VALUES (?, ?)`,
    ).run(m.name, ts);
  }
}

// ---------------------------------------------------------------------------
// Row normalization
//
// node:sqlite returns rows with a null prototype. The ORM layer normalizes
// them to plain objects for friendlier DX (deep-equal, JSON, spread). Users
// who need the raw objects can go through sqlo.raw().
// ---------------------------------------------------------------------------

function plainRow<T extends Record<string, unknown>>(row: T | undefined): T | undefined {
  if (row === undefined) return undefined;
  return { ...row };
}

function plainRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const VALID_COLUMN_TYPES = new Set([
  'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
  'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP',
  'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'CLOB',
  'DOUBLE', 'FLOAT', 'DECIMAL', 'TINYINT', 'SMALLINT',
  'MEDIUMINT', 'BIGINT', 'INT', 'INT2', 'INT8',
]);

const VALID_REF_ACTIONS = new Set([
  'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION',
]);

function schemaHasReferences(schema: TableDef): boolean {
  return Object.values(schema.columns).some((col) => col.references !== undefined);
}

function validateSchema(schema: TableDef): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!schema.name) {
    errors.push('Table name is required.');
  } else if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(schema.name)) {
    errors.push(
      `Invalid table name: "${schema.name}". ` +
      'Use "table" or "schema.table" (for attached databases).',
    );
  }

  const colNames = Object.keys(schema.columns);
  if (colNames.length === 0) {
    errors.push('At least one column is required.');
  }

  for (const name of colNames) {
    const col = schema.columns[name]!;
    if (!col.type) {
      errors.push(`Column "${name}" is missing a "type".`);
    } else if (!VALID_COLUMN_TYPES.has(col.type.toUpperCase())) {
      // SQLite accepts arbitrary type names (type affinity). Follow SQLite's
      // semantics but warn — a non-standard type name is often a typo.
      warnings.push(
        `Column "${name}" has a non-standard type "${col.type}". ` +
          'SQLite accepts it (type affinity), but ensure this is intentional.',
      );
    }

    if (col.autoIncrement && (!col.primaryKey || col.type.toUpperCase() !== 'INTEGER')) {
      errors.push(
        `Column "${name}": autoIncrement requires type INTEGER and primaryKey=true.`,
      );
    }

    if (col.references) {
      const ref = col.references;
      if (ref.onDelete && !VALID_REF_ACTIONS.has(ref.onDelete)) {
        errors.push(`Column "${name}": invalid onDelete "${ref.onDelete}".`);
      }
      if (ref.onUpdate && !VALID_REF_ACTIONS.has(ref.onUpdate)) {
        errors.push(`Column "${name}": invalid onUpdate "${ref.onUpdate}".`);
      }
    }

    if (col.check && typeof col.check !== 'string' && col.check.params.length > 0) {
      errors.push(
        `Column "${name}": CHECK constraint cannot contain bound parameters.`,
      );
    }
  }

  // Validate indexes
  if (schema.indexes) {
    const idxNames = new Set<string>();
    for (const idx of schema.indexes) {
      if (idxNames.has(idx.name)) {
        errors.push(`Duplicate index name: "${idx.name}".`);
      }
      idxNames.add(idx.name);
      if (idx.columns.length === 0) {
        errors.push(`Index "${idx.name}" has no columns.`);
      }
      for (const c of idx.columns) {
        const colName = typeof c === 'string' ? c : c.name;
        if (!schema.columns[colName]) {
          errors.push(`Index "${idx.name}" references unknown column "${colName}".`);
        }
      }
      if (idx.where && typeof idx.where !== 'string' && idx.where.params.length > 0) {
        errors.push(`Index "${idx.name}": WHERE clause cannot contain bound parameters.`);
      }
    }
  }

  // Validate table-level CHECK constraints
  if (schema.checks) {
    for (let i = 0; i < schema.checks.length; i++) {
      const chk = schema.checks[i]!;
      if (typeof chk !== 'string' && chk.params.length > 0) {
        errors.push(
          `CHECK constraint #${i} on table "${schema.name}" cannot contain bound parameters.`,
        );
      }
    }
  }

  return { errors, warnings };
}