/** SQLite result codes (subset — the ones application code branches on). */
export declare const SQLITE: {
    /** SQLITE_ERROR — generic SQL error or missing database. */
    readonly ERROR: 1;
    /** SQLITE_BUSY — the database file is locked (another connection is writing). */
    readonly BUSY: 5;
    /** SQLITE_LOCKED — a table in the database is locked. */
    readonly LOCKED: 6;
    /** SQLITE_READONLY — attempt to write a readonly database. */
    readonly READONLY: 8;
    /** SQLITE_INTERRUPT — operation interrupted by `interrupt()`. */
    readonly INTERRUPT: 9;
    /** SQLITE_CORRUPT — the database file is corrupt. */
    readonly CORRUPT: 11;
    /** SQLITE_FULL — disk full. */
    readonly FULL: 13;
    /** SQLITE_CONSTRAINT — a UNIQUE / NOT NULL / CHECK / FK constraint failed. */
    readonly CONSTRAINT: 19;
};
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
export declare function isBusyError(e: unknown): e is SqliteErrorLike;
/**
 * Type guard — is this a constraint violation (`SQLITE_CONSTRAINT`, errcode
 * 19)? Covers UNIQUE, NOT NULL, CHECK and foreign-key violations.
 */
export declare function isConstraintError(e: unknown): e is SqliteErrorLike;
//# sourceMappingURL=error.d.ts.map