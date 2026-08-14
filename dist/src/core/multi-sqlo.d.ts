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
import { Sqlo, type SqloOptions } from './sqlo.js';
import type { MigrationDef } from '../schema/types.js';
export interface MultiSqloOptions {
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
export declare class MultiSqlo {
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
//# sourceMappingURL=multi-sqlo.d.ts.map