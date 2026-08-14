/**
 * AsyncSqlo tests — worker-thread based async wrapper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncSqlo } from '../src/index.ts';

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
});
