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
test('open: false defers opening; open() activates and reopens the connection', () => {
  const dbPath = join(tmpdir(), `sqlo-openflag-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const db = new Sqlo({ path: dbPath, open: false });
  assert.throws(() => db.all('SELECT 1'), /not open/);

  db.open();
  db.exec('CREATE TABLE t (id INTEGER)');
  db.run('INSERT INTO t (id) VALUES (1)');
  db.close();

  // close() then open() reopens at the constructor path; file data persists.
  db.open();
  assert.equal(db.all('SELECT * FROM t').length, 1);
  db.open(); // idempotent on an already-open connection
  assert.equal(db.all('SELECT * FROM t').length, 1);
  db.close();
  rmSync(dbPath, { force: true });
});

test('enableDoubleQuotedStringLiterals passes through to node:sqlite', () => {
  const on = new Sqlo({ path: ':memory:', enableDoubleQuotedStringLiterals: true });
  assert.equal(on.get('SELECT "hello" AS v')!.v, 'hello');
  on.close();

  const off = new Sqlo({ path: ':memory:' });
  assert.throws(() => off.get('SELECT "hello" AS v'), /no such column/i);
  off.close();
});
