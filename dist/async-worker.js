import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

/**
 * Worker bootstrap for the async wrapper.
 *
 * Opens a DatabaseSync connection in the worker thread and processes
 * userland messages (exec, all, get, run, close) one at a time.
 *
 * Transaction primitives (txBegin / txCommit / txRollback) maintain a
 * SAVEPOINT state machine here, mirroring `Sqlo`'s nested-transaction
 * behaviour: the top-level transaction uses BEGIN/COMMIT/ROLLBACK, nested
 * ones use SAVEPOINT/RELEASE/ROLLBACK TO. The worker is the only place that
 * knows whether the connection is inside a transaction, so it decides between
 * BEGIN and SAVEPOINT. Ordinary statements executed while a transaction is
 * open naturally land in it (SQLite connection-level transactions).
 *
 * Errors are shipped back with SQLite extended result codes (`errcode` /
 * `errstr`) so the main thread can classify them with `isBusyError` /
 * `isConstraintError` — postMessage would otherwise strip them.
 */
function send(id, ok, data, error) {
    parentPort.postMessage({ id, ok, data, error });
}
function handleError(id, err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const sqliteErr = e;
    send(id, false, undefined, {
        message: e.message,
        stack: e.stack,
        name: e.name,
        errcode: typeof sqliteErr.errcode === 'number' ? sqliteErr.errcode : undefined,
        errstr: typeof sqliteErr.errstr === 'string' ? sqliteErr.errstr : undefined,
    });
}
// ---------------------------------------------------------------------------
const config = workerData;
const db = new DatabaseSync(config.path, config.options ?? {});
// Connection PRAGMAs — parity with the sync Sqlo constructor. node:sqlite's
// DatabaseSyncOptions has no journalMode/busyTimeout, so AsyncSqlo forwards
// them through workerData and they are applied here. Both are whitelisted /
// validated rather than interpolated blindly.
const JOURNAL_MODES = new Set(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF']);
const busyTimeout = config.options?.busyTimeout;
if (typeof busyTimeout === 'number' && Number.isFinite(busyTimeout) && busyTimeout > 0) {
    db.exec(`PRAGMA busy_timeout = ${Math.floor(busyTimeout)}`);
}
const journalMode = config.options?.journalMode;
if (typeof journalMode === 'string' && JOURNAL_MODES.has(journalMode) && journalMode !== 'DELETE') {
    db.exec(`PRAGMA journal_mode = ${journalMode}`);
}
// Transaction nesting depth, owned by the worker. 0 = no transaction open.
// >0 = inside a transaction; the worker decides BEGIN vs SAVEPOINT based on
// whether this is the top-level entry.
let txDepth = 0;
parentPort.on('message', (msg) => {
    try {
        switch (msg.op) {
            case 'exec': {
                db.exec(msg.sql);
                send(msg.id, true);
                break;
            }
            case 'all': {
                const stmt = db.prepare(msg.sql);
                const rows = stmt.all(...msg.params);
                send(msg.id, true, rows.map((r) => ({ ...r })));
                break;
            }
            case 'get': {
                const stmt = db.prepare(msg.sql);
                const row = stmt.get(...msg.params);
                send(msg.id, true, row ? { ...row } : undefined);
                break;
            }
            case 'run': {
                const stmt = db.prepare(msg.sql);
                const result = stmt.run(...msg.params);
                send(msg.id, true, {
                    changes: result.changes,
                    lastInsertRowid: result.lastInsertRowid,
                });
                break;
            }
            case 'txBegin': {
                if (txDepth === 0) {
                    db.exec('BEGIN');
                }
                else {
                    db.exec(`SAVEPOINT "sqlo_sp_${txDepth}"`);
                }
                txDepth++;
                send(msg.id, true);
                break;
            }
            case 'txCommit': {
                if (txDepth === 0) {
                    handleError(msg.id, new Error('txCommit without an open transaction.'));
                    break;
                }
                txDepth--;
                if (txDepth === 0) {
                    db.exec('COMMIT');
                }
                else {
                    db.exec(`RELEASE SAVEPOINT "sqlo_sp_${txDepth}"`);
                }
                send(msg.id, true);
                break;
            }
            case 'txRollback': {
                if (txDepth === 0) {
                    handleError(msg.id, new Error('txRollback without an open transaction.'));
                    break;
                }
                txDepth--;
                if (txDepth === 0) {
                    db.exec('ROLLBACK');
                }
                else {
                    db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${txDepth}"`);
                }
                send(msg.id, true);
                break;
            }
            case 'backup': {
                const stmt = db.prepare('VACUUM INTO ?');
                stmt.run(msg.sql);
                send(msg.id, true);
                break;
            }
            case 'close': {
                db.close();
                send(msg.id, true);
                parentPort.close();
                break;
            }
            default:
                send(msg.id, false, undefined, {
                    message: `Unknown operation: ${msg.op}`,
                    stack: undefined,
                    name: 'SqloWorkerError',
                    errcode: undefined,
                    errstr: undefined,
                });
        }
    }
    catch (err) {
        handleError(msg.id, err);
    }
});
//# sourceMappingURL=async-worker.js.map
