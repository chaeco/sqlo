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

import { quoteIdent } from '../query/sql.ts';
import { columnDDL, indexDDLs } from './ddl.ts';
import type { ColumnDef, IndexDef, TableDef, SqlFragment } from './types.ts';

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

function columnKey(col: ColumnDef): string {
  // Serialize type + constraints so we can detect meaningful changes while
  // ignoring key ordering. Plain-string CHECK/where are compared by text.
  const chk = col.check;
  const checkText = chk === undefined ? undefined : (typeof chk === 'string' ? chk : chk.text);
  return JSON.stringify({
    type: col.type.toUpperCase(),
    primaryKey: col.primaryKey ?? false,
    autoIncrement: col.autoIncrement ?? false,
    notNull: col.notNull ?? false,
    unique: col.unique ?? false,
    collate: col.collate,
    default: col.default,
    check: checkText,
    references: col.references,
  });
}

function fragmentText(x: SqlFragment | string): string {
  return typeof x === 'string' ? x : x.text;
}

function sameIndexes(a: IndexDef, b: IndexDef): boolean {
  if (a.name !== b.name) return false;
  if ((a.unique ?? false) !== (b.unique ?? false)) return false;
  const colsA = a.columns.map((c) => (typeof c === 'string' ? c : `${c.name} ${c.direction ?? 'ASC'}`));
  const colsB = b.columns.map((c) => (typeof c === 'string' ? c : `${c.name} ${c.direction ?? 'ASC'}`));
  if (JSON.stringify(colsA) !== JSON.stringify(colsB)) return false;
  const wA = a.where ? fragmentText(a.where) : null;
  const wB = b.where ? fragmentText(b.where) : null;
  return wA === wB;
}

function hasIncompatibleAddColumn(name: string, col: ColumnDef): string | null {
  // SQLite's ALTER TABLE ADD COLUMN cannot add PRIMARY KEY / UNIQUE columns.
  if (col.primaryKey || col.unique) {
    return `Column "${name}" cannot be added with ALTER TABLE because it is PRIMARY KEY or UNIQUE. Requires a table-rebuild migration.`;
  }
  if (col.notNull && col.default === undefined) {
    return `Column "${name}" is NOT NULL without a DEFAULT — SQLite cannot add it to a non-empty table. Add a DEFAULT or allow NULL.`;
  }
  return null;
}

/**
 * Compare two table definitions and produce migration guidance.
 */
export function schemaDiff(from: TableDef, to: TableDef): SchemaDiff {
  const result: SchemaDiff = {
    addedColumns: [],
    removedColumns: [],
    changedColumns: [],
    addedIndexes: [],
    removedIndexes: [],
    statements: [],
    warnings: [],
  };

  // ---- Columns ----
  const fromCols = Object.keys(from.columns);
  const toCols = Object.keys(to.columns);

  for (const name of toCols) {
    if (!from.columns[name]) {
      result.addedColumns.push(name);
      const col = to.columns[name]!;
      const warn = hasIncompatibleAddColumn(name, col);
      if (warn) {
        result.warnings.push(warn);
      } else {
        result.statements.push(
          `ALTER TABLE ${quoteIdent(to.name)} ADD COLUMN ${quoteIdent(name)} ${columnDDL(col)};`,
        );
      }
    } else if (columnKey(from.columns[name]!) !== columnKey(to.columns[name]!)) {
      result.changedColumns.push(name);
      result.warnings.push(
        `Column "${name}": type/constraints changed (SQLite cannot ALTER COLUMN in place). ` +
        `Requires a table-rebuild migration: create a new table, copy data, drop the old table, rename.`,
      );
    }
  }

  for (const name of fromCols) {
    if (!to.columns[name]) {
      result.removedColumns.push(name);
      result.warnings.push(
        `Column "${name}" was removed. SQLite 3.35+ supports DROP COLUMN but it may fail on indexed/constrained columns — verify and write a rebuild migration if needed.`,
      );
    }
  }

  // ---- Indexes ----
  const fromIdx = new Map((from.indexes ?? []).map((i) => [i.name, i]));
  const toIdx = new Map((to.indexes ?? []).map((i) => [i.name, i]));

  for (const [name, idx] of toIdx) {
    if (!fromIdx.has(name)) {
      result.addedIndexes.push(name);
      result.statements.push(...indexDDLs({ ...to, indexes: [idx] }));
    } else if (!sameIndexes(fromIdx.get(name)!, idx)) {
      result.removedIndexes.push(name);
      result.addedIndexes.push(name);
      result.statements.push(`DROP INDEX IF EXISTS ${quoteIdent(name)};`);
      result.statements.push(...indexDDLs({ ...to, indexes: [idx] }));
    }
  }

  for (const [name] of fromIdx) {
    if (!toIdx.has(name)) {
      result.removedIndexes.push(name);
      result.statements.push(`DROP INDEX IF EXISTS ${quoteIdent(name)};`);
    }
  }

  // ---- Table-level options (strict / withoutRowId / table checks) ----
  if ((from.strict ?? false) !== (to.strict ?? false)) {
    result.warnings.push(
      `Table option "strict" changed (${from.strict ?? false} → ${to.strict ?? false}). ` +
      `Cannot be applied in place — requires a table-rebuild migration.`,
    );
  }
  if ((from.withoutRowId ?? false) !== (to.withoutRowId ?? false)) {
    result.warnings.push(
      `Table option "withoutRowId" changed (${from.withoutRowId ?? false} → ${to.withoutRowId ?? false}). ` +
      `Cannot be applied in place — requires a table-rebuild migration.`,
    );
  }
  const fromChecks = (from.checks ?? []).map((c) => fragmentText(c));
  const toChecks = (to.checks ?? []).map((c) => fragmentText(c));
  if (JSON.stringify(fromChecks) !== JSON.stringify(toChecks)) {
    result.warnings.push(
      `Table-level CHECK constraints changed. Cannot be applied in place — requires a table-rebuild migration.`,
    );
  }

  return result;
}

/**
 * Generate a ready-to-save migration SQL file from a schema diff.
 * The caller is expected to review and save the result as a `.sql` migration
 * file, then run it through `db.migrate()`.
 */
export function generateMigrationSql(from: TableDef, to: TableDef, header = ''): string {
  const diff = schemaDiff(from, to);
  const lines: string[] = [];

  if (header) lines.push(header);
  lines.push(`-- Migration: ${to.name} (generated by schemaDiff)`);
  lines.push('');

  if (diff.statements.length > 0) {
    lines.push('-- Safe statements');
    lines.push(...diff.statements);
    lines.push('');
  }

  if (diff.warnings.length > 0) {
    lines.push('-- ⚠️  Manual review required (SQLite cannot apply in place):');
    lines.push(...diff.warnings.map((w) => `--   ${w}`));
    lines.push('');
  }

  if (diff.addedColumns.length === 0 && diff.removedColumns.length === 0 &&
      diff.changedColumns.length === 0 && diff.addedIndexes.length === 0 &&
      diff.removedIndexes.length === 0 && diff.warnings.length === 0) {
    lines.push('-- No schema differences.');
  }

  return lines.join('\n');
}
