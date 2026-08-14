/**
 * Schema introspection — read the *actual* table structure from the
 * database and turn it into a TableDef that can be diffed against the
 * schema in your code.
 *
 * Real-world workflow: your database file already exists (created by an
 * older version), your code holds the latest schema. Introspect the live
 * table, then `schemaDiff(actual, desired)` to see exactly which columns /
 * indexes are missing and generate a migration.
 */
import type { Executor } from '../query/query-builder.js';
import type { TableDef } from './types.js';
/**
 * Read a table's actual structure from the database.
 *
 * Returns a `TableDef` whose columns/indexes mirror what SQLite currently
 * has, suitable for passing as the `from` argument to `schemaDiff()`.
 *
 * ```ts
 * const actual = reflectTableSchema(db, 'users');
 * const diff = schemaDiff(actual, desiredSchema);
 * ```
 *
 * Detected: columns (type / notNull / primaryKey / default), indexes
 * (unique / partial), table options (strict / withoutRowId).
 *
 * Not detected (SQLite does not expose them via PRAGMA): column-level
 * CHECK expressions, column references (foreign keys), COLLATE. These are
 * best read from your schema files / migrations instead.
 */
export declare function reflectTableSchema(exec: Executor, table: string): TableDef;
//# sourceMappingURL=reflect.d.ts.map