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