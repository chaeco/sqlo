/**
 * Schema diff — compare two table definitions and produce migration guidance.
 *
 * Sqlo never applies schema changes automatically (#30: SQL-file migrations
 * only). This module is the "planning aid": it tells you exactly what SQL
 * would be needed to move from one table definition to another, split into
 * safe statements (which you can run via ALTER TABLE / CREATE INDEX) and
 * warnings (changes SQLite cannot apply in place — those require a
 * table-rebuild migration written by hand).
 */
import type { TableDef } from './types.js';
export interface SchemaDiff {
    /** Column names added in `to` but absent in `from`. */
    addedColumns: string[];
    /** Column names present in `from` but removed in `to`. */
    removedColumns: string[];
    /** Columns whose type or constraints changed. */
    changedColumns: string[];
    /** Index names added in `to`. */
    addedIndexes: string[];
    /** Index names present in `from` but removed in `to`. */
    removedIndexes: string[];
    /**
     * SQL statements that can be executed directly to bring the schema up to
     * date (ALTER TABLE ADD COLUMN, CREATE INDEX IF NOT EXISTS).
     */
    statements: string[];
    /**
     * Human-readable warnings for changes that cannot be applied in place
     * (e.g. changing a column type, tightening NOT NULL) — these require a
     * table-rebuild migration.
     */
    warnings: string[];
}
/**
 * Compare two table definitions and produce migration guidance.
 */
export declare function schemaDiff(from: TableDef, to: TableDef): SchemaDiff;
/**
 * Generate a ready-to-save migration SQL file from a schema diff.
 * The caller is expected to review and save the result as a `.sql` migration
 * file, then run it through `db.migrate()`.
 */
export declare function generateMigrationSql(from: TableDef, to: TableDef, header?: string): string;
//# sourceMappingURL=diff.d.ts.map