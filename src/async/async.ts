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
 *
 * Architecture — "brain on the main thread, hands in the worker":
 * The main thread owns all types and query construction (pure functions,
 * zero blocking); the worker is a remote connection that only executes
 * final SQL. `define` / models / the query builder live on the main thread
 * and mirror the sync API exactly; every terminal call is a single RPC.
 * Only execution crosses the worker boundary, so the sync and async layers
 * share one place that knows how a query is built.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { AsyncExecutor, AsyncTransaction } from './async-model';
import { AsyncModel } from './async-model';
import type { TableDef, RowOf, InsertOf, PatchOf, MigrationDef, MigrationStatus } from '../schema/types';
import { validateSchema, schemaHasReferences } from '../schema/validate';
import {
  ensureMigrationTableSql,
  getAppliedMigrationsSql,
  insertMigrationRecordSql,
  computePending,
} from '../migration/migration';
import type { MigrateOptions } from '../core/sqlo';
import { isBusyError } from '../core/error';
import type { SqliteErrorLike } from '../core/error';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Worker message types
// ---------------------------------------------------------------------------

interface WorkerRequest {
  id: number;
  op:
    | 'exec'
    | 'all'
    | 'get'
    | 'run'
    | 'close'
    | 'txBegin'
    | 'txCommit'
    | 'txRollback'
    | 'backup';
  sql: string;
  params: unknown[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: {
    message: string;
    stack?: string;
    name?: string;
    errcode: number | undefined;
    errstr: string | undefined;
  };
}

// ---------------------------------------------------------------------------
// AsyncSqlo
// ---------------------------------------------------------------------------

/**
 * Async wrapper around Sqlo that delegates database operations to a worker
 * thread, avoiding event-loop blocking in request-handling contexts.
 *
 * **Honest disclaimer:** SQLite underneath is still synchronous and
 * single-writer. `AsyncSqlo` only avoids event-loop blocking — it does not
 * make SQLite concurrent, and multi-process writes still surface as lock
 * timeout errors.
 *
 * Mirrors the synchronous `Sqlo` API for schema (`define` / `syncAll`),
 * models (`AsyncModel`), transactions, and migrations. Query construction
 * stays on the main thread; only execution crosses to the worker.
 */
export class AsyncSqlo implements AsyncExecutor {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #models = new Map<string, { sync(): Promise<void> }>();
  #nextId = 1;
  /**
   * Tail of the FIFO dispatch lane. Every operation (exec/all/get/run,
   * backup, close) and every transaction is enqueued onto this chain, so a
   * transaction is an indivisible block — BEGIN → fn(tx) → COMMIT cannot be
   * interleaved with any other operation. This restores the guarantee the
   * sync `Sqlo` gets for free (the blocked event loop makes concurrent
   * interleaving impossible) and prevents two concurrent `transaction()`
   * calls from being merged into one physical transaction.
   */
  #tail: Promise<void> = Promise.resolve();
  readonly #fkEnabled: boolean;

  /**
   * @param path Database file path (or `':memory:'`) opened inside the worker.
   * @param options Options forwarded to the worker's `DatabaseSync`
   *   constructor. Foreign-key enforcement defaults to `true` (matching the
   *   synchronous `Sqlo`), so `define()` can warn when it is disabled while
   *   the schema declares references.
   */
  constructor(path: string, options?: Record<string, unknown>) {
    // Align the foreign-key default with the sync Sqlo (#60): enforcement is
    // ON by default. Pass the resolved flag to the worker's DatabaseSync and
    // remember it here for the define() warning.
    const fkEnabled = options?.enableForeignKeyConstraints !== false;
    this.#fkEnabled = fkEnabled;
    const workerOptions = { ...options, enableForeignKeyConstraints: fkEnabled };

    const workerPath = resolve(__dirname, 'async-worker.js');
    this.#worker = new Worker(workerPath, {
      workerData: { path, options: workerOptions },
    });

    this.#worker.on('message', (msg: WorkerResponse) => {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);

