import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo } from '../src/index.ts';

test('journalMode: WAL is applied on file databases and persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-jm-'));
  const dbPath = join(dir, 'test.db');
  try {
    const db = new Sqlo({ path: dbPath, journalMode: 'WAL' });
    assert.equal(db.raw().prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    db.close();

    // WAL persists in the database header across connections
    const reopened = new Sqlo({ path: dbPath });
    assert.equal(reopened.raw().prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journalMode: WAL on :memory: is a harmless no-op', () => {
  const db = new Sqlo({ path: ':memory:', journalMode: 'WAL' });
  // In-memory databases always use memory journaling
  assert.equal(db.raw().prepare('PRAGMA journal_mode').get()?.journal_mode, 'memory');
  db.close();
});

test('journalMode: default (omitted) leaves SQLite default untouched', () => {
  const db = new Sqlo({ path: ':memory:' });
  assert.equal(db.raw().prepare('PRAGMA journal_mode').get()?.journal_mode, 'memory');
  db.close();
});

test('journalMode: DELETE mode is a no-op (SQLite default)', () => {
  const db = new Sqlo({ path: ':memory:', journalMode: 'DELETE' });
  assert.equal(db.raw().prepare('PRAGMA journal_mode').get()?.journal_mode, 'memory');
  db.close();
});

test('busyTimeout sets PRAGMA busy_timeout on open', () => {
  const db = new Sqlo({ path: ':memory:', busyTimeout: 2500 });
  assert.equal(db.raw().prepare('PRAGMA busy_timeout').get()?.timeout, 2500);
  db.close();
});

test('define rejects a missing table name', () => {
  const db = new Sqlo({ path: ':memory:' });
  assert.throws(
    () => db.define({ name: '', columns: { id: { type: 'INTEGER' } } }),
    /Table name is required/,
  );
  db.close();
});

test('define rejects an invalid table name', () => {
  const db = new Sqlo({ path: ':memory:' });
  assert.throws(
    () => db.define({ name: 'bad name!', columns: { id: { type: 'INTEGER' } } }),
    /Invalid table name/,
  );
  db.close();
});

test('define rejects a schema with no columns', () => {
  const db = new Sqlo({ path: ':memory:' });
  assert.throws(
    () => db.define({ name: 'empty', columns: {} }),
    /At least one column is required/,
  );
  db.close();
});

test('prepare returns a statement handle with all / get / run', () => {
  const db = new Sqlo({ path: ':memory:' });
  try {
    db.exec('CREATE TABLE t_prep (id INTEGER PRIMARY KEY, name TEXT)');

    const ins = db.prepare('INSERT INTO t_prep (name) VALUES (?)');
    const r1 = ins.run('a');
    const r2 = ins.run('b');
    assert.equal(Number(r1.changes), 1);
    assert.equal(Number(r2.changes), 1);

    const sel = db.prepare('SELECT * FROM t_prep ORDER BY id');
    assert.deepEqual(sel.all(), [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);

    const one = db.prepare('SELECT * FROM t_prep WHERE id = ?').get(2);
    assert.deepEqual(one, { id: 2, name: 'b' });

    const missing = db.prepare('SELECT * FROM t_prep WHERE id = ?').get(99);
    assert.equal(missing, undefined);
  } finally {
    db.close();
  }
});