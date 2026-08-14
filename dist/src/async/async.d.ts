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
export declare class AsyncSqlo {
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
//# sourceMappingURL=async.d.ts.map