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

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

interface WorkerConfig {
  path: string;
  options?: Record<string, unknown>;
}

interface WorkerRequest {
  id: number;
  op:
    | 'exec'
    | 'all'
    | 'get'
    | 'run'
    | 'close'
    | 'txBegin'
    | 'txCommit'
    | 'txRollback'
    | 'backup';
  sql: string;
  params: unknown[];
}

type SQLInputValue = number | bigint | string | Uint8Array | null;

interface WorkerErrorPayload {
  message: string;
  stack: string | undefined;
  name: string | undefined;
  errcode: number | undefined;
  errstr: string | undefined;
}

function send(id: number, ok: boolean, data?: unknown, error?: WorkerErrorPayload): void {
  parentPort!.postMessage({ id, ok, data, error });
}

function handleError(id: number, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const sqliteErr = e as Error & { errcode?: number; errstr?: string };
  send(id, false, undefined, {
    message: e.message,
    stack: e.stack,
    name: e.name,
    errcode: typeof sqliteErr.errcode === 'number' ? sqliteErr.errcode : undefined,
    errstr: typeof sqliteErr.errstr === 'string' ? sqliteErr.errstr : undefined,
  });
}

// ---------------------------------------------------------------------------

const config: WorkerConfig = workerData as WorkerConfig;
const db = new DatabaseSync(config.path, config.options ?? {});

// Transaction nesting depth, owned by the worker. 0 = no transaction open.
// >0 = inside a transaction; the worker decides BEGIN vs SAVEPOINT based on
// whether this is the top-level entry.
let txDepth = 0;

parentPort!.on('message', (msg: WorkerRequest) => {
  try {
    switch (msg.op) {
      case 'exec': {
        db.exec(msg.sql);
        send(msg.id, true);
        break;
      }
      case 'all': {
        const stmt = db.prepare(msg.sql);
        const rows = stmt.all(...msg.params as SQLInputValue[]) as Record<string, unknown>[];
        send(msg.id, true, rows.map((r) => ({ ...r })));
        break;
      }
      case 'get': {
        const stmt = db.prepare(msg.sql);
        const row = stmt.get(...msg.params as SQLInputValue[]) as Record<string, unknown> | undefined;
        send(msg.id, true, row ? { ...row } : undefined);
        break;
      }
      case 'run': {
        const stmt = db.prepare(msg.sql);
        const result = stmt.run(...msg.params as SQLInputValue[]);
        send(msg.id, true, {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        });
        break;
      }
      case 'txBegin': {
        if (txDepth === 0) {
          db.exec('BEGIN');
        } else {
          db.exec(`SAVEPOINT "sqlo_sp_${txDepth}"`);
        }
        txDepth++;
        send(msg.id, true);
        break;
      }
      case 'txCommit': {
        txDepth--;
        if (txDepth === 0) {
          db.exec('COMMIT');
        } else {
          db.exec(`RELEASE SAVEPOINT "sqlo_sp_${txDepth}"`);
        }
        send(msg.id, true);
        break;
      }
      case 'txRollback': {
        txDepth--;
        if (txDepth === 0) {
          db.exec('ROLLBACK');
        } else {
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
        parentPort!.close();
        break;
      }
      default:
        send(msg.id, false, undefined, {
          message: `Unknown operation: ${(msg as { op: string }).op}`,
          stack: undefined,
          name: 'SqloWorkerError',
          errcode: undefined,
          errstr: undefined,
        });
    }
  } catch (err) {
    handleError(msg.id, err);
  }
});
