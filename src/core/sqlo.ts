/**
 * Sqlo — the core class wrapping a `node:sqlite` DatabaseSync instance.
 */

import { DatabaseSync, type DatabaseSync as DatabaseSyncType } from 'node:sqlite';

type SQLInputValue = number | bigint | string | Uint8Array | null;
import type { TableDef, MigrationDef, MigrationStatus, RowOf, InsertOf, PatchOf, BaseColumns, WithBaseColumns } from '../schema/types';
import { validateSchema, schemaHasReferences } from '../schema/validate';
import { Model } from '../model/model';
import type { Executor } from '../query/query-builder';
import { quoteIdent } from '../query/sql';
import {
  ensureMigrationTableSql,
  migrationTableExistsSql,
  getAppliedMigrationsSql,
  insertMigrationRecordSql,
  computePending,
} from '../migration/migration';
import { isBusyError } from './error';
import { shouldLog, type LogEntry, type LogLevel, type LogEvent } from './logging';
import { toBindables } from './bind';

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

/** Runtime whitelist for `journalMode` — it is interpolated into a PRAGMA. */
const JOURNAL_MODES = new Set<SqliteJournalMode>([
  'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF',
]);

export interface SqloOptions<B extends BaseColumns = BaseColumns> {
  path?: string;
  open?: boolean;
  readBigInts?: boolean;
  enableForeignKeyConstraints?: boolean;
  enableDoubleQuotedStringLiterals?: boolean;
  allowExtension?: boolean;
  /**
   * Busy timeout in ms for `PRAGMA busy_timeout` — how long a statement waits
   * for the write lock before failing with SQLITE_BUSY. Defaults to 5000ms
   * (matching the README); pass `0` for SQLite's raw fail-fast behaviour.
   */
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
  /**
   * Base columns shared by every model defined on this connection. They are
   * merged into each `define()` call's columns before the schema is validated
   * and its DDL is generated, so a table never has to repeat them. A column
   * with the same name declared directly on a schema overrides the base
   * definition for that schema.
   *
   * ```ts
   * const db = new Sqlo({
   *   path: ':memory:',
   *   baseColumns: {
   *     id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
   *     created_at: { type: 'TEXT', notNull: true, default: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` },
   *   },
   * });
   * const users = db.define({ name: 'users', columns: { name: { type: 'TEXT' } } });
   * // users has id, created_at, name
   * ```
   */
  baseColumns?: B;
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
export class Sqlo<const B extends BaseColumns = {}> implements Executor {
  readonly #db: DatabaseSyncType;
  readonly #options: Required<Omit<SqloOptions<B>, 'onLog' | 'baseColumns'>> & { onLog?: (entry: LogEntry) => void };
  readonly #baseColumns: B;
  /**
   * Every model defined on this connection, in definition order. A list (not a
   * name→model map) so that re-defining a table — e.g. after `close()` +
   * `open()` — never silently drops an earlier definition from syncAll().
   * The generated DDL is `IF NOT EXISTS`, so repeats are harmless.
   */
  #models: Array<{ sync(): void }> = [];
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
  constructor(options: SqloOptions<B> | string = {}) {
    const opts: SqloOptions<B> = typeof options === 'string' ? { path: options } : { ...options };
    const path = opts.path ?? ':memory:';

    if (opts.journalMode !== undefined && !JOURNAL_MODES.has(opts.journalMode)) {
      throw new Error(
        `Invalid journalMode: "${String(opts.journalMode)}". ` +
        `Expected one of: ${[...JOURNAL_MODES].join(', ')}.`,
      );
    }

    this.#options = {
      path,
      open: opts.open ?? true,
      readBigInts: opts.readBigInts ?? false,
      enableForeignKeyConstraints: opts.enableForeignKeyConstraints ?? true,
      enableDoubleQuotedStringLiterals: opts.enableDoubleQuotedStringLiterals ?? false,
      allowExtension: opts.allowExtension ?? false,
      // 5000ms — the README-documented default and the production-sane choice:
      // SQLite's own default is 0, which makes any concurrent writer fail
      // with SQLITE_BUSY instantly. Callers who want the raw fail-fast
      // behaviour can pass `busyTimeout: 0` explicitly.
      busyTimeout: opts.busyTimeout ?? 5000,
      journalMode: opts.journalMode ?? 'DELETE',
      logLevel: opts.logLevel ?? 'warn',
      ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
    };
    this.#baseColumns = opts.baseColumns ?? ({} as B);

