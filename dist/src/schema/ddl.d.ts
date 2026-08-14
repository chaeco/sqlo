/**
 * DDL (Data Definition Language) generators.
 * Translates a TableDef into CREATE TABLE / CREATE INDEX statements.
 */
import type { ColumnDef, TableDef } from './types.js';
/**
 * Generate the column definition fragment (everything after the column
 * name) for a single column: type, constraints, defaults, CHECK, and
 * foreign key references.
 *
 * @param col The column definition.
 * @returns A fragment like `TEXT NOT NULL DEFAULT 'draft'` or
 *   `INTEGER PRIMARY KEY AUTOINCREMENT`.
 */
export declare function columnDDL(col: ColumnDef<string>): string;
/**
 * Generate a `CREATE TABLE IF NOT EXISTS` statement from a table definition.
 * Columns, table-level CHECK constraints, `STRICT` and `WITHOUT ROWID`
 * options are all included.
 *
 * @param schema The table definition.
 * @returns A complete `CREATE TABLE IF NOT EXISTS "name" (...)` statement.
 */
export declare function tableDDL(schema: TableDef): string;
/**
 * Generate `CREATE [UNIQUE] INDEX IF NOT EXISTS` statements for every index
 * declared in the table definition, including partial-index `WHERE` clauses
 * and per-column sort directions.
 *
 * @param schema The table definition.
 * @returns One `CREATE INDEX` statement per declared index; an empty array
 *   when the schema declares no indexes.
 */
export declare function indexDDLs(schema: TableDef): string[];
//# sourceMappingURL=ddl.d.ts.map