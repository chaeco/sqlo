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
    #worker;
    #pending = new Map();
    #nextId = 1;
    /**
     * @param path Database file path (or `':memory:'`) opened inside the worker.
     * @param options Options forwarded to the worker's `DatabaseSync` constructor.
     */
    constructor(path, options) {
        const workerPath = resolve(__dirname, 'async-worker.js');
        this.#worker = new Worker(workerPath, {
            workerData: { path, options },
        });
        this.#worker.on('message', (msg) => {
            const pending = this.#pending.get(msg.id);
            if (!pending)
                return;
            this.#pending.delete(msg.id);
            if (msg.ok) {
                pending.resolve(msg.data);
            }
            else {
                const err = new Error(msg.error?.message ?? 'Unknown worker error');
                err.name = msg.error?.name ?? 'Error';
                if (msg.error?.stack)
                    err.stack = msg.error.stack;
                pending.reject(err);
            }
        });
        this.#worker.on('error', (err) => {
            // Reject all pending
            for (const [, p] of this.#pending) {
                p.reject(err);
            }
            this.#pending.clear();
        });
        this.#worker.on('exit', (code) => {
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
    #send(op, sql, params = []) {
        return new Promise((resolve, reject) => {
            const id = this.#nextId++;
            this.#pending.set(id, { resolve: resolve, reject });
            this.#worker.postMessage({ id, op, sql, params });
        });
    }
    /**
     * Execute a SQL string (no return value).
     */
    exec(sql) {
        return this.#send('exec', sql);
    }
    /**
     * Execute and return all rows.
     */
    all(sql, ...params) {
        return this.#send('all', sql, params);
    }
    /**
     * Execute and return the first row, or undefined.
     */
    get(sql, ...params) {
        return this.#send('get', sql, params);
    }
    /**
     * Execute and return { changes, lastInsertRowid }.
     *
     * `changes` / `lastInsertRowid` may be `bigint` when the worker returns
     * large integers — coerce with `Number()` if you need a plain number.
     */
    run(sql, ...params) {
        return this.#send('run', sql, params);
    }
    /**
     * Close the worker and its database connection.
     */
    close() {
        return this.#send('close', '');
    }
    /**
     * Terminate the worker immediately (without graceful shutdown).
     */
    terminate() {
        this.#worker.terminate();
    }
}
//# sourceMappingURL=async.js.map