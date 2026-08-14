/**
 * Sqlo — lightweight, SQLite‑only ORM for Node.js built on `node:sqlite`.
 *
 * @module sqlo
 */

export { Sqlo } from './core/sqlo.ts';
export type { SqloOptions, MigrateOptions } from './core/sqlo.ts';
export { MultiSqlo } from './core/multi-sqlo.ts';
export type { MultiSqloOptions } from './core/multi-sqlo.ts';

export { Model } from './model/model.ts';
export { QueryBuilder } from './query/query-builder.ts';

export { sql, raw, quoteIdent, quoteTable, isFragment, isIdent } from './query/sql.ts';
export type { SqlFragment, Ident } from './schema/types.ts';

export { tableDDL, columnDDL, indexDDLs } from './schema/ddl.ts';
export { schemaDiff, generateMigrationSql } from './schema/diff.ts';
export type { SchemaDiff } from './schema/diff.ts';
export { reflectTableSchema } from './schema/reflect.ts';
export { loadTableDefSync } from './schema/json.ts';

export { loadMigrations, loadMigrationsSync } from './migration/migration.ts';

export { AsyncSqlo } from './async/async.ts';

// Type-only exports — re-export so consumers can use type helpers
export type {
  ColumnDef,
  TableDef,
  IndexDef,
  RefAction,
  SqlOptions,

  TypeToJs,
  ColumnValue,
  RowOf,
  InsertOf,
  PatchOf,

  WhereOps,
  WhereValue,
  WhereExpr,
  OrderDir,

  MigrationDef,
  MigrationStatus,
} from './schema/types.ts';