// ---------------------------------------------------------------------------
// Behaviour logging
//
// Sqlo exposes an optional logging window (`onLog`) so applications can
// observe what the ORM is doing — queries, transactions, schema operations,
// connection lifecycle. Logging is opt-in and level-filtered; it never
// affects behaviour.
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Logging event categories. */
export type LogEvent =
  | 'query'
  | 'transaction'
  | 'schema'
  | 'connection'
  | 'migrate';

export interface LogEntry {
  /** Severity. */
  level: LogLevel;
  /** Event category. */
  event: LogEvent;
  /** Human-readable summary. */
  message: string;
  /** The SQL involved (if any). */
  sql?: string;
  /** Bound parameters (if any). */
  params?: unknown[];
  /** Query / operation duration in milliseconds. */
  durationMs?: number;
  /** Extra context (e.g. transaction depth, migration name). */
  detail?: string;
  /** Timestamp (ms since epoch). */
  timestamp: number;
}

/** Numeric ordering for level filtering. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Should an entry of `level` be emitted given the configured threshold?
 * The threshold is inclusive: `warn` emits warn + error.
 */
export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}
