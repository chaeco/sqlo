import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

/**
 * Worker bootstrap for the async wrapper.
 *
 * Opens a DatabaseSync connection in the worker thread and processes
 * userland messages (exec, all, get, run, close) one at a time.
 */
function send(id, ok, data, error) {
    parentPort.postMessage({ id, ok, data, error });
}
function handleError(id, err) {
    const e = err instanceof Error ? err : new Error(String(err));
    send(id, false, undefined, {
        message: e.message,
        stack: e.stack,
        name: e.name,
    });
}
// ---------------------------------------------------------------------------
const config = workerData;
const db = new DatabaseSync(config.path, config.options ?? {});
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
                });
        }
    }
    catch (err) {
        handleError(msg.id, err);
    }
});
//# sourceMappingURL=async-worker.js.map
