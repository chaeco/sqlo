// ---------------------------------------------------------------------------
// Behaviour logging
//
// Sqlo exposes an optional logging window (`onLog`) so applications can
// observe what the ORM is doing — queries, transactions, schema operations,
// connection lifecycle. Logging is opt-in and level-filtered; it never
// affects behaviour.
// ---------------------------------------------------------------------------
/** Numeric ordering for level filtering. */
const LEVEL_ORDER = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
/**
 * Should an entry of `level` be emitted given the configured threshold?
 * The threshold is inclusive: `warn` emits warn + error.
 */
export function shouldLog(level, threshold) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}
//# sourceMappingURL=logging.js.map