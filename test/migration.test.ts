/**
 * Migration tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from './helpers.ts';
import { loadMigrations, loadMigrationsSync, type MigrationDef } from '../src/index.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlo-mig-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('applies pending migrations in order and records them', () => {
    const db = createDb();
    const migrations: MigrationDef[] = [
      { name: '001_create_users', up: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)' },
      { name: '002_add_email', up: 'ALTER TABLE users ADD COLUMN email TEXT' },
    ];
    const applied = db.migrate(migrations);
    assert.deepEqual(applied.map((m) => m.name), ['001_create_users', '002_add_email']);

    const status = db.migrationStatus(migrations);
    assert.ok(status.every((s) => s.appliedAt !== null));

    // Re-running does nothing
    const again = db.migrate(migrations);
    assert.equal(again.length, 0);
  });

  it('supports programmatic up functions', () => {
    const db = createDb();
    const migrations: MigrationDef[] = [
      {
        name: '001_fn',
        up: ({ exec }) => {
          exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)');
          exec('INSERT INTO foo (id) VALUES (1)');
        },
      },
    ];
    db.migrate(migrations);
    const rows = db.all<{ id: number }>('SELECT id FROM foo');
    assert.deepEqual(rows, [{ id: 1 }]);
  });

  it('keeps successfully-applied migrations on a later failure (per-migration tx)', () => {
    const db = createDb();
    const migrations: MigrationDef[] = [
      {
        name: '001_ok',
        up: 'CREATE TABLE ok (id INTEGER PRIMARY KEY)',
      },
      {
        name: '002_fail',
        up: 'THIS IS NOT VALID SQL',
      },
    ];
    assert.throws(() => db.migrate(migrations), /002_fail/);
    // 001 committed independently, so it is recorded and the table exists
    const status = db.migrationStatus(migrations);
    assert.ok(status[0]!.appliedAt !== null);
    assert.equal(status[1]!.appliedAt, null);
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'ok'",
    );
    assert.equal(tables.length, 1);
  });

  it('applies migrations in the given order', () => {
    const db = createDb();
    const migrations: MigrationDef[] = [
      { name: '01_first', up: 'CREATE TABLE first (id INTEGER PRIMARY KEY)' },
      { name: '10_second', up: 'ALTER TABLE first ADD COLUMN second TEXT' },
    ];
    // migrate() does not reorder — the caller is responsible for ordering.
    db.migrate(migrations);
    const cols = db.all<{ name: string }>('PRAGMA table_info(first)');
    assert.deepEqual(cols.map((c) => c.name), ['id', 'second']);
  });

  it('can run inside an outer transaction (nested via savepoint)', () => {
    const db = createDb();
    db.exec('CREATE TABLE outer_t (id INTEGER PRIMARY KEY)');
    // migrate() inside a transaction must not throw "cannot start a
    // transaction within a transaction" — it nests via savepoint.
    assert.throws(
      () => {
        db.transaction(() => {
          db.run('INSERT INTO outer_t (id) VALUES (?)', 1);
          const applied = db.migrate([
            { name: 'nested_mig', up: 'CREATE TABLE inner_t (id INTEGER PRIMARY KEY)' },
          ]);
          assert.deepEqual(applied.map((m) => m.name), ['nested_mig']);
          // Roll back the outer transaction entirely.
          throw new Error('rollback outer');
        });
      },
      /rollback outer/,
    );
    // Outer rollback removed both the row and the nested migration's table.
    assert.equal(db.all('SELECT id FROM outer_t').length, 0);
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'inner_t'",
    );
    assert.equal(tables.length, 0);
  });
});

describe('loadMigrationsSync', () => {
  it('loads .sql files in sorted order', () => {
    writeFileSync(join(tmpDir, '10_second.sql'), 'ALTER TABLE x ADD COLUMN b INTEGER');
    writeFileSync(join(tmpDir, '01_first.sql'), 'CREATE TABLE x (a INTEGER)');
    const migrations = loadMigrationsSync(tmpDir);
    assert.deepEqual(
      migrations.map((m) => m.name),
      ['01_first', '10_second'],
    );
    assert.equal(migrations[0]!.up, 'CREATE TABLE x (a INTEGER)');
  });

  it('throws on .mjs in sync loader', () => {
    writeFileSync(join(tmpDir, 'm.mjs'), 'export default { name: "m", up: "" };');
    assert.throws(() => loadMigrationsSync(tmpDir), /\.mjs/);
  });
});

describe('loadMigrations (async)', () => {
  it('loads .sql and .mjs migrations', async () => {
    writeFileSync(join(tmpDir, '01_first.sql'), 'CREATE TABLE x (a INTEGER)');
    writeFileSync(
      join(tmpDir, '02_fn.mjs'),
      'export default { name: "02_fn", up: () => {} };',
    );
    const migrations = await loadMigrations(tmpDir);
    assert.deepEqual(
      migrations.map((m) => m.name),
      ['01_first', '02_fn'],
    );
    assert.equal(migrations[0]!.up, 'CREATE TABLE x (a INTEGER)');
  });

  it('loads an array export from a .js migration', async () => {
    writeFileSync(
      join(tmpDir, 'pair.cjs'),
      'module.exports = [' +
        '{ name: "a", up: () => {} },' +
        '{ name: "b", up: () => {} }' +
        '];',
    );
    const migrations = await loadMigrations(tmpDir);
    assert.deepEqual(
      migrations.map((m) => m.name),
      ['a', 'b'],
    );
  });

  it('returns empty list for an empty directory', async () => {
    const migrations = await loadMigrations(tmpDir);
    assert.deepEqual(migrations, []);
  });
});