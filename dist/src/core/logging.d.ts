export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Logging event categories. */
export type LogEvent = 'query' | 'transaction' | 'schema' | 'connection' | 'migrate';
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
/**
 * Should an entry of `level` be emitted given the configured threshold?
 * The threshold is inclusive: `warn` emits warn + error.
 */
export declare function shouldLog(level: LogLevel, threshold: LogLevel): boolean;
//# sourceMappingURL=logging.d.ts.map