      if (msg.ok) {
        pending.resolve(msg.data);
      } else {
        // Rebuild the SQLite error carrying errcode/errstr so the main thread
        // can classify it with isBusyError / isConstraintError — postMessage
        // would otherwise strip the extended result codes.
        const err = new Error(msg.error?.message ?? 'Unknown worker error') as Error & SqliteErrorLike;
        err.name = msg.error?.name ?? 'Error';
        if (msg.error?.stack) err.stack = msg.error.stack;
        if (typeof msg.error?.errcode === 'number') err.errcode = msg.error.errcode;
        if (typeof msg.error?.errstr === 'string') err.errstr = msg.error.errstr;
        pending.reject(err);
      }
    });

    this.#worker.on('error', (err: Error) => {
      // Reject all pending
      for (const [, p] of this.#pending) {
        p.reject(err);
      }
      this.#pending.clear();
    });

    this.#worker.on('exit', (code: number) => {
      if (code !== 0) {
        const err = new Error(`Worker exited with code ${code}`);
        for (const [, p] of this.#pending) {
          p.reject(err);
        }
        this.#pending.clear();
      }
    });
  }

  // ---- Dispatch lane ----

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task);
    // Keep the chain alive even when a task rejects.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #send<T>(op: WorkerRequest['op'], sql: string, params: unknown[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#worker.postMessage({ id, op, sql, params });
    });
  }

  /**
   * Execute a SQL string (no return value).
   */
  exec(sql: string): Promise<void> {
    return this.#enqueue(() => this.#send('exec', sql));
  }

  /**
   * Execute and return all rows.
   */
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return this.#enqueue(() => this.#send<T[]>('all', sql, params));
  }

  /**
   * Execute and return the first row, or undefined.
   */
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return this.#enqueue(() => this.#send<T | undefined>('get', sql, params));
  }

  /**
   * Execute and return { changes, lastInsertRowid }.
   *
   * `changes` / `lastInsertRowid` may be `bigint` when the worker returns
   * large integers — coerce with `Number()` if you need a plain number.
   */
  run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number | bigint; lastInsertRowid: number | bigint }> {
    return this.#enqueue(() => this.#send('run', sql, params));
  }

  // ---- Schema & Model ----

  /**
   * Define a model for a table — the async mirror of `Sqlo#define`.
   *
   * ```ts
   * const users = await db.define({
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
  define<const S extends TableDef>(schema: S): AsyncModel<RowOf<S>, InsertOf<S>, PatchOf<S>> {
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
    if (!this.#fkEnabled && schemaHasReferences(schema)) {
      process.emitWarning(
        `Table "${schema.name}" declares foreign key references but the connection has ` +
        'foreign key enforcement disabled (enableForeignKeyConstraints: false). ' +
        'ON DELETE / ON UPDATE actions will NOT fire. Enable the option to enforce them.',
        { code: 'SQLO_FOREIGN_KEYS_DISABLED' },
      );
    }

    const model = new AsyncModel<RowOf<S>, InsertOf<S>, PatchOf<S>>(this, schema);
    this.#models.set(schema.name, model);
    return model;
  }

  /**
   * Create all defined tables and indexes.
   */
  async syncAll(): Promise<void> {
    for (const model of this.#models.values()) {
      await model.sync();
    }
  }

  // ---- Transaction ----

  /**
   * Run a function inside a transaction — the async mirror of
   * `Sqlo#transaction`. The callback receives an explicit transaction handle
   * (`tx`); every operation performed through it runs inside the transaction
   * and cannot be interleaved with other operations.
   *
   * ```ts
   * await db.transaction(async (tx) => {
   *   const u = tx.model(users); // type-safe copy bound to the transaction
   *   await u.update({ balance: 0 }, { id });
   *   await tx.run('UPDATE ledger SET amount = ? WHERE id = ?', 100, 1);
   * });
   * ```
   *
   * Nested transactions are available on the handle:
   * `tx.transaction(async (inner) => { ... })` — they use SAVEPOINT / RELEASE
   * in the worker and share the outer transaction's fate.
   *
   * Production concurrency: SQLite is single-writer, so concurrent writers can
   * hit `SQLITE_BUSY`. Pass `{ retry: n }` to automatically re-run the whole
   * transaction (from a fresh `BEGIN`) with exponential backoff when the
   * database is locked. The backoff uses a real `setTimeout` sleep (unlike the
   * sync API's busy-wait). Other errors propagate immediately. Retries only
   * apply to top-level transactions — a nested (SAVEPOINT) transaction belongs
   * to an outer one and is never retried.
   */
  async transaction<T>(
    fn: (tx: AsyncTransaction) => Promise<T>,
    options?: { retry?: number },
  ): Promise<T> {
    let attempt = 0;
    const maxRetries = options?.retry ?? 0;
    for (;;) {
      try {
        // Enqueue the whole transaction as one indivisible block so it can
        // never be interleaved with concurrent operations or transactions.
        return await this.#enqueue(() => this.#transactionOnce(fn));
      } catch (err) {
        if (!isBusyError(err) || attempt >= maxRetries) throw err;
        attempt++;
        // Exponential backoff: 50ms, 100ms, 200ms, ... as a real sleep.
        // While sleeping, the dispatch lane is free for other requests.
        const delay = 50 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async #transactionOnce<T>(fn: (tx: AsyncTransaction) => Promise<T>): Promise<T> {
    await this.#send('txBegin', '');
    const tx = this.#makeTransaction();

    try {
      const result = await fn(tx);
      await this.#send('txCommit', '');
      return result;
    } catch (err) {
      await this.#send('txRollback', '');
      throw err;
    }
  }

  /**
   * Build the explicit transaction handle. Operations on the handle dispatch
   * directly to the worker (bypassing the FIFO lane) because the enclosing
   * transaction already holds the lane — the worker processes them serially
   * and inside the open transaction. Nested `tx.transaction(...)` recurse
   * into `#transactionOnce`, which the worker turns into a SAVEPOINT.
   */
  #makeTransaction(): AsyncTransaction {
    const owner = this;
    const tx: AsyncTransaction = {
      exec: (sql: string) => owner.#send('exec', sql),
      all: <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        ...params: unknown[]
      ) => owner.#send<T[]>('all', sql, params),
      get: <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        ...params: unknown[]
      ) => owner.#send<T | undefined>('get', sql, params),
      run: (sql: string, ...params: unknown[]) => owner.#send('run', sql, params),
      transaction: <T>(fn: (inner: AsyncTransaction) => Promise<T>) => owner.#transactionOnce(fn),
      model: <Row extends Record<string, unknown>, Insert, Patch>(
        m: AsyncModel<Row, Insert, Patch>,
      ) => m.withExecutor(tx),
    };
    return tx;
  }

  // ---- Migration ----

  /**
   * Run pending migrations — the async mirror of `Sqlo#migrate`. Returns the
   * list of newly applied migrations.
   *
   * Reuses the same pure migration SQL as the sync layer (version table,
   * applied lookup, pending computation). Each migration runs in its own
   * transaction through the worker's transaction primitives, so already
   * applied migrations survive a later failure.
   *
   * Pass `{ schema: 'aux' }` to manage the migrations of an attached
   * database — the version table is created inside that schema.
   */
  async migrate(migrations: MigrationDef[], options?: MigrateOptions): Promise<MigrationDef[]> {
    const schema = options?.schema ?? 'main';
    await this.exec(ensureMigrationTableSql(schema));

    const rows = await this.all<{ name: string; applied_at: string }>(getAppliedMigrationsSql(schema));
    const applied = new Map<string, string>();
    for (const row of rows) applied.set(row.name, row.applied_at);
    const pending = computePending(migrations, applied);

    for (const m of pending) {
      try {
        await this.transaction(async (tx) => {
          await this.#applyMigration(tx, m, schema);
        });
      } catch (err) {
        throw new Error(
          `Migration "${m.name}" failed. DB has been rolled back.`,
          { cause: err },
        );
      }
    }

    return pending;
  }

  async #applyMigration(tx: AsyncTransaction, m: MigrationDef, schema: string): Promise<void> {
    const ts = new Date().toISOString();

    if (typeof m.up === 'string') {
      await tx.exec(m.up);
    } else {
      await m.up({ exec: async (sql: string) => { await tx.exec(sql); } });
    }

    await tx.run(insertMigrationRecordSql(schema), m.name, ts);
  }

  /**
   * List all migrations with their applied status — the async mirror of
   * `Sqlo#migrationStatus`. Pass `{ schema }` to inspect an attached
   * database's migration history.
   */
  async migrationStatus(
    migrations: MigrationDef[],
    options?: MigrateOptions,
  ): Promise<MigrationStatus[]> {
    const schema = options?.schema ?? 'main';
    await this.exec(ensureMigrationTableSql(schema));

    const rows = await this.all<{ name: string; applied_at: string }>(getAppliedMigrationsSql(schema));
    const applied = new Map<string, string>();
    for (const row of rows) applied.set(row.name, row.applied_at);

    return migrations.map((m) => ({
      name: m.name,
      appliedAt: applied.get(m.name) ?? null,
    }));
  }

  // ---- Backup ----

  /**
   * Create an online backup of the database to another file — the async
   * mirror of `Sqlo#backup`. Uses SQLite's `VACUUM INTO`, which takes a
   * consistent snapshot even while the database is in use.
   *
   * @param target File path of the backup to create.
   */
  backup(target: string): Promise<void> {
    return this.#enqueue(() => this.#send('backup', target));
  }

  // ---- Close ----

  /**
   * Close the worker and its database connection. Waits for all queued
   * operations (including any running transaction) to finish first.
   */
  close(): Promise<void> {
    return this.#enqueue(() => this.#send('close', ''));
  }

  /**
   * Terminate the worker immediately (without graceful shutdown).
   */
  terminate(): void {
    this.#worker.terminate();
  }
}
