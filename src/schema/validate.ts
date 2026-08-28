/**
 * Schema validation.
 *
 * `validateSchema` checks a `TableDef` for structural errors (missing type,
 * bad autoIncrement/references/CHECK combos, unknown index columns, …) and
 * returns non-fatal warnings (e.g. non-standard column type names, which
 * SQLite accepts via type affinity). It is shared by `db.define()` and
 * `loadTableDefSync()` so that JSON-loaded table definitions are validated at
 * load time, not deferred until `define()`.
 *
 * `schemaHasReferences` is used to warn when foreign keys are declared but the
 * connection has `enableForeignKeyConstraints: false`.
 */

import type { TableDef } from './types';

const VALID_COLUMN_TYPES = new Set([
  'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
  'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP',
  'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'CLOB',
  'DOUBLE', 'FLOAT', 'DECIMAL', 'TINYINT', 'SMALLINT',
  'MEDIUMINT', 'BIGINT', 'INT', 'INT2', 'INT8',
]);

const VALID_REF_ACTIONS = new Set([
  'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION',
]);

export function schemaHasReferences(schema: TableDef): boolean {
  return Object.values(schema.columns).some((col) => col.references !== undefined);
}

export function validateSchema(schema: TableDef): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!schema.name) {
    errors.push('Table name is required.');
  } else if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(schema.name)) {
    errors.push(
      `Invalid table name: "${schema.name}". ` +
      'Use "table" or "schema.table" (for attached databases).',
    );
  }

  const colNames = Object.keys(schema.columns);
  if (colNames.length === 0) {
    errors.push('At least one column is required.');
  }

  for (const name of colNames) {
    const col = schema.columns[name]!;
    if (!col.type) {
      errors.push(`Column "${name}" is missing a "type".`);
    } else if (!VALID_COLUMN_TYPES.has(col.type.toUpperCase())) {
      // SQLite accepts arbitrary type names (type affinity). Follow SQLite's
      // semantics but warn — a non-standard type name is often a typo.
      warnings.push(
        `Column "${name}" has a non-standard type "${col.type}". ` +
          'SQLite accepts it (type affinity), but ensure this is intentional.',
      );
    }

    if (col.autoIncrement && (!col.primaryKey || col.type.toUpperCase() !== 'INTEGER')) {
      errors.push(
        `Column "${name}": autoIncrement requires type INTEGER and primaryKey=true.`,
      );
    }

    if (col.references) {
      const ref = col.references;
      if (ref.onDelete && !VALID_REF_ACTIONS.has(ref.onDelete)) {
        errors.push(`Column "${name}": invalid onDelete "${ref.onDelete}".`);
      }
      if (ref.onUpdate && !VALID_REF_ACTIONS.has(ref.onUpdate)) {
        errors.push(`Column "${name}": invalid onUpdate "${ref.onUpdate}".`);
      }
    }

    if (col.check && typeof col.check !== 'string' && col.check.params.length > 0) {
      errors.push(
        `Column "${name}": CHECK constraint cannot contain bound parameters.`,
      );
    }
  }

  // Validate indexes
  if (schema.indexes) {
    const idxNames = new Set<string>();
    for (const idx of schema.indexes) {
      if (idxNames.has(idx.name)) {
        errors.push(`Duplicate index name: "${idx.name}".`);
      }
      idxNames.add(idx.name);
      if (idx.columns.length === 0) {
        errors.push(`Index "${idx.name}" has no columns.`);
      }
      for (const c of idx.columns) {
        const colName = typeof c === 'string' ? c : c.name;
        if (!schema.columns[colName]) {
          errors.push(`Index "${idx.name}" references unknown column "${colName}".`);
        }
      }
      if (idx.where && typeof idx.where !== 'string' && idx.where.params.length > 0) {
        errors.push(`Index "${idx.name}": WHERE clause cannot contain bound parameters.`);
      }
    }
  }

  // Validate table-level CHECK constraints
  if (schema.checks) {
    for (let i = 0; i < schema.checks.length; i++) {
      const chk = schema.checks[i]!;
      if (typeof chk !== 'string' && chk.params.length > 0) {
        errors.push(
          `CHECK constraint #${i} on table "${schema.name}" cannot contain bound parameters.`,
        );
      }
    }
  }

  return { errors, warnings };
}
