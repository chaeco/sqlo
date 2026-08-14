/**
 * Schema introspection tests — read actual table structure from the DB.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './helpers.ts';
import { Sqlo, reflectTableSchema, schemaDiff } from '../src/index.ts';

let db: ReturnType<typeof createDb>;

beforeEach(() => {
  db = createDb();
});

describe('reflectTableSchema', () => {
  it('reflects columns, types, nullability, defaults, primary keys', () => {
    db.exec(
      'CREATE TABLE users (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'name TEXT NOT NULL, ' +
      'age INTEGER DEFAULT 0, ' +
      'email TEXT' +
      ')',
    );
    const schema = reflectTableSchema(db, 'users');
    assert.equal(schema.name, 'users');
    assert.deepEqual(schema.columns.id, { type: 'INTEGER', primaryKey: true, autoIncrement: true });
    assert.deepEqual(schema.columns.name, { type: 'TEXT', notNull: true });
    assert.deepEqual(schema.columns.age, { type: 'INTEGER', default: 0 });
  });

  it('reflects UNIQUE constraints as column-level unique', () => {
    db.exec('CREATE TABLE t (a INTEGER, b TEXT UNIQUE)');
    const schema = reflectTableSchema(db, 't');
    assert.equal(schema.columns.b?.unique, true);
    // Implicit unique index must not leak into the indexes list.
    assert.ok(!schema.indexes?.some((i) => i.name.startsWith('sqlite_autoindex')));
  });

  it('reflects explicit indexes (unique + columns)', () => {
    db.exec('CREATE TABLE t (a INTEGER, b TEXT UNIQUE)');
    db.exec('CREATE INDEX idx_t_a ON t (a)');
    db.exec('CREATE UNIQUE INDEX idx_t_b ON t (b)');
    const schema = reflectTableSchema(db, 't');
    // b TEXT UNIQUE is a column-level constraint → reflected as column.unique.
    assert.equal(schema.columns.b?.unique, true);
    // Explicit indexes are listed (order by PRAGMA seq).
    const idxNames = schema.indexes?.map((i) => i.name).sort();
    assert.deepEqual(idxNames, ['idx_t_a', 'idx_t_b']);
    const uniqueIdx = schema.indexes?.find((i) => i.name === 'idx_t_b');
    assert.equal(uniqueIdx?.unique, true);
    assert.deepEqual(uniqueIdx?.columns, ['b']);
  });

  it('reflects strict / withoutRowId from CREATE TABLE SQL', () => {
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID');
    db.exec('CREATE TABLE st (a INTEGER PRIMARY KEY, b TEXT) STRICT');
    assert.equal(reflectTableSchema(db, 'kv').withoutRowId, true);
    assert.equal(reflectTableSchema(db, 'st').strict, true);
  });

  it('throws for a missing table', () => {
    assert.throws(() => reflectTableSchema(db, 'nope'), /does not exist/);
  });

  it('produces a zero-diff schema against an identical code schema', () => {
    db.exec(
      'CREATE TABLE users (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'name TEXT NOT NULL, ' +
      'email TEXT UNIQUE' +
      ')',
    );
    db.exec('CREATE INDEX idx_users_name ON users (name)');
    const actual = reflectTableSchema(db, 'users');
    const desired = {
      name: 'users',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        name: { type: 'TEXT', notNull: true },
        email: { type: 'TEXT', unique: true },
      },
      indexes: [{ name: 'idx_users_name', columns: ['name'] }],
    };
    const diff = schemaDiff(actual, desired);
    assert.deepEqual(diff.addedColumns, []);
    assert.deepEqual(diff.removedColumns, []);
    assert.deepEqual(diff.changedColumns, []);
    assert.deepEqual(diff.warnings, []);
  });

  it('detects missing columns when the DB is older than the code schema', () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const actual = reflectTableSchema(db, 'users');
    const desired = {
      name: 'users',
      columns: {
        id: { type: 'INTEGER', primaryKey: true },
        name: { type: 'TEXT', notNull: true },
        email: { type: 'TEXT' },
      },
    };
    const diff = schemaDiff(actual, desired);
    assert.deepEqual(diff.addedColumns, ['email']);
    assert.ok(diff.statements.some((s) => s.includes('ADD COLUMN "email"')));
  });
});

describe('foreign keys default-enabled', () => {
  it('CASCADE fires without explicit PRAGMA', () => {
    const local = new Sqlo({ path: ':memory:' });
    const users = local.define({
      name: 'users',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true } },
    });
    const posts = local.define({
      name: 'posts',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        userId: {
          type: 'INTEGER',
          notNull: true,
          references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
        },
      },
    });
    users.sync();
    posts.sync();
    const u = users.insert({});
    posts.insert({ userId: u.id });
    users.delete({ id: u.id });
    assert.equal(posts.count(), 0);
    local.close();
  });

  it('PRAGMA foreign_keys is 1 by default', () => {
    const row = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    assert.equal(row?.foreign_keys, 1);
  });

  it('warns when references exist but enforcement is explicitly disabled', () => {
    const warnings: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = (w: string | Error) => warnings.push(typeof w === 'string' ? w : w.message);
    try {
      const local = new Sqlo({ path: ':memory:', enableForeignKeyConstraints: false });
      local.define({
        name: 't',
        columns: {
          id: { type: 'INTEGER', primaryKey: true },
          ref: { type: 'INTEGER', references: { table: 'other', column: 'id' } },
        },
      });
      local.close();
    } finally {
      process.emitWarning = original;
    }
    assert.ok(warnings.some((w) => w.includes('foreign key enforcement disabled')));
  });
});
