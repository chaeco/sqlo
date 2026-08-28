/**
 * Load table definitions from JSON.
 *
 * Table schemas are plain data, so they can live in `.json` files and be
 * loaded at runtime — useful for configuration-driven or multi-tenancy
 * setups. The loaded definition goes through the same `db.define()` schema
 * validation as object literals.
 *
 * Note: CHECK/WHERE constraints must be plain SQL strings in JSON (a JSON
 * file cannot express a bound-parameter fragment). This matches the
 * `SqlFragment | string` acceptance in `TableDef`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TableDef } from './types';
import { validateSchema } from './validate';

/**
 * Synchronously load a table definition from a JSON file.
 *
 * ```json
 * {
 *   "name": "users",
 *   "columns": {
 *     "id":   { "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
 *     "name": { "type": "TEXT", "notNull": true },
 *     "age":  { "type": "INTEGER", "check": "age >= 0" }
 *   },
 *   "indexes": [
 *     { "name": "idx_users_name", "columns": ["name"] }
 *   ]
 * }
 * ```
 */
export function loadTableDefSync(jsonPath: string): TableDef {
  const absPath = resolve(jsonPath);
  const text = readFileSync(absPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse table definition JSON "${jsonPath}": ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Table definition JSON "${jsonPath}" must contain a single object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`,
    );
  }
  const def = parsed as TableDef;
  const { errors } = validateSchema(def);
  if (errors.length > 0) {
    throw new Error(
      `Invalid table definition "${jsonPath}":\n  ${errors.join('\n  ')}`,
    );
  }
  return def;
}
