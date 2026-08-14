/**
 * Worker bootstrap for the async wrapper.
 *
 * Opens a DatabaseSync connection in the worker thread and processes
 * userland messages (exec, all, get, run, close) one at a time.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

interface WorkerConfig {
  path: string;
  options?: Record<string, unknown>;
}

interface WorkerRequest {
  id: number;
  op: 'exec' | 'all' | 'get' | 'run' | 'close';
  sql: string;
  params: unknown[];
}

type SQLInputValue = number | bigint | string | Uint8Array | null;

function send(id: number, ok: boolean, data?: unknown, error?: { message: string; stack: string | undefined; name: string | undefined }): void {
  parentPort!.postMessage({ id, ok, data, error });
}

function handleError(id: number, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  send(id, false, undefined, {
    message: e.message,
    stack: e.stack,
    name: e.name,
  });
}

// ---------------------------------------------------------------------------

const config: WorkerConfig = workerData as WorkerConfig;
const db = new DatabaseSync(config.path, config.options ?? {});

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
        });
    }
  } catch (err) {
    handleError(msg.id, err);
  }
});