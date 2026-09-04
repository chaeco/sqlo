/**
 * Model CRUD + Sqlo core tests against an in‑memory database.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, userSchema, postSchema } from './helpers.ts';
import { Model, Sqlo, sql } from '../src/index.ts';
import type { RowOf, InsertOf, PatchOf } from '../src/index.ts';

type Users = Model<RowOf<typeof userSchema>, InsertOf<typeof userSchema>, PatchOf<typeof userSchema>>;
type Posts = Model<RowOf<typeof postSchema>, InsertOf<typeof postSchema>, PatchOf<typeof postSchema>>;

let users: Users;
let posts: Posts;
let db: ReturnType<typeof createDb>;

beforeEach(() => {
  db = createDb();
  users = db.define(userSchema);
  posts = db.define(postSchema);
  db.syncAll();
});

describe('Sqlo core', () => {
  it('runs raw SQL through raw() and sql helpers', () => {
    const raw = db.raw();
    raw.exec('CREATE TABLE IF NOT EXISTS t_raw (id INTEGER)');
    raw.prepare('INSERT INTO t_raw (id) VALUES (?)').run(1);
    const rows = raw.prepare('SELECT * FROM t_raw').all() as { id: number }[];
    // raw() returns the underlying DatabaseSync; its rows have null prototype.
    // Spread to plain objects for comparison.
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: 1 }]);
  });

  it('exec / all / get / run', () => {
    db.exec('CREATE TABLE IF NOT EXISTS t_ex (id INTEGER, name TEXT)');
    const result = db.run('INSERT INTO t_ex (id, name) VALUES (?, ?)', 1, 'a');
    assert.equal(Number(result.changes), 1);
    const row = db.get<{ id: number; name: string }>('SELECT * FROM t_ex WHERE id = ?', 1);
    assert.deepEqual(row, { id: 1, name: 'a' });
    const all = db.all<{ id: number }>('SELECT id FROM t_ex');
    assert.deepEqual(all, [{ id: 1 }]);
  });

  it('throws when operating on a closed database', () => {
    db.close();
    assert.throws(() => db.exec('SELECT 1'), /closed/);
  });

  it('rolls back on thrown transaction', () => {
    db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY)');
    assert.throws(() => {
      db.transaction(() => {
        db.run('INSERT INTO t_tx (id) VALUES (?)', 1);
        throw new Error('boom');
      });
    }, /boom/);
    const rows = db.all<{ id: number }>('SELECT id FROM t_tx');
    assert.equal(rows.length, 0);
  });

  it('commits when transaction succeeds', () => {
    db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY)');
    db.transaction(() => {
      db.run('INSERT INTO t_tx (id) VALUES (?)', 1);
    });
    const rows = db.all<{ id: number }>('SELECT id FROM t_tx');
    assert.deepEqual(rows, [{ id: 1 }]);
  });

  it('supports nested transactions with savepoints', () => {
    db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY)');
    db.transaction(() => {
      db.run('INSERT INTO t_tx (id) VALUES (?)', 1);
      db.transaction(() => {
        db.run('INSERT INTO t_tx (id) VALUES (?)', 2);
      });
    });
    const rows = db.all<{ id: number }>('SELECT id FROM t_tx ORDER BY id');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });
});

describe('Model CRUD', () => {
  it('inserts and returns the inserted row', () => {
    const row = users.insert({ name: 'alice', email: 'a@x.io', age: 30 });
    assert.equal(typeof row.id, 'number');
    assert.equal(row.name, 'alice');
    assert.equal(row.age, 30);
  });

  it('handles null as insertion value', () => {
    const row = users.insert({ name: 'bob', email: 'b@x.io', age: null });
    assert.equal(typeof row.id, 'number');
    assert.ok(row.age === null);
  });

  it('findById returns the inserted row', () => {
    const row = users.insert({ name: 'alice', email: 'a@x.io', age: 30 });
    const found = users.findById(row.id)!;
    assert.equal(found.name, 'alice');
    assert.equal(found.email, 'a@x.io');
    assert.equal(found.age, 30);
  });

  it('findById returns undefined for missing row', () => {
    assert.equal(users.findById(999), undefined);
  });

  it('findOne works with non-primary keys', () => {
    users.insert({ name: 'alice', email: 'a@x.io' });
    const row = users.findOne({ email: 'a@x.io' })!;
    assert.equal(row.name, 'alice');
  });

  it('findAll with where, order, limit', () => {
    users.insert({ name: 'a', email: 'a@x.io', age: 10 });
    users.insert({ name: 'b', email: 'b@x.io', age: 20 });
    users.insert({ name: 'c', email: 'c@x.io', age: 30 });
    const rows = users
      .query()
      .where({ age: { gte: 20 } })
      .orderBy('age', 'DESC')
      .limit(10)
      .all();
    assert.deepEqual(
      rows.map((r) => r.name),
      ['c', 'b'],
    );
  });

  it('all returns every row', () => {
    users.insert({ name: 'a', email: 'a@x.io' });
    users.insert({ name: 'b', email: 'b@x.io' });
    const rows = users.all();
    assert.equal(rows.length, 2);
  });

  it('count returns row count', () => {
    users.insert({ name: 'a', email: 'a@x.io' });
    users.insert({ name: 'b', email: 'b@x.io' });
    assert.equal(users.count(), 2);
    assert.equal(users.count({ age: { isNull: true } }), 2);
    assert.equal(users.count({ age: { gte: 1 } }), 0);
  });

  it('exists returns boolean', () => {
    users.insert({ name: 'a', email: 'a@x.io' });
    assert.equal(users.exists({ name: 'a' }), true);
    assert.equal(users.exists({ name: 'zzz' }), false);
  });

  it('update changes rows and returns affected count', () => {
    const row = users.insert({ name: 'a', email: 'a@x.io', age: 10 });
    const n = users.update({ age: 11 }, { id: row.id });
    assert.equal(n, 1);
    const updated = users.findById(row.id)!;
    assert.equal(updated.age, 11);
  });

  it('update requires a where condition', () => {
    users.insert({ name: 'a', email: 'a@x.io' });
    assert.throws(() => users.update({ age: 11 }, {}), /requires a WHERE/i);
  });

  it('update with an empty patch returns 0 without touching rows', () => {
    const row = users.insert({ name: 'a', email: 'a@x.io', age: 10 });
    const n = users.update({} as never, { id: row.id });
    assert.equal(n, 0);
    const unchanged = users.findById(row.id)!;
    assert.equal(unchanged.age, 10);
  });

  it('delete removes matching rows', () => {
    const row = users.insert({ name: 'a', email: 'a@x.io' });
    assert.equal(users.delete({ id: row.id }), 1);
    assert.equal(users.findById(row.id), undefined);
  });

  it('delete throws without a where clause', () => {
    assert.throws(() => users.delete({}), /requires a WHERE/i);
  });

  it('sync creates tables and indexes with IF NOT EXISTS (idempotent)', () => {
    users.sync();
    users.sync();
    const rows = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('users'));
    assert.ok(names.includes('posts'));
  });

  it('applies foreign key cascade through raw SQL', () => {
    // Enable FK enforcement
    db.exec('PRAGMA foreign_keys = ON');
    // Insert a user then a post referencing it
    const user = users.insert({ name: 'fk', email: 'fk@x.io' });
    posts.insert({ userId: user.id, title: 'hello' });
    users.delete({ id: user.id });
    const remaining = posts.query().all();
    assert.equal(remaining.length, 0);
  });

  it('insertMany inserts multiple rows', () => {
    const rows = users.insertMany([
      { name: 'a', email: 'a@x.io' },
      { name: 'b', email: 'b@x.io' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(users.count(), 2);
  });

  it('insertMany with empty array returns []', () => {
    assert.deepEqual(users.insertMany([]), []);
  });

  it('insertMany is atomic — NOT NULL violation rolls back all', () => {
    const badModel = db.define({
      name: 'strict_t',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        v: { type: 'TEXT', notNull: true },
      },
    });
    badModel.sync();
    assert.throws(
      () => badModel.insertMany([{ v: 'ok' }, { v: null as never }, { v: 'never' }]),
      /NOT NULL/i,
    );
    // Nothing partially written
    assert.equal(badModel.count(), 0);
  });

  it('insertMany participates in an outer transaction rollback', () => {
    const before = users.count();
    assert.throws(() => {
      db.transaction(() => {
        users.insertMany([{ name: 'a', email: 'a@x.io' }, { name: 'b', email: 'b@x.io' }]);
        throw new Error('outer rollback');
      });
    }, /outer rollback/);
    assert.equal(users.count(), before);
  });

  it('throws on unknown columns when inserting', () => {
    assert.throws(
      () => users.insert({ name: 'x', email: 'x@x.io', bogus: 1 } as never),
      /Unknown column "bogus"/,
    );
  });

  it('allows a column literally named "comment" (metadata name vs column name)', () => {
    const t = db.define({
      name: 'notes',
      columns: {
        // A column may share the `comment` metadata field name.
        comment: { type: 'TEXT', notNull: true, comment: 'a column named comment' },
      },
    });
    t.sync();
    t.insert({ comment: 'hello' });
    const rows = t.all();
    assert.equal(rows[0]?.comment, 'hello');
  });

  it('throws on undefined primary key table findById', () => {
    const tagModel = db.define({
      name: 'tags',
      columns: {
        label: { type: 'TEXT', notNull: true },
      },
    });
    tagModel.sync();
    assert.throws(
      () => tagModel.findById(1),
      /has no primary key column/,
    );
  });

  it('supports WITHOUT ROWID tables', () => {
    const kv = db.define({
      name: 'kv',
      withoutRowId: true,
      columns: {
        key: { type: 'TEXT', primaryKey: true },
        value: { type: 'TEXT', notNull: true },
      },
    });
    kv.sync();
    const row = kv.insert({ key: 'k1', value: 'v1' });
    assert.equal(row.key, 'k1');
    // String PKs go through findOne (findById is typed for number | bigint).
    const found = kv.findOne({ key: 'k1' });
    assert.equal(found?.value, 'v1');
  });

  it('findById works with TEXT/UUID primary keys', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const model = db.define({
      name: 'uuid_t',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        name: { type: 'TEXT', notNull: true },
      },
    });
    model.sync();
    model.insert({ id: uuid, name: 'alice' });
    const found = model.findById(uuid);
    assert.equal(found?.name, 'alice');
    assert.equal(model.findById('nonexistent-uuid'), undefined);
  });
});

describe('Schema validation', () => {
  it('rejects invalid table names', () => {
    assert.throws(
      () => db.define({ name: 'bad name!', columns: { id: { type: 'INTEGER' } } }),
      /Invalid table name/,
    );
  });

  it('rejects empty columns', () => {
    assert.throws(
      () => db.define({ name: 't', columns: {} }),
      /At least one column is required/,
    );
  });

  it('rejects autoIncrement without INTEGER primaryKey', () => {
    assert.throws(
      () =>
        db.define({
          name: 't',
          columns: { id: { type: 'TEXT', primaryKey: true, autoIncrement: true } },
        }),
      /autoIncrement requires type INTEGER and primaryKey=true/,
    );
  });

  it('rejects column without type', () => {
    assert.throws(
      () => db.define({ name: 't', columns: { id: {} as never } }),
      /missing a "type"/,
    );
  });

  it('rejects bound params in column CHECK', () => {
    assert.throws(
      () =>
        db.define({
          name: 't',
          columns: {
            a: { type: 'INTEGER', check: sql`a > ${0}` },
          },
        }),
      /cannot contain bound parameters/,
    );
  });

  it('rejects unknown column in index', () => {
    assert.throws(
      () =>
        db.define({
          name: 't',
          columns: { a: { type: 'INTEGER' } },
          indexes: [{ name: 'idx', columns: ['nope'] }],
        }),
      /references unknown column "nope"/,
    );
  });
});

describe('Sqlo options', () => {
  it('readBigInts returns bigint for INTEGER values', () => {
    const bigDb = new Sqlo({ path: ':memory:', readBigInts: true });
    bigDb.exec('CREATE TABLE t (id INTEGER)');
    bigDb.run('INSERT INTO t (id) VALUES (?)', 9007199254740993n);
    const row = bigDb.get<{ id: unknown }>('SELECT id FROM t');
    assert.equal(row?.id, 9007199254740993n);
    bigDb.close();
  });

  it('supports string path shorthand', () => {
    const sDb = new Sqlo(':memory:');
    sDb.exec('CREATE TABLE t (id INTEGER)');
    const all = sDb.all('SELECT * FROM t');
    assert.deepEqual(all, []);
    sDb.close();
  });
});
describe('input robustness', () => {
  it('insertMany rejects non-positive chunkSize instead of hanging', () => {
    assert.throws(
      () => users.insertMany([{ name: 'a', email: 'a@x' }], { chunkSize: 0 }),
      /chunkSize must be a positive integer/,
    );
    assert.throws(
      () => users.insertMany([{ name: 'a', email: 'a@x' }], { chunkSize: -1 }),
      /chunkSize must be a positive integer/,
    );
    assert.throws(
      () => users.insertMany([{ name: 'a', email: 'a@x' }], { chunkSize: 1.5 }),
      /chunkSize must be a positive integer/,
    );
    // Nothing was inserted by the failed calls.
    assert.equal(users.count(), 0);
  });

  it('treats explicit undefined insert values as absent columns', () => {
    // Runtime JS callers can pass explicit undefined (exactOptionalPropertyTypes
    // forbids it in TS, so cast): it must be treated as "not provided".
    const data: Record<string, unknown> = { name: 'u', email: 'u@x', age: undefined };
    const row = users.insert(data as Parameters<typeof users.insert>[0]);
    assert.equal(row.age, null);
  });

  it('update skips undefined patch values (never binds them)', () => {
    const created = users.insert({ name: 'u', email: 'u@x', age: 30 });
    const changed = users.update({ age: undefined, name: 'renamed' }, { id: created.id });
    assert.equal(changed, 1);
    const after = users.findById(created.id);
    assert.equal(after!.name, 'renamed');
    assert.equal(after!.age, 30, 'undefined patch value must not touch the column');
  });

  it('update with only undefined values is a no-op returning 0', () => {
    const created = users.insert({ name: 'u', email: 'u@x', age: 30 });
    const changed = users.update({ age: undefined }, { id: created.id });
    assert.equal(changed, 0);
  });

  it('in/between operators reject invalid input with clear errors', () => {
    assert.throws(
      () => users.findAll({ age: { in: 'oops' as unknown as number[] } }),
      /Where operator "in" requires an array/,
    );
    assert.throws(
      () => users.findAll({ age: { between: [1] as unknown as [number, number] } }),
      /exactly 2 elements/,
    );
  });
});

describe('transaction misuse & binding edge cases', () => {
  it('transaction() rejects async callbacks instead of committing early', async () => {
    db.exec('CREATE TABLE tx_async (id INTEGER)');
    assert.throws(
      () => db.transaction(async () => {
        db.run('INSERT INTO tx_async (id) VALUES (1)');
        await new Promise((r) => setTimeout(r, 10));
        db.run('INSERT INTO tx_async (id) VALUES (2)');
      }),
      /async callback/,
    );
    // The pre-await insert was rolled back with the transaction — the old
    // behaviour silently committed it.
    assert.equal(db.all('SELECT * FROM tx_async').length, 0);
    // Let the detached async continuation finish against this still-open db
    // (so it doesn't leak into the next test) and confirm it ran OUTSIDE the
    // transaction, in autocommit mode.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(db.all('SELECT * FROM tx_async').length, 1, 'post-await write ran outside the transaction');
  });

  it('binds booleans as 1/0', () => {
    db.exec('CREATE TABLE bools (id INTEGER PRIMARY KEY, flag INTEGER)');
    db.run('INSERT INTO bools (id, flag) VALUES (?, ?)', 1, true);
    assert.equal(db.get('SELECT flag FROM bools WHERE id = 1')!.flag, 1);
    assert.equal(db.all('SELECT id FROM bools WHERE flag = ?', true).length, 1);
    assert.equal(db.all('SELECT id FROM bools WHERE flag = ?', false).length, 0);
  });

  it('model insert/update accept booleans on BOOLEAN-typed columns', () => {
    const boolModel = db.define({
      name: 'bool_rows',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        flag: { type: 'BOOLEAN' },
      },
    });
    boolModel.sync();
    const row = boolModel.insert({ flag: true as unknown as number });
    assert.equal(row.flag, 1);
    boolModel.update({ flag: false as unknown as number }, { id: row.id });
    assert.equal(boolModel.findById(row.id)!.flag, 0);
  });
});

describe('insertMany without transaction support', () => {
  function bareExecutor() {
    // An Executor without `transaction` — Model must fall back to plain inserts.
    return { prepare: (stmt: string) => db.prepare(stmt) };
  }

  it('inserts a single batch without a transaction-capable executor', () => {
    const plain = new Model(bareExecutor(), userSchema);
    const rows = plain.insertMany([
      { name: 'n1', email: 'n1@x' },
      { name: 'n2', email: 'n2@x' },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(users.count(), 2);
  });

  it('chunks without a transaction-capable executor', () => {
    const plain = new Model(bareExecutor(), userSchema);
    const rows = plain.insertMany(
      [1, 2, 3].map((i) => ({ name: `c${i}`, email: `c${i}@x` })),
      { chunkSize: 2 },
    );
    assert.equal(rows.length, 3);
    assert.equal(users.count(), 3);
  });
});

describe('define() validation error branches', () => {
  it('rejects duplicate index names', () => {
    assert.throws(
      () => db.define({
        name: 'dup_idx',
        columns: { id: { type: 'INTEGER' } },
        indexes: [
          { name: 'ix', columns: ['id'] },
          { name: 'ix', columns: ['id'] },
        ],
      }),
      /Duplicate index name/,
    );
  });

  it('rejects indexes with no columns', () => {
    assert.throws(
      () => db.define({
        name: 'empty_idx',
        columns: { id: { type: 'INTEGER' } },
        indexes: [{ name: 'ix', columns: [] }],
      }),
      /has no columns/,
    );
  });

  it('rejects invalid foreign-key actions', () => {
    assert.throws(
      () => db.define({
        name: 'bad_ref',
        columns: {
          id: { type: 'INTEGER' },
          otherId: {
            type: 'INTEGER',
            references: { table: 'other', column: 'id', onDelete: 'EXPLODE' as unknown as 'CASCADE' },
          },
        },
      }),
      /invalid onDelete/,
    );
  });

  it('rejects parameterized partial-index WHERE at define time', () => {
    assert.throws(
      () => db.define({
        name: 'param_idx',
        columns: { id: { type: 'INTEGER' }, flag: { type: 'INTEGER' } },
        indexes: [{ name: 'ix', columns: ['id'], where: sql`flag = ${1}` }],
      }),
      /WHERE clause cannot contain bound parameters/,
    );
  });
});