    this.#db = new DatabaseSync(path, {
      open: this.#options.open,
      readBigInts: this.#options.readBigInts,
      enableForeignKeyConstraints: this.#options.enableForeignKeyConstraints,
      enableDoubleQuotedStringLiterals: this.#options.enableDoubleQuotedStringLiterals,
      allowExtension: this.#options.allowExtension,
    });

    if (this.#options.open) {
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
      if (table.includes('.')) {
        throw new Error(
          `Invalid table name "${name}": expected "table" or "schema.table".`,
        );
      }
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
    const rows = plainRows(stmt.all(...toBindables(params) as SQLInputValue[]) as T[]);
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
    const row = plainRow(stmt.get(...toBindables(params) as SQLInputValue[]) as T | undefined);
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
    const result = stmt.run(...toBindables(params) as SQLInputValue[]);
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
        const rows = plainRows(stmt.all(...toBindables(params) as SQLInputValue[]) as Record<string, unknown>[]);
        self.#log('query', `all: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return rows;
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        const started = performance.now();
        const row = plainRow(stmt.get(...toBindables(params) as SQLInputValue[]) as Record<string, unknown> | undefined);
        self.#log('query', `get: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return row;
      },
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
        const started = performance.now();
        const result = stmt.run(...toBindables(params) as SQLInputValue[]);
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
        // Synchronous sleep via Atomics.wait — legal on Node's main thread (only
        // browsers restrict it to workers). We must not use a bare empty spin
        // loop here: rollup tree-shakes it out of the bundle as a side-effect-
        // free statement, which silently removes the backoff from `dist`. 
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }

  #transactionOnce<T>(fn: () => T, mode: 'DEFERRED' | 'IMMEDIATE' = 'DEFERRED'): T {
    this.#ensureOpen();
    const entryDepth = this.#txDepth;
    const isTop = entryDepth === 0;
    if (isTop) {
      // BEGIN IMMEDIATE acquires the write lock up front (used by migrate()).
      this.#db.exec(mode === 'IMMEDIATE' ? 'BEGIN IMMEDIATE' : 'BEGIN');
      this.#log('transaction', mode === 'IMMEDIATE' ? 'BEGIN IMMEDIATE transaction' : 'BEGIN transaction');
    } else {
      this.#db.exec(`SAVEPOINT "sqlo_sp_${entryDepth}"`);
      this.#log('transaction', `BEGIN SAVEPOINT (depth ${entryDepth})`);
    }
    this.#txDepth = entryDepth + 1;

    let result: T;
    try {
      result = fn();
      // Guard the classic misuse: an async callback resolves AFTER this method
      // has returned, so awaiting inside it would silently run outside the
      // (already committed) transaction. Fail loudly instead.
      if (
        result !== null && typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new TypeError(
          'Sqlo.transaction() received an async callback (returned a Promise). ' +
          'The synchronous API cannot keep a transaction open across awaits — ' +
          'use AsyncSqlo.transaction() instead.',
        );
      }
    } catch (err) {
      try {
        if (isTop) {
          this.#db.exec('ROLLBACK');
          this.#log('transaction', 'ROLLBACK transaction', { level: 'warn' });
        } else {
          this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${entryDepth}"`);
          this.#log('transaction', `ROLLBACK TO SAVEPOINT (depth ${entryDepth})`, { level: 'warn' });
        }
      } catch {
        // The rollback itself failed (e.g. the failing statement already
        // aborted the transaction). Never let that mask the original error.
      } finally {
        // Always restore the depth exactly once, whatever the rollback did.
        this.#txDepth = entryDepth;
      }
      throw err;
    }

    // fn succeeded — finish the transaction. If COMMIT/RELEASE itself fails
    // (SQLITE_BUSY, deferred FK, disk full, ...) SQLite leaves the transaction
    // open; roll it back and restore the depth so the connection is never left
    // inside an orphaned transaction that would silently swallow later writes.
    try {
      if (isTop) {
        this.#db.exec('COMMIT');
        this.#log('transaction', 'COMMIT transaction');
      } else {
        this.#db.exec(`RELEASE SAVEPOINT "sqlo_sp_${entryDepth}"`);
        this.#log('transaction', `RELEASE SAVEPOINT (depth ${entryDepth})`);
      }
    } catch (err) {
      try {
        if (isTop) {
          this.#db.exec('ROLLBACK');
          this.#log('transaction', 'ROLLBACK transaction after failed COMMIT', { level: 'warn' });
        } else {
          this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${entryDepth}"`);
          this.#log('transaction', `ROLLBACK TO SAVEPOINT (depth ${entryDepth}) after failed RELEASE`, { level: 'warn' });
        }
      } catch {
        // Best effort — the original COMMIT/RELEASE error is what matters.
      }
      this.#txDepth = entryDepth;
      throw err;
    }

    this.#txDepth = entryDepth;
    return result;
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
    // The schema name cannot be a bound parameter — validate it. `quoteIdent`
    // rejects invalid identifiers; we additionally reject dotted names because
    // ATTACH AS expects a single, dot-free database name.
    if (name.includes('.')) {
      throw new Error(
        `Invalid database name: "${name}". ATTACH requires a plain name without dots.`,
      );
    }
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
  ): Model<
    RowOf<WithBaseColumns<S, B>>,
    InsertOf<WithBaseColumns<S, B>>,
    PatchOf<WithBaseColumns<S, B>>
  > {
    this.#ensureOpen();
    // Merge the connection-wide base columns into this schema (schema's own
    // columns win on name collisions) before validation and DDL generation.
    const merged = this.#withBaseColumns(schema);
    // Validate the schema
    const { errors, warnings } = validateSchema(merged);
    if (errors.length > 0) {
      throw new Error(
        `Invalid schema for table "${merged.name}":\n  ${errors.join('\n  ')}`,
      );
    }
    for (const warning of warnings) {
      process.emitWarning(warning, { code: 'SQLO_SCHEMA_WARNING' });
    }

    // Foreign keys: warn when the schema declares references but the
    // connection has foreign-key enforcement disabled — the declared
    // ON DELETE / ON UPDATE actions would silently not fire.
    if (!this.#options.enableForeignKeyConstraints && schemaHasReferences(merged)) {
      process.emitWarning(
        `Table "${merged.name}" declares foreign key references but the connection has ` +
        'foreign key enforcement disabled (enableForeignKeyConstraints: false). ' +
        'ON DELETE / ON UPDATE actions will NOT fire. Enable the option to enforce them.',
        { code: 'SQLO_FOREIGN_KEYS_DISABLED' },
      );
    }

    const model = new Model<
      RowOf<WithBaseColumns<S, B>>,
      InsertOf<WithBaseColumns<S, B>>,
      PatchOf<WithBaseColumns<S, B>>
    >(this, merged);
    this.#models.push(model);
    this.#log('schema', `define model for "${merged.name}"`, {
      detail: `${Object.keys(merged.columns).length} columns, ${merged.indexes?.length ?? 0} indexes`,
    });
    return model;
  }

  #withBaseColumns<S extends TableDef>(schema: S): TableDef {
    const base = this.#baseColumns;
    if (Object.keys(base).length === 0) return schema;
    return { ...schema, columns: { ...base, ...schema.columns } };
  }

  /**
   * Create all defined tables and indexes.
   */
  syncAll(): void {
    this.#ensureOpen();
    for (const model of this.#models) {
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
    const pending = computePending(migrations, applied);

    const freshlyApplied: MigrationDef[] = [];
    for (const m of pending) {
      // Each migration gets its own transaction (or a SAVEPOINT inside an
      // outer one). BEGIN IMMEDIATE makes two processes racing to migrate the
      // same database serialize on the write lock; re-checking inside the
      // transaction closes the window where the other process committed while
      // we were waiting for the lock.
      let alreadyApplied = false;
      try {
        this.#transactionOnce(() => {
          if (this.#getAppliedMigrations(schema).has(m.name)) {
            alreadyApplied = true;
            return;
          }
          this.#applyMigration(m, schema);
        }, 'IMMEDIATE');
      } catch (err) {
        this.#log('migrate', `migration "${m.name}" failed`, { detail: `schema "${schema}"`, level: 'error' });
        const scope = this.#txDepth === 0 ? 'transaction rolled back' : 'rolled back to savepoint';
        throw new Error(
          `Migration "${m.name}" failed (${scope}).`,
          { cause: err },
        );
      }

      if (alreadyApplied) {
        this.#log('migrate', `migration "${m.name}" already applied by another process`, {
          detail: `schema "${schema}"`,
          level: 'warn',
        });
      } else {
        freshlyApplied.push(m);
        this.#log('migrate', `applied migration "${m.name}"`, { detail: `schema "${schema}"` });
      }
    }

    if (freshlyApplied.length > 0) {
      this.#log('migrate', `applied ${freshlyApplied.length} migration(s)`, { detail: `schema "${schema}"` });
    } else {
      this.#log('migrate', 'no pending migrations', { detail: `schema "${schema}"` });
    }

    return freshlyApplied;
  }

  /**
   * List all migrations with their applied status.
   * Pass `{ schema }` to inspect an attached database's migration history.
   */
  migrationStatus(migrations: MigrationDef[], options?: MigrateOptions): MigrationStatus[] {
    this.#ensureOpen();
    const schema = options?.schema ?? 'main';
    // Read-only: do NOT create the version table here — a status query must
    // not mutate the database.
    const applied = this.#migrationTableExists(schema)
      ? this.#getAppliedMigrations(schema)
      : new Map<string, string>();

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

  /**
   * Open the database connection.
   *
   * Required after constructing with `{ open: false }`; also reopens a
   * connection closed via `close()` (node:sqlite reopens at the path given to
   * the constructor — file contents persist, `:memory:` contents do not).
   * Idempotent: calling it on an already-open connection is a no-op.
   */
  open(): void {
    if (!this.#db.isOpen) {
      this.#db.open();
      // Re-apply connection PRAGMAs — the constructor skips them when opened
      // with `open: false` (node:sqlite rejects exec on a closed connection).
      if (this.#options.busyTimeout > 0) {
        this.#db.exec(`PRAGMA busy_timeout = ${this.#options.busyTimeout}`);
      }
      if (this.#options.journalMode !== 'DELETE') {
        this.#db.exec(`PRAGMA journal_mode = ${this.#options.journalMode}`);
      }
      this.#log('connection', `open database ${this.#options.path === ':memory:' ? '(in-memory)' : this.#options.path}`);
    }
    this.#closed = false;
  }

  // ---- Internal ----

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error('Database is closed.');
    }
    if (!this.#db.isOpen) {
      // The raw connection may have been closed out-of-band via `raw()`;
      // surface a clear error instead of letting node:sqlite throw opaque
      // "database is not open" errors from an unexpected layer.
      throw new Error('Database connection is not open.');
    }
  }

  #ensureMigrationTable(schema: string): void {
    this.#db.exec(ensureMigrationTableSql(schema));
  }

  #migrationTableExists(schema: string): boolean {
    const row = this.#db.prepare(migrationTableExistsSql(schema)).get() as { ok: number } | undefined;
    return row !== undefined;
  }

  #getAppliedMigrations(schema: string): Map<string, string> {
    const rows = this.#db.prepare(getAppliedMigrationsSql(schema)).all() as { name: string; applied_at: string }[];
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
      const result = m.up({ exec: (sql: string) => this.#db.exec(sql) }) as unknown;
      if (
        result !== null && typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        // Swallow the async rejection we are about to orphan; the clear
        // synchronous error below is what the caller must see. Recording the
        // migration as applied (the old behaviour) would be a silent lie.
        void (result as Promise<unknown>).catch(() => {});
        throw new TypeError(
          `Migration "${m.name}" returned a Promise from an async up(). ` +
          'The synchronous Sqlo.migrate() cannot await it — use a synchronous up() or AsyncSqlo.migrate().',
        );
      }
    }

    this.#db.prepare(insertMigrationRecordSql(schema)).run(m.name, ts);
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
