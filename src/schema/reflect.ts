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

import { quoteIdent } from '../query/sql.ts';
import type { Executor } from '../query/query-builder.ts';
import type { ColumnDef, IndexDef, TableDef } from './types.ts';

interface PRAGMA_TableInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PRAGMA_IndexList {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface PRAGMA_IndexInfo {
  seqno: number;
  cid: number;
  name: string | null;
}

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
export function reflectTableSchema(exec: Executor, table: string): TableDef {
  // Split "schema.table" (attached database) from a bare "table" name.
  const parts = table.split('.');
  const schema = parts.length === 2 ? parts[0]! : 'main';
  const name = parts.length === 2 ? parts[1]! : table;
  const schemaIdent = quoteIdent(schema);
  const tableIdent = quoteIdent(name);
  // sqlite_master lives in each attached schema.
  const master = `${schemaIdent}.sqlite_master`;

  // Does the table exist?
  const existing = exec.prepare(
    `SELECT name FROM ${master} WHERE type = ? AND name = ?`,
  ).get('table', name) as { name: string } | undefined;
  if (!existing) {
    throw new Error(`Table "${table}" does not exist.`);
  }

  // ---- Columns ----
  const colRows = exec.prepare(`PRAGMA ${schemaIdent}.table_info(${tableIdent})`).all() as unknown as PRAGMA_TableInfo[];
  const columns: Record<string, ColumnDef> = {};
  for (const col of colRows) {
    const def: ColumnDef = {
      type: col.type || 'TEXT', // SQLite reports '' for typeless columns
    };
    if (col.pk > 0) def.primaryKey = true;
    if (col.notnull === 1) def.notNull = true;
    if (col.dflt_value !== null) def.default = parseDefaultLiteral(col.dflt_value);
    columns[col.name] = def;
  }

  // AUTOINCREMENT is not reported by PRAGMA table_info. When the column
  // is INTEGER PRIMARY KEY AND the table appears in sqlite_sequence, the
  // table was created with AUTOINCREMENT.
  const hasAutoincrement = isAutoincrementTable(exec, schema, name);

  // ---- Indexes (exclude implicit indexes SQLite manages internally) ----
  const idxRows = exec.prepare(`PRAGMA ${schemaIdent}.index_list(${tableIdent})`).all() as unknown as PRAGMA_IndexList[];
  const indexes: IndexDef[] = [];
  for (const idx of idxRows) {
    if (idx.origin === 'u') {
      // UNIQUE constraint → surface as `unique: true` on the column,
      // not as a standalone index.
      const info = exec.prepare(`PRAGMA ${schemaIdent}.index_info(${quoteIdent(idx.name)})`).all() as unknown as PRAGMA_IndexInfo[];
      const cols = info.sort((a, b) => a.seqno - b.seqno).map((i) => i.name);
      if (cols.length === 1 && cols[0] !== null) {
        const col = columns[cols[0]!];
        if (col) col.unique = true;
        continue;
      }
    }
    // origin 'pk' (primary key) is already captured in column definitions.
    if (idx.origin !== 'c') continue;
    const info = exec.prepare(`PRAGMA ${schemaIdent}.index_info(${quoteIdent(idx.name)})`).all() as unknown as PRAGMA_IndexInfo[];
    const cols = info
      .sort((a, b) => a.seqno - b.seqno)
      .map((i) => i.name)
      .filter((n): n is string => n !== null);
    indexes.push({
      name: idx.name,
      columns: cols,
      ...(idx.unique === 1 ? { unique: true } : {}),
    });
  }

  // Attach AUTOINCREMENT to the single INTEGER PRIMARY KEY column if detected.
  if (hasAutoincrement) {
    for (const col of Object.values(columns)) {
      if (col.primaryKey && /INTEGER/i.test(col.type)) {
        col.autoIncrement = true;
        break;
      }
    }
  }

  // ---- Table options from the CREATE TABLE SQL ----
  let strict = false;
  let withoutRowId = false;
  const sqlRow = exec.prepare(
    `SELECT sql FROM ${master} WHERE type = ? AND name = ?`,
  ).get('table', name) as { sql: string } | undefined;
  if (sqlRow?.sql) {
    strict = /\bSTRICT\b/.test(sqlRow.sql);
    withoutRowId = /\bWITHOUT\s+ROWID\b/i.test(sqlRow.sql);
  }

  return {
    name: table,
    columns,
    ...(indexes.length > 0 ? { indexes } : {}),
    ...(strict ? { strict } : {}),
    ...(withoutRowId ? { withoutRowId } : {}),
  };
}

/**
 * Detect whether a table was created with AUTOINCREMENT. SQLite keeps a
 * `sqlite_sequence` table only for AUTOINCREMENT tables that have had rows
 * inserted; a table with no rows yet won't appear there. We instead check
 * the CREATE TABLE SQL for the AUTOINCREMENT keyword, which is reliable.
 */
function isAutoincrementTable(exec: Executor, schema: string, table: string): boolean {
  const row = exec.prepare(
    `SELECT sql FROM ${quoteIdent(schema)}.sqlite_master WHERE type = ? AND name = ?`,
  ).get('table', table) as { sql: string } | undefined;
  return /\bAUTOINCREMENT\b/i.test(row?.sql ?? '');
}

/**
 * Best-effort conversion of a SQLite default-value literal into a JS value.
 * SQLite reports defaults as strings (e.g. "0", "'draft'", "CURRENT_TIMESTAMP").
 * Numeric literals become numbers, quoted strings become strings, everything
 * else (expressions, keywords) is kept as-is.
 */
function parseDefaultLiteral(raw: string): unknown {
  const s = raw.trim();
  // Number
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  // Quoted string '...' (SQLite doubles single quotes inside)
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  // Everything else (expressions, CURRENT_TIMESTAMP, function calls...)
  return s;
}
