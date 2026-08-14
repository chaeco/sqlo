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
import type { TableDef } from './types.js';
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
export declare function loadTableDefSync(jsonPath: string): TableDef;
//# sourceMappingURL=json.d.ts.map