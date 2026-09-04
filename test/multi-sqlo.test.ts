/**
 * MultiSqlo — per-user database isolation tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiSqlo, Sqlo, type MultiSqloOptions } from '../src/index.ts';

let dir: string;
let pool: MultiSqlo;
const baseline: MultiSqloOptions['migrations'] = [
  { name: '001_users', up: 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)' },
  { name: '002_posts', up: 'CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL, title TEXT NOT NULL)' },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlo-tenant-'));
  pool = new MultiSqlo({ dir, migrations: baseline });
});

afterEach(() => {
  pool.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('MultiSqlo', () => {
  it('creates and migrates a new user database on first access', () => {
    const db = pool.for('alice');
    const users = db.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, name: { type: 'TEXT', notNull: true } },
    });
    assert.equal(users.count(), 0); // baseline migration applied
    users.insert({ name: 'alice' });
    assert.equal(users.count(), 1);
    // One file on disk per user.
    assert.deepEqual(readdirSync(dir).sort(), ['alice.db']);
  });

  it('isolates data between users', () => {
    const a = pool.for('alice');
    const aUsers = a.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, name: { type: 'TEXT', notNull: true } },
    });
    aUsers.insert({ name: 'from-alice' });

    const b = pool.for('bob');
    const bUsers = b.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, name: { type: 'TEXT', notNull: true } },
    });
    assert.equal(bUsers.count(), 0); // bob sees none of alice's rows
    assert.equal(readdirSync(dir).sort().length, 2); // two files
  });

  it('caches instances and reuses them', () => {
    const first = pool.for('alice');
    const second = pool.for('alice');
    assert.equal(first, second);
    assert.equal(pool.has('alice'), true);
    assert.equal(pool.size, 1);
  });

  it('does not re-migrate an existing database on reopen', () => {
    const db = pool.for('alice');
    const users = db.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, name: { type: 'TEXT', notNull: true } },
    });
    users.insert({ name: 'persisted' });

    // Close and reopen — data must survive, no duplicate migration failure.
    pool.close('alice');
    const reopened = pool.for('alice');
    const reopenedUsers = reopened.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, name: { type: 'TEXT', notNull: true } },
    });
    assert.equal(reopenedUsers.count(), 1);
  });

  it('close / closeAll manage the cache', () => {
    pool.for('alice');
    pool.for('bob');
    assert.equal(pool.size, 2);

    pool.close('alice');
    assert.equal(pool.has('alice'), false);
    assert.equal(pool.has('bob'), true);

    pool.closeAll();
    assert.equal(pool.size, 0);
    assert.equal(pool.has('bob'), false);
  });

  it('applies per-instance connection options', () => {
    const p2 = new MultiSqlo({ dir, options: { enableForeignKeyConstraints: false } });
    const db = p2.for('opts-user');
    const row = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    assert.equal(row?.foreign_keys, 0);
    p2.closeAll();
  });

  it('supports a custom file name strategy', () => {
    const p2 = new MultiSqlo({
      dir,
      fileName: (userId) => `tenant_${userId}.sqlite`,
    });
    const db = p2.for('x');
    const users = db.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, name: { type: 'TEXT', notNull: true } },
    });
    users.sync();
    assert.ok(readdirSync(dir).includes('tenant_x.sqlite'));
    p2.closeAll();
  });
});

describe('MultiSqlo security', () => {
  it('rejects path-traversal and unsafe user ids', () => {
    for (const bad of ['../../etc/passwd', '../x', 'a/b', 'a\\b', '..', '.', 'a b', '']) {
      assert.throws(
        () => pool.for(bad),
        /Invalid userId/,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  it('rejects a fileName strategy that escapes the directory', () => {
    const p2 = new MultiSqlo({ dir, fileName: () => '../escape.db' });
    assert.throws(() => p2.for('u'), /plain file name/);
  });

  it('accepts safe user ids', () => {
    for (const ok of ['user-1', 'user_2', 'a.b', 'UPPER', 'x9']) {
      assert.doesNotThrow(() => pool.for(ok), `should accept ${ok}`);
    }
  });
});

describe('MultiSqlo crash recovery', () => {
  it('migrates a database file a crashed run left behind before migration', () => {
    // Simulate a crash between "file created" and "baseline migrated":
    // the file exists, but no version table / migrations were applied.
    const crashed = new Sqlo({ path: join(dir, 'carol.db') });
    crashed.close();

    const db = pool.for('carol');
    assert.ok(db.tableExists('users'), 'baseline migration applied despite pre-existing file');
    assert.ok(db.tableExists('posts'));
  });

  it('does not duplicate migration records on repeated access', () => {
    pool.for('dave');
    const again = pool.for('dave'); // cached, but even a fresh open is idempotent
    assert.deepEqual(again.migrationStatus(baseline).map((s) => s.appliedAt !== null), [true, true]);
  });
});

describe('MultiSqlo input validation', () => {
  it('rejects unsafe userIds', () => {
    assert.throws(() => pool.for('../evil'), /Invalid userId/);
    assert.throws(() => pool.for('.hidden'), /Invalid userId/);
    assert.throws(() => pool.for('a/b'), /Invalid userId/);
    assert.throws(() => pool.for(''), /Invalid userId/);
    // Nothing was created for the rejected ids.
    assert.equal(pool.size, 0);
  });

  it('rejects fileName strategies that escape the directory', () => {
    assert.throws(
      () => new MultiSqlo({ dir, fileName: () => '../escape.db' }).for('alice'),
      /plain file name/,
    );
    assert.throws(
      () => new MultiSqlo({ dir, fileName: () => 'sub/x.db' }).for('alice'),
      /plain file name/,
    );
    assert.throws(
      () => new MultiSqlo({ dir, fileName: () => '.' }).for('alice'),
      /plain file name/,
    );
  });
});
