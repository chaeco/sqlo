/**
 * Migration utilities — file loader and runner helpers.
 *
 * Core migration logic lives in `Sqlo.migrate()` and `Sqlo.migrationStatus()`.
 * This module provides the file‑based loader.
 */
import type { MigrationDef } from '../schema/types.js';
/**
 * Synchronously load migrations from a directory.
 *
 * - `.sql` files: treated as up‑only migrations (the entire file content is the SQL).
 * - `.mjs` / `.js` / `.cjs` files: must default‑export a `MigrationDef` or an array of `MigrationDef`.
 *
 * Files are sorted alphabetically by name.
 */
export declare function loadMigrationsSync(dir: string): MigrationDef[];
/**
 * Asynchronously load migrations from a directory using `import()`.
 *
 * Handles `.sql`, `.mjs`, `.js`, and `.cjs` files.
 */
export declare function loadMigrations(dir: string): Promise<MigrationDef[]>;
//# sourceMappingURL=migration.d.ts.map