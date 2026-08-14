// ---------------------------------------------------------------------------
// SQLite error classification
//
// node:sqlite surfaces errors as plain `Error` objects carrying SQLite
// extended result codes on `errcode` / `errstr` (plus a `code` of
// `ERR_SQLITE_ERROR` for every SQLite failure). Sqlo deliberately does NOT
// wrap or re-map these errors (the founding spec says expose SQLite
// behaviour, never simulate it). Instead it provides narrow type guards so
// application code can branch on the actual SQLite result code.
// ---------------------------------------------------------------------------

/** SQLite result codes (subset — the ones application code branches on). */
export const SQLITE = {
  /** SQLITE_ERROR — generic SQL error or missing database. */
  ERROR: 1,
  /** SQLITE_BUSY — the database file is locked (another connection is writing). */
  BUSY: 5,
  /** SQLITE_LOCKED — a table in the database is locked. */
  LOCKED: 6,
  /** SQLITE_READONLY — attempt to write a readonly database. */
  READONLY: 8,
  /** SQLITE_INTERRUPT — operation interrupted by `interrupt()`. */
  INTERRUPT: 9,
  /** SQLITE_CORRUPT — the database file is corrupt. */
  CORRUPT: 11,
  /** SQLITE_FULL — disk full. */
  FULL: 13,
  /** SQLITE_CONSTRAINT — a UNIQUE / NOT NULL / CHECK / FK constraint failed. */
  CONSTRAINT: 19,
} as const;

/** The shape of errors raised by `node:sqlite` (an `Error` with SQLite codes). */
export interface SqliteErrorLike extends Error {
  errcode?: number;
  errstr?: string;
}

/**
 * Type guard — is this an error caused by the database being locked
 * (`SQLITE_BUSY`, errcode 5)? SQLite is single-writer (see README); a busy
 * error means another connection holds the write lock. In production this is
 * the signal to back off and retry.
 */
export function isBusyError(e: unknown): e is SqliteErrorLike {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as SqliteErrorLike;
  if (typeof err.errcode === 'number' && (err.errcode & 0xff) === SQLITE.BUSY) return true;
  if (err.errcode !== undefined) return false;
  // Fallback: node:sqlite always sets errcode for SQLite failures, but be
  // defensive about messages from other layers.
  const msg = err.message ?? '';
  return /database is locked/i.test(msg) || /locked/i.test(msg);
}

/**
 * Type guard — is this a constraint violation (`SQLITE_CONSTRAINT`, errcode
 * 19)? Covers UNIQUE, NOT NULL, CHECK and foreign-key violations.
 */
export function isConstraintError(e: unknown): e is SqliteErrorLike {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as SqliteErrorLike;
  if (typeof err.errcode === 'number' && (err.errcode & 0xff) === SQLITE.CONSTRAINT) {
    return true;
  }
  if (err.errcode !== undefined) return false;
  const msg = err.message ?? '';
  return /constraint failed/i.test(msg);
}
