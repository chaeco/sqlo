import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo, isBusyError, isConstraintError, SQLITE } from '../src/index.ts';
import { DatabaseSync } from 'node:sqlite';

test('isBusyError() detects SQLITE_BUSY errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-err-'));
  const path = join(dir, 'busy.db');
  const db1 = new Sqlo({ path });
  db1.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db1.exec('BEGIN IMMEDIATE'); // hold the write lock

  const db2 = new Sqlo({ path });
  db2.exec('PRAGMA busy_timeout = 0');
  try {
    db2.exec('BEGIN IMMEDIATE');
    assert.fail('second writer should be busy');
  } catch (err) {
    assert.equal(isBusyError(err), true);
    assert.equal(isConstraintError(err), false);
  }
  db1.exec('ROLLBACK');
  db1.close();
  db2.close();
});

test('isConstraintError() detects UNIQUE violations', () => {
  const db = new Sqlo({ path: ':memory:' });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db.exec('INSERT INTO t (id) VALUES (1)');
  try {
    db.exec('INSERT INTO t (id) VALUES (1)');
    assert.fail('unique violation should throw');
  } catch (err) {
    assert.equal(isConstraintError(err), true);
    assert.equal(isBusyError(err), false);
  }
  db.close();
});

test('isBusyError() returns false for non-errors and unrelated errors', () => {
  assert.equal(isBusyError(null), false);
  assert.equal(isBusyError(undefined), false);
  assert.equal(isBusyError(new Error('boom')), false);
  assert.equal(isBusyError('locked'), false);
});

test('SQLITE result codes are exposed', () => {
  assert.equal(SQLITE.BUSY, 5);
  assert.equal(SQLITE.CONSTRAINT, 19);
});

test('transaction({ retry }) retries on busy and succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-retry-'));
  const path = join(dir, 'retry.db');
  const db = new Sqlo({ path });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

  // A competing connection that briefly holds the write lock.
  const raw2 = new DatabaseSync(path);

  let attempts = 0;
  const result = db.transaction(
    () => {
      attempts++;
      if (attempts === 1) {
        // First attempt: the other connection holds the lock.
        raw2.exec('BEGIN IMMEDIATE');
        db.exec('INSERT INTO t (v) VALUES (\'first\')'); // hits SQLITE_BUSY
      } else {
        // Retry: release the competing lock so this attempt succeeds.
        raw2.exec('ROLLBACK');
      }
      db.exec('INSERT INTO t (v) VALUES (\'ok\')');
      return 'done';
    },
    { retry: 5 },
  );

  assert.equal(result, 'done');
  assert.ok(attempts >= 2, `expected retry, got ${attempts} attempts`);
  // The failed first attempt rolled back; only the final commit persists.
  assert.equal(db.all('SELECT COUNT(*) AS c FROM t')[0]!.c, 1);
  db.close();
  raw2.close();
});

test('transaction() without retry propagates busy immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-retry-'));
  const path = join(dir, 'noretry.db');
  const db = new Sqlo({ path });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const raw2 = new DatabaseSync(path);
  raw2.exec('BEGIN IMMEDIATE'); // competing connection holds the lock
  db.exec('PRAGMA busy_timeout = 0');

  assert.throws(
    () => db.transaction(() => db.exec('INSERT INTO t DEFAULT VALUES')),
    /locked|busy/i,
  );
  raw2.exec('ROLLBACK');
  db.close();
  raw2.close();
});

test('nested transactions are never retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-retry-'));
  const path = join(dir, 'nested.db');
  const db = new Sqlo({ path });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');

  let innerCalls = 0;
  db.transaction(() => {
    try {
      db.transaction(
        () => {
          innerCalls++;
          // Simulate a busy error inside the nested transaction.
          throw Object.assign(new Error('database is locked'), { errcode: 5 });
        },
        { retry: 3 },
      );
    } catch {
      // expected
    }
  });
  assert.equal(innerCalls, 1, 'nested transaction must not be retried');
  db.close();
});

test('isBusyError() message fallback matches only the SQLITE_BUSY text', () => {
  // SQLITE_LOCKED surfaces as "table X is locked" — without an errcode we
  // must not classify it as BUSY.
  assert.equal(isBusyError(new Error('table users is locked')), false);
  assert.equal(isBusyError(new Error('database is locked')), true);
});
