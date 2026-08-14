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

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Worker message types
// ---------------------------------------------------------------------------

interface WorkerRequest {
  id: number;
  op: 'exec' | 'all' | 'get' | 'run' | 'close';
  sql: string;
  params: unknown[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: { message: string; stack?: string; name?: string };
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
 */
export class AsyncSqlo {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;

  /**
   * @param path Database file path (or `':memory:'`) opened inside the worker.
   * @param options Options forwarded to the worker's `DatabaseSync` constructor.
   */
  constructor(path: string, options?: Record<string, unknown>) {
    const workerPath = resolve(__dirname, 'async-worker.js');
    this.#worker = new Worker(workerPath, {
      workerData: { path, options },
    });

    this.#worker.on('message', (msg: WorkerResponse) => {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);

      if (msg.ok) {
        pending.resolve(msg.data);
      } else {
        const err = new Error(msg.error?.message ?? 'Unknown worker error');
        err.name = msg.error?.name ?? 'Error';
        if (msg.error?.stack) err.stack = msg.error.stack;
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

  // ---- Methods ----

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
    return this.#send('exec', sql);
  }

  /**
   * Execute and return all rows.
   */
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return this.#send<T[]>('all', sql, params);
  }

  /**
   * Execute and return the first row, or undefined.
   */
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return this.#send<T | undefined>('get', sql, params);
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
    return this.#send('run', sql, params);
  }

  /**
   * Close the worker and its database connection.
   */
  close(): Promise<void> {
    return this.#send('close', '');
  }

  /**
   * Terminate the worker immediately (without graceful shutdown).
   */
  terminate(): void {
    this.#worker.terminate();
  }
}