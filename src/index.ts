/**
 * Sqlo — lightweight, SQLite‑only ORM for Node.js built on `node:sqlite`.
 *
 * @module sqlo
 */

export { Sqlo } from './core/sqlo';
export type { SqloOptions, MigrateOptions } from './core/sqlo';
export { MultiSqlo } from './core/multi-sqlo';
export type { MultiSqloOptions } from './core/multi-sqlo';

export { isBusyError, isConstraintError, SQLITE } from './core/error';
export type { SqliteErrorLike } from './core/error';
export type { LogEntry, LogEvent, LogLevel } from './core/logging';

export { Model } from './model/model';
export { QueryBuilder } from './query/query-builder';

export { sql, raw, quoteIdent, quoteTable, isFragment, isIdent } from './query/sql';
export type { SqlFragment, Ident } from './schema/types';

export { tableDDL, columnDDL, indexDDLs } from './schema/ddl';
export { schemaDiff, generateMigrationSql } from './schema/diff';
export type { SchemaDiff } from './schema/diff';
export { reflectTableSchema } from './schema/reflect';
export { loadTableDefSync } from './schema/json';

export { loadMigrations, loadMigrationsSync } from './migration/migration';

export { AsyncSqlo } from './async/async';
export { AsyncModel, AsyncQueryBuilder } from './async/async-model';
export type { AsyncExecutor, AsyncTransaction } from './async/async-model';

// Type-only exports — re-export so consumers can use type helpers
export type {
  ColumnDef,
  TableDef,
  IndexDef,
  RefAction,
  SqliteType,
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
} from './schema/types';