/**
 * Schema and DDL generation tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tableDDL, columnDDL, indexDDLs, raw, sql } from '../src/index.ts';

describe('columnDDL', () => {
  it('emits type and simple constraints', () => {
    const ddl = columnDDL({ type: 'TEXT', notNull: true, unique: true });
    assert.equal(ddl, 'TEXT NOT NULL UNIQUE');
  });

  it('emits collate and default literal', () => {
    const ddl = columnDDL({ type: 'TEXT', collate: 'NOCASE', default: 'draft' });
    assert.equal(ddl, "TEXT COLLATE NOCASE DEFAULT 'draft'");
  });

  it('emits numeric / null defaults', () => {
    assert.equal(columnDDL({ type: 'INTEGER', default: 0 }), 'INTEGER DEFAULT 0');
    assert.equal(columnDDL({ type: 'INTEGER', default: null }), 'INTEGER DEFAULT NULL');
    assert.equal(columnDDL({ type: 'INTEGER', default: true }), 'INTEGER DEFAULT 1');
  });

  it('emits onUpdate references action', () => {
    const ddl = columnDDL({
      type: 'INTEGER',
      references: { table: 'users', column: 'id', onUpdate: 'CASCADE' },
    });
    assert.equal(ddl, 'INTEGER REFERENCES "users"("id") ON UPDATE CASCADE');
  });

  it('ignores comment metadata (SQLite has no column-comment syntax)', () => {
    const ddl = columnDDL({ type: 'TEXT', notNull: true, comment: 'display name' });
    assert.equal(ddl, 'TEXT NOT NULL');
  });

  it('rejects bound params in column CHECK', () => {
    assert.throws(
      () => columnDDL({ type: 'INTEGER', check: sql`a > ${0}` }),
      /cannot contain bound parameters/,
    );
  });

  it('rejects bound params in DEFAULT fragment', () => {
    assert.throws(
      () => columnDDL({ type: 'TEXT', default: sql`coalesce(${'x'})` }),
      /cannot contain bound parameters/,
    );
  });
});

describe('tableDDL', () => {
  it('creates simple table DDL', () => {
    const ddl = tableDDL({
      name: 'users',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        name: { type: 'TEXT', notNull: true },
        age: { type: 'INTEGER' },
      },
    });
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS "users"/);
    assert.match(ddl, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
    assert.match(ddl, /"name" TEXT NOT NULL/);
    assert.match(ddl, /"age" INTEGER/);
  });

  it('emits column-level CHECK', () => {
    const ddl = tableDDL({
      name: 'users',
      columns: {
        age: { type: 'INTEGER', check: raw('age >= 0') },
      },
    });
    assert.match(ddl, /CHECK \(age >= 0\)/);
  });

  it('emits table-level CHECK', () => {
    const ddl = tableDDL({
      name: 'users',
      columns: {
        a: { type: 'INTEGER' },
        b: { type: 'INTEGER' },
      },
      checks: [raw('a < b')],
    });
    assert.match(ddl, /CONSTRAINT "chk_users_0" CHECK \(a < b\)/);
  });

  it('emits references with actions', () => {
    const ddl = tableDDL({
      name: 'posts',
      columns: {
        userId: {
          type: 'INTEGER',
          references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
        },
      },
    });
    assert.match(
      ddl,
      /REFERENCES "users"\("id"\) ON DELETE CASCADE/,
    );
  });

  it('rejects bound params in CHECK', () => {
    assert.throws(
      () => tableDDL({
        name: 't',
        columns: { a: { type: 'INTEGER' } },
        checks: [sql`a > ${0}`],
      }),
      /cannot contain bound parameters/,
    );
  });

  it('ignores table-level comment metadata', () => {
    const ddl = tableDDL({
      name: 'users',
      comment: 'user accounts and profiles',
      columns: { id: { type: 'INTEGER', primaryKey: true } },
    });
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS "users"/);
    assert.ok(!ddl.includes('user accounts'));
  });
});

describe('indexDDLs', () => {
  it('generates CREATE INDEX statements', () => {
    const sqls = indexDDLs({
      name: 'users',
      columns: { email: { type: 'TEXT' }, name: { type: 'TEXT' } },
      indexes: [
        { name: 'idx_users_email', columns: ['email'], unique: true },
      ],
    });
    assert.equal(sqls.length, 1);
    assert.match(sqls[0]!, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email"/);
    assert.match(sqls[0]!, /ON "users" \("email"\)/);
  });

  it('handles descending columns and partial index', () => {
    const sqls = indexDDLs({
      name: 'users',
      columns: { name: { type: 'TEXT' }, active: { type: 'INTEGER' } },
      indexes: [
        {
          name: 'idx_partial',
          columns: [{ name: 'name', direction: 'DESC' }],
          where: raw('active = 1'),
        },
      ],
    });
    assert.match(sqls[0]!, /"name" DESC/);
    assert.match(sqls[0]!, /WHERE active = 1/);
  });

  it('returns [] when no indexes defined', () => {
    const sqls = indexDDLs({
      name: 'users',
      columns: { email: { type: 'TEXT' } },
    });
    assert.deepEqual(sqls, []);
  });
});

describe('table options', () => {
  it('appends STRICT and WITHOUT ROWID', () => {
    const ddl = tableDDL({
      name: 'kv',
      strict: true,
      withoutRowId: true,
      columns: {
        key: { type: 'TEXT', primaryKey: true },
        value: { type: 'TEXT' },
      },
    });
    assert.match(ddl, /\) STRICT WITHOUT ROWID$/);
  });
});