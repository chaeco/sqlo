/**
 * AsyncSqlo tests — worker-thread based async wrapper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncSqlo, sql as sf, type AsyncExecutor } from '../src/index.ts';

describe('AsyncSqlo', () => {
  it('exec / run / all / get roundtrip', async (t) => {
    const db = new AsyncSqlo(':memory:');
    t.after(() => db.close());

    await db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
    const r = await db.run('INSERT INTO t (id, name) VALUES (?, ?)', 1, 'alice');
    assert.equal(Number(r.changes), 1);

    const rows = await db.all<{ id: number; name: string }>('SELECT * FROM t');
    // Worker path also normalizes rows to plain objects.
    assert.deepEqual(rows, [{ id: 1, name: 'alice' }]);

    const row = await db.get<{ id: number; name: string }>('SELECT * FROM t WHERE id = ?', 1);
    assert.deepEqual(row, { id: 1, name: 'alice' });

    const missing = await db.get('SELECT * FROM t WHERE id = ?', 999);
    assert.equal(missing, undefined);
  });

  it('rejects with the underlying SQL error message', async (t) => {
    const db = new AsyncSqlo(':memory:');
    t.after(() => db.close());

    await assert.rejects(
      () => db.exec('THIS IS NOT VALID SQL'),
      /syntax error/i,
    );
  });

  it('rejects on runtime SQL errors (unknown column)', async (t) => {
    const db = new AsyncSqlo(':memory:');
    t.after(() => db.close());

    await db.exec('CREATE TABLE t (id INTEGER)');
    await assert.rejects(
      () => db.run('INSERT INTO t (nope) VALUES (?)', 1),
      /no column named/i,
    );
  });

  it('runs several operations sequentially on the worker', async (t) => {
    const db = new AsyncSqlo(':memory:');
    t.after(() => db.close());

    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await db.run('INSERT INTO t (id, name) VALUES (?, ?)', 1, 'a');
    await db.run('INSERT INTO t (id, name) VALUES (?, ?)', 2, 'b');
    const rows = await db.all<{ id: number }>('SELECT id FROM t ORDER BY id');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });

  it('terminate() stops the worker and subsequent operations reject', async () => {
    const db = new AsyncSqlo(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER)');

    // terminate is synchronous and returns no value.
    assert.equal(db.terminate(), undefined);

    // terminate() marks the instance dead immediately: the next op fails fast
    // with a clear error instead of posting into the void and hanging.
    await assert.rejects(() => db.exec('SELECT 1'), /terminated/);
  });

  it('applies journalMode in the worker (parity with sync Sqlo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-async-journal-'));
    const db = new AsyncSqlo(join(dir, 'db.sqlite'), { journalMode: 'WAL' });
    try {
      const mode = (await db.get('PRAGMA journal_mode')) as { journal_mode: string };
      assert.equal(mode.journal_mode, 'wal');
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AsyncModel.insertMany rejects non-positive chunkSize', async () => {
    const db = new AsyncSqlo(':memory:');
    try {
      const m = db.define({
        name: 'chunk_rows',
        columns: {
          id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
          name: { type: 'TEXT' },
        },
      });
      await m.sync();
      await assert.rejects(
        () => m.insertMany([{ name: 'a' }, { name: 'b' }], { chunkSize: 0 }),
        /chunkSize must be a positive integer/,
      );
      await assert.rejects(
        () => m.insertMany([{ name: 'a' }], { chunkSize: -3 }),
        /chunkSize must be a positive integer/,
      );
      // Nothing was inserted by the failed calls.
      assert.equal(await m.count(), 0);
    } finally {
      await db.close();
    }
  });
});

describe('AsyncSqlo real-world semantics', () => {
  it('db-bound model ops awaited inside a transaction join it (no deadlock)', async () => {
    const db = new AsyncSqlo(':memory:');
    const m = db.define({
      name: 'tx_join',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, tag: { type: 'TEXT' } },
    });
    await m.sync();

    // A db-bound (non tx.model) awaited call used to deadlock the FIFO lane.
    await assert.rejects(
      () => db.transaction(async () => {
        await m.insert({ tag: 'kept' });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await m.count(), 0, 'the insert joined the transaction and rolled back with it');

    await db.transaction(async () => {
      await m.insert({ tag: 'ok' });
    });
    assert.equal(await m.count(), 1);
    await db.close();
  });

  it('nested db.transaction() calls do not deadlock (SAVEPOINT)', async () => {
    const db = new AsyncSqlo(':memory:');
    const m = db.define({
      name: 'tx_nested',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true } },
    });
    await m.sync();

    await db.transaction(async () => {
      await m.insert({});
      await db.transaction(async () => {
        await m.insert({});
        throw new Error('inner-rollback');
      }).catch((e: Error) => assert.match(e.message, /inner-rollback/));
    });
    assert.equal(await m.count(), 1, 'inner savepoint rolled back, outer committed');
    await db.close();
  });

  it('count() returns a plain number even with readBigInts', async () => {
    const db = new AsyncSqlo(':memory:', { readBigInts: true });
    const m = db.define({
      name: 'bigint_count',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true } },
    });
    await m.sync();
    await m.insertMany([{}, {}, {}]);
    const n = await m.count();
    assert.equal(typeof n, 'number');
    assert.equal(n, 3);
    await db.close();
  });
});

describe('AsyncSqlo options and builder parity', () => {
  it('applies busyTimeout PRAGMA in the worker', async () => {
    const db = new AsyncSqlo(':memory:', { busyTimeout: 1234 });
    try {
      // PRAGMA busy_timeout reports its column as "timeout".
      const row = (await db.get('PRAGMA busy_timeout')) as { timeout: number };
      assert.equal(row.timeout, 1234);
    } finally {
      await db.close();
    }
  });

  it('explicit busyTimeout: undefined falls back to the 5000ms default (parity with sync Sqlo)', async () => {
    // A spread like { ...defaults, busyTimeout: possiblyUndefined } must not
    // punch the default out — the worker would silently land on SQLite's raw
    // default (0, fail-fast) while the sync Sqlo applies 5000ms.
    const db = new AsyncSqlo(':memory:', { busyTimeout: undefined });
    try {
      const row = (await db.get('PRAGMA busy_timeout')) as { timeout: number };
      assert.equal(row.timeout, 5000);
    } finally {
      await db.close();
    }
  });

  it('omitted busyTimeout falls back to the 5000ms default', async () => {
    const db = new AsyncSqlo(':memory:');
    try {
      const row = (await db.get('PRAGMA busy_timeout')) as { timeout: number };
      assert.equal(row.timeout, 5000);
    } finally {
      await db.close();
    }
  });

  it('busyTimeout: 0 keeps the raw fail-fast behaviour (explicit zero wins)', async () => {
    const db = new AsyncSqlo(':memory:', { busyTimeout: 0 });
    try {
      const row = (await db.get('PRAGMA busy_timeout')) as { timeout: number };
      assert.equal(row.timeout, 0);
    } finally {
      await db.close();
    }
  });

  it('AsyncQueryBuilder.raw() accepts strings and fragments', async () => {
    const db = new AsyncSqlo(':memory:');
    const m = db.define({
      name: 'raw_qb',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, age: { type: 'INTEGER' } },
    });
    await m.sync();
    await m.insertMany([{ age: 20 }, { age: 2 }]);
    assert.equal((await m.query().raw('age > 10').all()).length, 1);
    assert.equal((await m.query().raw(sf`age < ${10}`).all()).length, 1);
    await db.close();
  });

  it('define() emits schema warnings', async () => {
    const db = new AsyncSqlo(':memory:');
    const original = process.emitWarning;
    const warnings: string[] = [];
    process.emitWarning = (w: string | Error) => warnings.push(typeof w === 'string' ? w : w.message);
    try {
      db.define({ name: 'warn_t', columns: { note: { type: 'UUID' } } });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /non-standard type/);
    } finally {
      process.emitWarning = original;
      await db.close();
    }
  });

  it('sync() creates declared indexes', async () => {
    const db = new AsyncSqlo(':memory:');
    const m = db.define({
      name: 'idx_t',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, email: { type: 'TEXT' } },
      indexes: [{ name: 'idx_async_email', columns: ['email'] }],
    });
    await m.sync();
    const idx = await db.all('PRAGMA index_list("idx_t")');
    assert.ok(idx.some((r) => (r as { name: string }).name === 'idx_async_email'));
    await db.close();
  });

  it('AsyncModel.all() is an alias for findAll()', async () => {
    const db = new AsyncSqlo(':memory:');
    const m = db.define({
      name: 'alias_t',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true } },
    });
    await m.sync();
    await m.insertMany([{}, {}, {}]);
    assert.equal((await m.all()).length, 3);
    await db.close();
  });

  it('terminating mid-transaction fails the rollback path but preserves the original error', async () => {
    const db = new AsyncSqlo(':memory:');
    await db.exec('CREATE TABLE mid_tx (id INTEGER)');
    await assert.rejects(
      () => db.transaction(async (tx) => {
        await tx.run('INSERT INTO mid_tx (id) VALUES (1)');
        db.terminate();
        throw new Error('user-error');
      }),
      /user-error/,
    );
  });

  it('AsyncModel.insertMany works without a transaction-capable executor', async () => {
    const db = new AsyncSqlo(':memory:');
    const m = db.define({
      name: 'notx_t',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true } },
    });
    await m.sync();
    const notx = m.withExecutor({
      all: (sql: string, ...params: unknown[]) => db.all(sql, ...params),
      get: (sql: string, ...params: unknown[]) => db.get(sql, ...params),
      run: (sql: string, ...params: unknown[]) => db.run(sql, ...params),
      exec: (sql: string) => db.exec(sql),
    } as unknown as AsyncExecutor);
    assert.equal((await notx.insertMany([{}, {}])).length, 2, 'single batch, no tx');
    assert.equal((await notx.insertMany([{}, {}], { chunkSize: 1 })).length, 2, 'chunked, no tx');
    assert.equal(await m.count(), 4);
    await db.close();
  });
});
