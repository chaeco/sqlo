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

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Sqlo, type SqloOptions } from './sqlo';
import type { MigrationDef, BaseColumns } from '../schema/types';

const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface MultiSqloOptions<B extends BaseColumns = BaseColumns> {
  /** Directory that holds one database file per user. */
  dir: string;
  /**
   * Baseline migrations applied to a user's database whenever it has
   * unapplied migrations — including a database file a previous crash left
   * behind before migration finished. Already-applied migrations are skipped
   * via the version table, so this is a no-op for up-to-date databases.
   */
  migrations?: MigrationDef[];
  /**
   * Connection options forwarded to each user's `Sqlo` instance
   * (e.g. `enableForeignKeyConstraints`, `baseColumns`).
   */
  options?: SqloOptions<B>;
  /**
   * Map a userId to a database file name (without extension). Defaults to
   * `${userId}.db`. Must not introduce path separators.
   */
  fileName?: (userId: string) => string;
  /**
   * Maximum number of simultaneously open per-user connections. When the cap
   * is reached, the **least-recently-used** connection is closed and evicted
   * before a new one is opened. Defaults to `100`; pass `Infinity` to
   * disable eviction (the behaviour before this option existed).
   *
   * Evicted connections are really closed: a reference you still hold will
   * throw `database is not open` on its next use. Call `for(userId)` again
   * to reopen.
   */
  maxOpen?: number;
}

/**
 * Per-user database manager for multi-tenant applications.
 *
 * Each user (tenant) gets their own independent SQLite database file and a
 * dedicated Sqlo connection, so data is fully isolated across users. New
 * databases are created and baseline-migrated automatically on first access.
 */
export class MultiSqlo<const B extends BaseColumns = {}> {
  readonly #dir: string;
  readonly #migrations: MigrationDef[];
  readonly #options: SqloOptions<B> | undefined;
  readonly #fileName: (userId: string) => string;
  readonly #maxOpen: number;
  /** Map iteration order is LRU order: oldest first, most-recent last. */
  readonly #instances = new Map<string, Sqlo<B>>();

  /**
   * @param opts Directory to store per-user databases, baseline migrations,
   *   connection options, and an optional file-name strategy.
   */
  constructor(opts: MultiSqloOptions<B>) {
    this.#dir = resolve(opts.dir);
    this.#migrations = opts.migrations ?? [];
    this.#options = opts.options;
    this.#fileName = opts.fileName ?? ((userId) => `${userId}.db`);

    const maxOpen = opts.maxOpen ?? 100;
    if (maxOpen !== Infinity && (!Number.isInteger(maxOpen) || maxOpen < 1)) {
      throw new Error(
        `Invalid maxOpen: ${String(opts.maxOpen)}. Expected a positive integer or Infinity.`,
      );
    }
    this.#maxOpen = maxOpen;

    mkdirSync(this.#dir, { recursive: true });
  }

  /**
   * Get the Sqlo instance for a user, creating and migrating their database
   * on first access. The instance is cached and reused across calls.
   *
   * @throws if `userId` is not a safe file name component.
   */
  for(userId: string): Sqlo<B> {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(
        `Invalid userId: "${userId}". ` +
        'Must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ to be used as a file name.',
      );
    }

    const cached = this.#instances.get(userId);
    if (cached) {
      // LRU touch: re-insert so this user becomes the most-recently used.
      this.#instances.delete(userId);
      this.#instances.set(userId, cached);
      return cached;
    }

    const fileName = this.#fileName(userId);
    if (
      typeof fileName !== 'string' ||
      fileName.length === 0 ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      // ':' blocks Windows drive-relative paths (e.g. "C:evil") that
      // path.join() would otherwise resolve outside the pool directory.
      fileName.includes(':') ||
      fileName.includes('\0') ||
      fileName === '..' ||
      fileName === '.'
    ) {
      throw new Error(
        `fileName() for "${userId}" must be a plain file name, got "${String(fileName)}".`,
      );
    }

    const path = join(this.#dir, fileName);

    // Bound the number of open file descriptors / per-connection memory in
    // multi-tenant deployments with many distinct users. Evict the oldest
    // (least-recently used) connection before opening a new one. Done only
    // after `fileName` is validated, so a bad file name has no side effect.
    while (this.#instances.size >= this.#maxOpen) {
      const oldest = this.#instances.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#instances.get(oldest);
      this.#instances.delete(oldest);
      evicted?.close();
    }

    const db = new Sqlo({ path, ...(this.#options ?? {}) });
    // Migrations are applied unconditionally and idempotently: the version
    // table records what is already applied, so this is a no-op for migrated
    // databases — and it heals a database file that a previous crash left
    // behind before its baseline migrations finished (the old "file is new"
    // check skipped migration in exactly that case).
    if (this.#migrations.length > 0) {
      try {
        db.migrate(this.#migrations);
      } catch (err) {
        // Bootstrap failed — never leak the just-opened connection. It was
        // not registered in the cache, so closeAll() could not close it.
        db.close();
        throw err;
      }
    }
    this.#instances.set(userId, db);
    return db;
  }

  /**
   * Whether a user's instance is currently open (cached).
   */
  has(userId: string): boolean {
    return this.#instances.has(userId);
  }

  /**
   * Close a single user's database connection.
   */
  close(userId: string): void {
    const db = this.#instances.get(userId);
    if (db) {
      db.close();
      this.#instances.delete(userId);
    }
  }

  /**
   * Close every open user database and clear the cache.
   */
  closeAll(): void {
    for (const db of this.#instances.values()) {
      db.close();
    }
    this.#instances.clear();
  }

  /**
   * Number of currently open (cached) user instances.
   */
  get size(): number {
    return this.#instances.size;
  }
}
