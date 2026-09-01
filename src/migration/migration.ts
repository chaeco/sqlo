/**
 * Migration utilities — file loader and runner helpers.
 *
 * Core migration logic lives in `Sqlo.migrate()` and `Sqlo.migrationStatus()`.
 * This module provides the file‑based loader.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { MigrationDef } from '../schema/types';
import { quoteIdent } from '../query/sql';

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Migration primitives (pure)
//
// The version-table schema and pending computation are shared between the
// synchronous `Sqlo.migrate()` / `Sqlo.migrationStatus()` and the async
// `AsyncSqlo` wrapper, which reuses the exact same SQL. Only the transaction
// wrapping differs: sync Sqlo uses its SAVEPOINT machinery directly, while
// AsyncSqlo delegates to worker txBegin/txCommit/txRollback primitives.
// ---------------------------------------------------------------------------

/**
 * The version table reference for a schema. `'main'` keeps the historical
 * bare name (`_sqlo_migrations`) so existing databases keep their migration
 * history; any other schema is an attached database and is quoted explicitly.
 */
export function migrationTableRef(schema: string): string {
  return schema === 'main'
    ? '"_sqlo_migrations"'
    : `${quoteIdent(schema)}."_sqlo_migrations"`;
}

/**
 * CREATE TABLE IF NOT EXISTS for the version table in the given schema.
 */
export function ensureMigrationTableSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${migrationTableRef(schema)} (
    "name" TEXT PRIMARY KEY NOT NULL,
    "applied_at" TEXT NOT NULL
  )`;
}

/**
 * SELECT listing applied migration names and timestamps, ordered by name.
 */
export function getAppliedMigrationsSql(schema: string): string {
  return `SELECT "name", "applied_at" FROM ${migrationTableRef(schema)} ORDER BY "name"`;
}

/**
 * INSERT recording an applied migration.
 */
export function insertMigrationRecordSql(schema: string): string {
  return `INSERT INTO ${migrationTableRef(schema)} ("name", "applied_at") VALUES (?, ?)`;
}

/**
 * The subset of `migrations` not yet present in `applied`, preserving order.
 */
export function computePending(
  migrations: MigrationDef[],
  applied: Map<string, string>,
): MigrationDef[] {
  return migrations.filter((m) => !applied.has(m.name));
}

/**
 * Synchronously load migrations from a directory.
 *
 * - `.sql` files: treated as up‑only migrations (the entire file content is the SQL).
 * - `.mjs` / `.js` / `.cjs` files: must default‑export a `MigrationDef` or an array of `MigrationDef`.
 *
 * Files are sorted alphabetically by name.
 */
export function loadMigrationsSync(dir: string): MigrationDef[] {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const migrations: MigrationDef[] = [];

  for (const entry of entries) {
    const ext = entry.split('.').pop()?.toLowerCase();
    const name = entry.replace(/\.\w+$/, '');
    const fullPath = resolve(absDir, entry);

    if (ext === 'sql') {
      const sql = readFileSync(fullPath, 'utf-8');
      migrations.push({ name, up: sql });
    } else if (ext === 'js' || ext === 'cjs' || ext === 'mjs') {
      if (ext === 'mjs') {
        throw new Error(
          `Cannot load .mjs migration synchronously: "${entry}". ` +
          'Use loadMigrations() (async) instead.',
        );
      }
      const mod = _require(fullPath) as Record<string, unknown>;
      const result = mod.default ?? mod;
      if (Array.isArray(result)) {
        migrations.push(...result as MigrationDef[]);
      } else {
        migrations.push(result as MigrationDef);
      }
    }
  }

  return migrations;
}

/**
 * Asynchronously load migrations from a directory using `import()`.
 *
 * Handles `.sql`, `.mjs`, `.js`, and `.cjs` files.
 */
export async function loadMigrations(dir: string): Promise<MigrationDef[]> {
  const absDir = resolve(dir);
  const entries = (await readdir(absDir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const migrations: MigrationDef[] = [];

  for (const entry of entries) {
    const ext = entry.split('.').pop()?.toLowerCase();
    const name = entry.replace(/\.\w+$/, '');
    const fullPath = resolve(absDir, entry);

    if (ext === 'sql') {
      const sql = await readFile(fullPath, 'utf-8');
      migrations.push({ name, up: sql });
    } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
      const absUrl = ext === 'cjs'
        ? fullPath
        : `file://${fullPath}`;
      const mod = await import(absUrl) as Record<string, unknown>;
      const result = mod.default ?? mod;
      if (Array.isArray(result)) {
        migrations.push(...result as MigrationDef[]);
      } else {
        migrations.push(result as MigrationDef);
      }
    }
  }

  return migrations;
}