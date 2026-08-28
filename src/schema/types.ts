/**
 * Sqlo type definitions.
 * All canonical types live here — column definitions, table schemas,
 * type inference helpers, and where expression operators.
 */

// ---------------------------------------------------------------------------
// Symbol brands for SqlFragment and Ident
// ---------------------------------------------------------------------------

export const SQL_FRAGMENT: unique symbol = Symbol('sqlo.sqlFragment');
export const SQL_IDENT: unique symbol = Symbol('sqlo.sqlIdent');

// ---------------------------------------------------------------------------
// SqlFragment & Ident — building blocks for safe SQL composition
// ---------------------------------------------------------------------------

export interface SqlFragment {
  readonly [SQL_FRAGMENT]: true;
  readonly text: string;
  readonly params: readonly unknown[];
}

export interface Ident {
  readonly [SQL_IDENT]: true;
  readonly value: string;
}

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

export type RefAction =
  | 'CASCADE'
  | 'SET NULL'
  | 'SET DEFAULT'
  | 'RESTRICT'
  | 'NO ACTION';

export type SqliteType = keyof TypeToJs;

export interface ColumnDef<T extends string = SqliteType> {
  /** SQLite column type (e.g. 'INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'). Any SQLite type name is allowed (type affinity), but known names are constrained by `SqliteType` for typo protection. */
  type: T;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  collate?: string;
  /** Default value — literal number/string/boolean/null, or a sql\`...\` fragment */
  default?: unknown;
  /** CHECK constraint — a sql\`...\` fragment or plain SQL expression (no bound params) */
  check?: SqlFragment | string;
  /** Foreign key reference */
  references?: {
    table: string;
    column: string;
    onDelete?: RefAction;
    onUpdate?: RefAction;
  };
  /**
   * Documentation only — a human-readable column description.
   * SQLite has no column-comment syntax, so this never appears in DDL,
   * is ignored by schemaDiff, and cannot be read back via reflectTableSchema.
   */
  comment?: string;
}

export type IndexColumn =
  | string
  | { name: string; direction?: 'ASC' | 'DESC' };

export interface IndexDef {
  name: string;
  columns: readonly IndexColumn[];
  unique?: boolean;
  /** Partial index predicate — a sql\`...\` fragment or plain SQL expression (no bound params) */
  where?: SqlFragment | string;
}

export interface TableDef<C extends Record<string, ColumnDef<string>> = Record<string, ColumnDef<string>>> {
  name: string;
  columns: C;
  /** Free-text documentation for the whole table — never part of DDL, diff, or reflection */
  comment?: string;
  indexes?: readonly IndexDef[];
  /** Table-level CHECK constraints as sql\`...\` fragments or plain SQL expressions (no bound params) */
  checks?: readonly (SqlFragment | string)[];
  /** Appends STRICT to CREATE TABLE (SQLite ≥3.37) */
  strict?: boolean;
  /** Appends WITHOUT ROWID */
  withoutRowId?: boolean;
}

// ---------------------------------------------------------------------------
// Type inference: SQLite column type name → JavaScript type
// ---------------------------------------------------------------------------

export interface TypeToJs {
  INTEGER: number;
  REAL: number;
  NUMERIC: number;
  BOOLEAN: number;
  DOUBLE: number;
  FLOAT: number;
  DECIMAL: number;
  TINYINT: number;
  SMALLINT: number;
  MEDIUMINT: number;
  BIGINT: number;
  INT: number;
  INT2: number;
  INT8: number;
  BLOB: Uint8Array;
  TEXT: string;
  CHAR: string;
  VARCHAR: string;
  NCHAR: string;
  NVARCHAR: string;
  CLOB: string;
  DATETIME: string;
  DATE: string;
  TIMESTAMP: string;
}

export type ColumnValue<D extends ColumnDef<string>> =
  D['type'] extends keyof TypeToJs
    ? TypeToJs[D['type']]
    : string;

// ---------------------------------------------------------------------------
// Nullability helpers
// ---------------------------------------------------------------------------

type IsNullable<D extends ColumnDef<string>> =
  D['notNull'] extends true ? false
  : D['primaryKey'] extends true ? false
  : D['autoIncrement'] extends true ? false
  : true;

type HasProp<O, K extends PropertyKey> =
  K extends keyof O ? true : false;

type IsRequiredInInput<D extends ColumnDef<string>> =
  D['autoIncrement'] extends true ? false
  : D['primaryKey'] extends true ? (D['autoIncrement'] extends true ? false : true)
  : IsNullable<D> extends true ? false
  : HasProp<D, 'default'> extends true ? false
  : true;

// ---------------------------------------------------------------------------
// Row, Insert, Patch type inference
// ---------------------------------------------------------------------------

type ColumnRowValue<D extends ColumnDef<string>> =
  IsNullable<D> extends true
    ? ColumnValue<D> | null
    : ColumnValue<D>;

type ColumnPatchValue<D extends ColumnDef<string>> =
  IsNullable<D> extends true
    ? ColumnValue<D> | null | undefined
    : ColumnValue<D> | undefined;

export type RowOf<S extends TableDef> = {
  [K in keyof S['columns']]: ColumnRowValue<S['columns'][K]>;
};

export type InsertOf<S extends TableDef> = {
  [K in keyof S['columns'] as IsRequiredInInput<S['columns'][K]> extends true ? K : never]:
    ColumnValue<S['columns'][K]>;
} & {
  [K in keyof S['columns'] as IsRequiredInInput<S['columns'][K]> extends true ? never : K]?:
    IsNullable<S['columns'][K]> extends true
      ? ColumnValue<S['columns'][K]> | null
      : ColumnValue<S['columns'][K]>;
} & {};

export type PatchOf<S extends TableDef> = {
  [K in keyof S['columns'] as S['columns'][K]['autoIncrement'] extends true ? never : K]?:
    ColumnPatchValue<S['columns'][K]>;
};

// ---------------------------------------------------------------------------
// Where expressions
// ---------------------------------------------------------------------------

export interface WhereOps<T> {
  eq?: T;
  ne?: T;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  like?: string;
  notLike?: string;
  glob?: string;
  notGlob?: string;
  in?: readonly T[];
  notIn?: readonly T[];
  between?: readonly [T, T];
  is?: unknown;
  isNot?: unknown;
  isNull?: boolean;
  notNull?: boolean;
}

export type WhereValue<T> =
  | T
  | null
  | readonly T[]
  | WhereOps<T>;

export type WhereExpr<T> = {
  [K in keyof T]?: WhereValue<T[K]>;
};

export type OrderDir = 'asc' | 'desc' | 'ASC' | 'DESC';

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrationDef {
  name: string;
  /** SQL string or callback receiving the raw Sqlo instance */
  up: string | ((db: { exec(sql: string): void }) => void);
  down?: string | ((db: { exec(sql: string): void }) => void);
}

export interface MigrationStatus {
  name: string;
  appliedAt: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers — used by model / query-builder / sqlo
// ---------------------------------------------------------------------------

export interface WhereCondition {
  type: 'AND' | 'OR';
  fragments: SqlFragment[];
}

export interface JoinClause {
  type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
  table: string;
  on: SqlFragment;
}

export interface SqlOptions {
  path: string;
  readBigInts?: boolean;
  enableForeignKeyConstraints?: boolean;
  enableDoubleQuotedStringLiterals?: boolean;
  allowExtension?: boolean;
  busyTimeout?: number;
}