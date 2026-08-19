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

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Sqlo, type SqloOptions } from './sqlo';
import type { MigrationDef } from '../schema/types';

const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
export class MultiSqlo {
  readonly #dir: string;
  readonly #migrations: MigrationDef[];
  readonly #options: SqloOptions | undefined;
  readonly #fileName: (userId: string) => string;
  readonly #instances = new Map<string, Sqlo>();

  /**
   * @param opts Directory to store per-user databases, baseline migrations,
   *   connection options, and an optional file-name strategy.
   */
  constructor(opts: MultiSqloOptions) {
    this.#dir = resolve(opts.dir);
    this.#migrations = opts.migrations ?? [];
    this.#options = opts.options;
    this.#fileName = opts.fileName ?? ((userId) => `${userId}.db`);
    mkdirSync(this.#dir, { recursive: true });
  }

  /**
   * Get the Sqlo instance for a user, creating and migrating their database
   * on first access. The instance is cached and reused across calls.
   *
   * @throws if `userId` is not a safe file name component.
   */
  for(userId: string): Sqlo {
    if (!USER_ID_RE.test(userId)) {
      throw new Error(
        `Invalid userId: "${userId}". ` +
        'Must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ to be used as a file name.',
      );
    }

    const cached = this.#instances.get(userId);
    if (cached) return cached;

    const fileName = this.#fileName(userId);
    if (fileName.includes('/') || fileName.includes('\\') || fileName === '..' || fileName === '.') {
      throw new Error(
        `fileName() for "${userId}" must be a plain file name, got "${fileName}".`,
      );
    }

    const path = join(this.#dir, fileName);
    const isNew = !existsSync(path);

    const db = new Sqlo({ path, ...(this.#options ?? {}) });
    if (isNew && this.#migrations.length > 0) {
      db.migrate(this.#migrations);
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
