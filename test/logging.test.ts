import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo } from '../src/index.ts';
import type { LogEntry } from '../src/core/logging.ts';
import { DatabaseSync } from 'node:sqlite';

function collect(opts: { level?: 'debug' | 'info' | 'warn' | 'error' } = {}) {
  const entries: LogEntry[] = [];
  const db = new Sqlo({
    path: ':memory:',
    onLog: (e) => entries.push(e),
    logLevel: opts.level ?? 'info',
  });
  return { db, entries };
}

test('query events carry SQL, params and duration', () => {
  const { db, entries } = collect();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.all('SELECT * FROM t WHERE v = ?', 'hello');

  const q = entries.filter((e) => e.event === 'query' && e.sql?.includes('SELECT'));
  assert.ok(q.length >= 1, 'query event emitted');
  const sel = q.find((e) => e.sql!.includes('WHERE v = ?')) ?? q[0]!;
  assert.equal(sel.sql!.includes('SELECT * FROM t WHERE v = ?'), true);
  assert.deepEqual(sel.params, ['hello']);
  assert.equal(typeof sel.durationMs, 'number');
});

test('all params are exposed verbatim (sensitive data included)', () => {
  const { db, entries } = collect();
  const blob = new Uint8Array([1, 2, 3, 4]);
  const long = 'x'.repeat(2000);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB, s TEXT)');
  db.run('INSERT INTO t (b, s) VALUES (?, ?)', blob, long);

  const q = entries.find((e) => e.event === 'query' && e.sql!.startsWith('INSERT'));
  assert.ok(q, 'run event emitted');
  assert.equal(q!.params![0], blob, 'BLOB param exposed verbatim');
  assert.equal(q!.params![1], long, 'long string exposed verbatim');
});

test('transaction lifecycle events (BEGIN/COMMIT/ROLLBACK/SAVEPOINT)', () => {
  const { db, entries } = collect();
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db.transaction(() => {
    db.exec('INSERT INTO t DEFAULT VALUES');
  });
  assert.throws(() =>
    db.transaction(() => {
      throw new Error('boom');
    }),
  );
  // nested
  db.transaction(() => {
    db.transaction(() => {});
  });

  const tx = entries.filter((e) => e.event === 'transaction');
  const msgs = tx.map((e) => e.message);
  assert.ok(msgs.includes('BEGIN transaction'));
  assert.ok(msgs.includes('COMMIT transaction'));
  assert.ok(msgs.includes('ROLLBACK transaction'));
  assert.ok(msgs.some((m) => m.startsWith('BEGIN SAVEPOINT')));
  assert.ok(msgs.some((m) => m.startsWith('RELEASE SAVEPOINT')));
});

test('connection and schema events are emitted', () => {
  const { db, entries } = collect();
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-log-'));
  db.attach(join(dir, 'aux.db'), 'aux');
  const users = db.define({
    name: 'users',
    columns: { id: { type: 'INTEGER', primaryKey: true } },
  });
  users.sync();
  db.detach('aux');
  db.close();

  const events = entries.map((e) => e.event);
  assert.ok(events.includes('connection'), 'connection events');
  assert.ok(events.includes('schema'), 'schema events');
  assert.ok(entries.some((e) => e.message.includes('ATTACH database')));
  assert.ok(entries.some((e) => e.message.includes('DETACH database')));
  assert.ok(entries.some((e) => e.message.includes('define model')));
  assert.ok(entries.some((e) => e.message.includes('close database')));
});

test('logLevel filters entries (warn default: only warn+error)', () => {
  const entries: LogEntry[] = [];
  const db = new Sqlo({
    path: ':memory:',
    onLog: (e) => entries.push(e),
    // default logLevel is 'warn'
  });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db.all('SELECT * FROM t');
  db.close();

  assert.equal(entries.length, 0, 'default warn level filters info query events');
});

test('logLevel: debug emits everything', () => {
  const { db, entries } = collect({ level: 'debug' });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  assert.ok(entries.some((e) => e.event === 'query'));
  db.close();
});

test('retry logs warn on busy contention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-log-'));
  const path = join(dir, 'retry.db');
  const entries: LogEntry[] = [];
  const db = new Sqlo({ path, onLog: (e) => entries.push(e), logLevel: 'debug' });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const raw2 = new DatabaseSync(path);

  let attempts = 0;
  db.transaction(
    () => {
      attempts++;
      if (attempts === 1) {
        raw2.exec('BEGIN IMMEDIATE');
        db.exec('INSERT INTO t DEFAULT VALUES'); // busy
      } else {
        raw2.exec('ROLLBACK');
      }
      db.exec('INSERT INTO t DEFAULT VALUES');
    },
    { retry: 3 },
  );
  const warn = entries.filter((e) => e.level === 'warn');
  assert.ok(warn.some((e) => e.message.includes('retry transaction')), 'retry warning logged');
  db.close();
  raw2.close();
});

test('user log handler throwing never breaks the operation', () => {
  const db = new Sqlo({
    path: ':memory:',
    onLog: () => {
      throw new Error('log handler exploded');
    },
  });
  // Must not throw despite the log handler throwing.
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db.all('SELECT * FROM t');
  db.close();
});

test('migrate events are logged', () => {
  const { db, entries } = collect();
  db.migrate([
    { name: '001_create', up: 'CREATE TABLE t (id INTEGER PRIMARY KEY)' },
  ]);
  db.migrate([]); // no pending
  const mig = entries.filter((e) => e.event === 'migrate');
  assert.ok(mig.some((e) => e.message.includes('applied migration "001_create"')));
  assert.ok(mig.some((e) => e.message.includes('no pending migrations')));
  db.close();
});

test('onLog re-entrancy is blocked (no infinite recursion)', () => {
  // An onLog callback that performs its own database operations must not
  // recursively trigger new log events ("nothing beyond the framework's
  // authority"). Depth stays bounded; events complete.
  let depth = 0;
  let maxDepth = 0;
  let events = 0;
  const db = new Sqlo({
    path: ':memory:',
    logLevel: 'debug',
    onLog: () => {
      events++;
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      db.exec('SELECT 1'); // would recurse infinitely without the guard
      depth--;
    },
  });
  db.all('SELECT 1');
  db.close();
  assert.ok(maxDepth <= 2, `log depth must stay bounded, got ${maxDepth}`);
  assert.ok(events >= 1, 'events still emitted');
});

