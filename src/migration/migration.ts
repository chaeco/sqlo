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

const _require = createRequire(import.meta.url);

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