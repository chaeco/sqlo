/**
 * AsyncModel / AsyncQueryBuilder / AsyncSqlo tests — worker-thread wrapper.
 *
 * Covers the async ORM layer: define/sync, CRUD, query builder, transactions
 * (commit / rollback / nesting / busy retry), migrations, backup, and error
 * classification across the worker boundary (errcode preservation).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AsyncSqlo, isBusyError, isConstraintError, sql as sf, raw } from '../src/index.ts';
import type { AsyncModel, RowOf, InsertOf, PatchOf } from '../src/index.ts';
import { userSchema, postSchema } from './helpers.ts';

type Users = AsyncModel<RowOf<typeof userSchema>, InsertOf<typeof userSchema>, PatchOf<typeof userSchema>>;
type Posts = AsyncModel<RowOf<typeof postSchema>, InsertOf<typeof postSchema>, PatchOf<typeof postSchema>>;

let db: AsyncSqlo;
let users: Users;
let posts: Posts;

function tmpFile(prefix: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { file: join(dir, 'db.sqlite'), dir };
}

beforeEach(async () => {
  db = new AsyncSqlo(':memory:');
  users = db.define(userSchema);
  posts = db.define(postSchema);
  await db.syncAll();
});

// Close the per-test worker after each test — a leaked Worker keeps the
// process alive and node:test reports it as a hanging file-level test.
afterEach(async () => {
  await db.close();
});

describe('AsyncModel CRUD', () => {
  it('insert returns the full row with generated id', async () => {
    const row = await users.insert({ name: 'alice', email: 'a@x.io' } as never);
    assert.equal(typeof row.id, 'number');
    assert.equal(row.name, 'alice');
    assert.equal(row.email, 'a@x.io');
  });

  it('findById / findOne / findAll', async () => {
    const a = await users.insert({ name: 'alice', email: 'a@x.io' } as never);
    const b = await users.insert({ name: 'bob', email: 'b@x.io' } as never);

    const found = await users.findById(a.id);
    assert.equal(found?.name, 'alice');

    const one = await users.findOne({ name: 'bob' });
    assert.equal(one?.id, b.id);

    const all = await users.findAll({ active: 1 });
    assert.equal(all.length, 2);

    const missing = await users.findById(9999);
    assert.equal(missing, undefined);
  });

  it('update returns affected count and applies the patch', async () => {
    const a = await users.insert({ name: 'alice', email: 'a@x.io' } as never);
    const n = await users.update({ age: 30 } as never, { id: a.id });
    assert.equal(n, 1);
    const after = await users.findById(a.id);
    assert.equal(after?.age, 30);
  });

  it('update requires a WHERE clause', async () => {
    await users.insert({ name: 'alice', email: 'a@x.io' } as never);
    await assert.rejects(
      () => users.update({ age: 1 } as never, {}),
      /requires a WHERE condition/,
    );
  });

  it('delete removes matching rows', async () => {
    const a = await users.insert({ name: 'alice', email: 'a@x.io' } as never);
    await users.insert({ name: 'bob', email: 'b@x.io' } as never);
    const n = await users.delete({ id: a.id });
    assert.equal(n, 1);
    assert.equal(await users.count(), 1);
  });

  it('deleteAll clears the table', async () => {
    await users.insertMany([{ name: 'a', email: 'a@x.io' }, { name: 'b', email: 'b@x.io' }] as never);
    const n = await users.deleteAll();
    assert.equal(n, 2);
    assert.equal(await users.count(), 0);
  });

  it('count / exists', async () => {
    await users.insert({ name: 'alice', email: 'a@x.io' } as never);
    assert.equal(await users.count(), 1);
    assert.equal(await users.count({ name: 'nobody' }), 0);
    assert.equal(await users.exists({ name: 'alice' }), true);
    assert.equal(await users.exists({ name: 'nobody' }), false);
  });

  it('insertMany inserts all rows atomically', async () => {
    const rows = await users.insertMany([
      { name: 'a', email: 'a@x.io' },
      { name: 'b', email: 'b@x.io' },
      { name: 'c', email: 'c@x.io' },
    ] as never);
    assert.equal(rows.length, 3);
    assert.equal(await users.count(), 3);
  });

  it('insertMany with chunkSize commits each chunk', async () => {
    const rows = await users.insertMany(
      [{ name: 'a', email: 'a@x.io' }, { name: 'b', email: 'b@x.io' }, { name: 'c', email: 'c@x.io' }] as never,
      { chunkSize: 2 },
    );
    assert.equal(rows.length, 3);
    assert.equal(await users.count(), 3);
  });

  it('rejects unknown columns on insert and update', async () => {
    await assert.rejects(
      () => users.insert({ name: 'x', email: 'x@x.io', bogus: 1 } as never),
      /Unknown column "bogus"/,
    );
    await assert.rejects(
      () => users.update({ bogus: 1 } as never, { id: 1 }),
      /Unknown column "bogus"/,
    );
  });

  it('update with an empty patch returns 0', async () => {
    const inserted = await users.insert({ name: 'a', email: 'a@x.io' } as never);
    const id = (inserted as { id: number }).id;
    assert.equal(await users.update({} as never, { id }), 0);
    const row = await users.findById(id);
    assert.equal(row?.name, 'a');
  });

  it('delete requires a WHERE condition', async () => {
    await assert.rejects(
      () => users.delete({} as never),
      /delete\(\) requires a WHERE/,
    );
  });

  it('findById rejects on a table without a primary key', async () => {
    const tagModel = db.define({
      name: 'tags',
      columns: {
        label: { type: 'TEXT', notNull: true },
      },
    });
    await tagModel.sync();
    await assert.rejects(
      () => tagModel.findById(1),
      /has no primary key column/,
    );
  });

  it('insertMany with an empty array returns []', async () => {
    assert.deepEqual(await users.insertMany([]), []);
  });

  it('insertMany rolls back the whole batch on NOT NULL violation', async () => {
    const strict = db.define({
      name: 'strict_t',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        v: { type: 'TEXT', notNull: true },
      },
    });
    await strict.sync();
    await assert.rejects(
      () => strict.insertMany([{ v: 'ok' }, { v: null as never }, { v: 'never' }] as never),
      /NOT NULL/i,
    );
    // Nothing partially written — the whole batch is one transaction.
    assert.equal(await strict.count(), 0);
  });
});

describe('AsyncModel with foreign keys / references', () => {
  it('rejects inserts violating FK when enforcement is on (default)', async () => {
    await assert.rejects(
      () => posts.insert({ userId: 9999, title: 'orphan' } as never),
      /foreign key constraint/i,
    );
  });
});

describe('AsyncQueryBuilder', () => {
  beforeEach(async () => {
    await users.insertMany([
      { name: 'alice', email: 'a@x.io', age: 30, active: 1 },
      { name: 'bob', email: 'b@x.io', age: 25, active: 1 },
      { name: 'carol', email: 'c@x.io', age: 30, active: 0 },
    ] as never);
  });

  it('where / orderBy / limit / offset', async () => {
    const qb = users.query();
    const rows = await qb.where({ active: 1 }).orderBy('age', 'DESC').all();
    assert.deepEqual(
      rows.map((r) => r.name),
      ['alice', 'bob'],
    );

    const paged = await users.query().orderBy('id', 'ASC').limit(2).offset(1).all();
    assert.deepEqual(
      paged.map((r) => r.name),
      ['bob', 'carol'],
    );
  });

  it('first / count / pluck terminal methods', async () => {
    const first = await users.query().where({ active: 1 }).orderBy('age', 'ASC').first();
    assert.equal(first?.name, 'bob');

    const count = await users.query().where({ active: 1 }).count();
    assert.equal(count, 2);

    const names = await users.query().orderBy('name', 'ASC').pluck('name');
    assert.deepEqual(names, ['alice', 'bob', 'carol']);
  });

  it('toSql / buildWhere are pure and synchronous', () => {
    const qb = users.query();
    qb.where({ active: 1 });
    const { sql, params } = qb.toSql();
    assert.match(sql, /FROM "users"/);
    assert.deepEqual(params, [1]);

    const w = qb.buildWhere();
    assert.match(w.clause, /WHERE/);
  });

  it('groupBy / having', async () => {
    const rows = await users
      .query()
      .select('age')
      .groupBy('age')
      .having({ age: 30 })
      .all();
    assert.deepEqual(
      rows.map((r) => r.age),
      [30],
    );
  });

  it('applies joins (left / inner / right / full)', () => {
    const qb = users.query();
    qb.leftJoin('posts', sf`"posts"."userId" = "users"."id"`);
    const { sql, params } = qb.toSql();
    assert.match(sql, /LEFT JOIN "posts" ON "posts"\."userId" = "users"\."id"/);
    assert.deepEqual(params, []);

    const inner = users.query();
    inner.join('posts', sf`"posts"."userId" = "users"."id"`);
    assert.match(inner.toSql().sql, /JOIN "posts" ON/);

    const right = users.query();
    right.rightJoin('likes', sf`"likes"."userId" = "users"."id"`);
    assert.match(right.toSql().sql, /RIGHT JOIN "likes" ON/);

    const full = users.query();
    full.fullJoin('tags', sf`"tags"."id" = "users"."id"`);
    assert.match(full.toSql().sql, /FULL JOIN "tags" ON/);
  });

  it('distinct() emits SELECT DISTINCT', async () => {
    const qb = users.query();
    qb.distinct().select('name', 'age');
    const { sql } = qb.toSql();
    assert.equal(sql, 'SELECT DISTINCT "name", "age" FROM "users"');

    // Executed: de-duplicated rows.
    const ages = await users.query().distinct().select('age').orderBy('age', 'ASC').all();
    assert.deepEqual(
      ages.map((r) => r.age),
      [25, 30],
    );
  });

  it('orWhere combines conditions with OR', async () => {
    const rows = await users
      .query()
      .where({ active: 1 })
      .orWhere({ age: 30 })
      .orderBy('name', 'ASC')
      .all();
    // active: alice, bob; or age 30: alice, carol — union is alice, bob, carol.
    assert.deepEqual(
      rows.map((r) => r.name),
      ['alice', 'bob', 'carol'],
    );
  });

  it('raw () appends an unbound SQL predicate', async () => {
    const qb = users.query();
    qb.where(raw('LENGTH(name) > 4'));
    const { sql, params } = qb.toSql();
    assert.match(sql, /LENGTH\(name\) > 4/);
    assert.deepEqual(params, []);

    const rows = await users.query().where(raw('LENGTH(name) > 4')).all();
    assert.deepEqual(
      rows.map((r) => r.name).sort(),
      ['alice', 'carol'],
    );
  });
});

describe('AsyncSqlo transactions', () => {
  it('commits when the callback succeeds', async () => {
    await db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY, v TEXT)');
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t_tx (id, v) VALUES (?, ?)', 1, 'x');
    });
    const rows = await db.all<{ id: number }>('SELECT id FROM t_tx');
    assert.deepEqual(rows, [{ id: 1 }]);
  });

  it('rolls back when the callback throws', async () => {
    await db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY, v TEXT)');
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.run('INSERT INTO t_tx (id, v) VALUES (?, ?)', 1, 'x');
          throw new Error('boom');
        }),
      /boom/,
    );
    const rows = await db.all<{ id: number }>('SELECT id FROM t_tx');
    assert.equal(rows.length, 0);
  });

  it('supports nested transactions with savepoints via the handle', async () => {
    await db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY, v TEXT)');
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t_tx (id, v) VALUES (?, ?)', 1, 'outer');
      await tx.transaction(async (inner) => {
        await inner.run('INSERT INTO t_tx (id, v) VALUES (?, ?)', 2, 'inner');
      });
    });
    const rows = await db.all<{ id: number }>('SELECT id FROM t_tx ORDER BY id');
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  });

  it('inner rollback only rolls back the inner savepoint', async () => {
    await db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY, v TEXT)');
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t_tx (id, v) VALUES (?, ?)', 1, 'keep');
      await assert.rejects(
        () =>
          tx.transaction(async (inner) => {
            await inner.run('INSERT INTO t_tx (id, v) VALUES (?, ?)', 2, 'drop');
            throw new Error('inner boom');
          }),
        /inner boom/,
      );
    });
    const rows = await db.all<{ id: number }>('SELECT id FROM t_tx ORDER BY id');
    assert.deepEqual(rows, [{ id: 1 }]);
  });

  it('lets tx.model() bind a model to the transaction', async () => {
    await db.exec('CREATE TABLE t_user (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE)');
    const u = db.define({
      name: 't_user',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        name: { type: 'TEXT', notNull: true },
        email: { type: 'TEXT', notNull: true },
      },
    });
    await u.sync();

    await db.transaction(async (tx) => {
      const tu = tx.model(u);
      await tu.insert({ name: 'alice', email: 'a@x.io' } as never);
      // The db-bound model must NOT be used inside the callback (it would
      // queue behind the running transaction); the handle-bound copy is the
      // supported path.
    });
    const rows = await db.all<{ name: string }>('SELECT name FROM t_user');
    assert.deepEqual(rows, [{ name: 'alice' }]);
  });

  it('insertMany inside a transaction shares the outer rollback', async () => {
    await db.exec(
      'CREATE TABLE t_strict (id INTEGER PRIMARY KEY, v TEXT NOT NULL)',
    );
    const m = db.define({
      name: 't_strict',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        v: { type: 'TEXT', notNull: true },
      },
    });
    await m.sync();

    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          const tm = tx.model(m);
          await tm.insertMany([{ v: 'ok' }, { v: 'also-ok' }] as never);
          throw new Error('boom-rollback');
        }),
      /boom-rollback/,
    );
    // The insertMany rows were part of the outer transaction and got rolled back.
    assert.equal(await m.count(), 0);
  });

  it('exhausts retries and still throws busy when the lock is never released', async () => {
    const { file, dir } = tmpFile('sqlo-async-retry-exhausted-');
    try {
      const setup = new AsyncSqlo(file);
      await setup.exec('CREATE TABLE t (id INTEGER, v TEXT)');
      await setup.close();

      const locker = new DatabaseSync(file);
      locker.exec('BEGIN EXCLUSIVE');

      let calls = 0;
      const retryDb = new AsyncSqlo(file);
      try {
        await assert.rejects(
          () =>
            retryDb.transaction(async (tx) => {
              calls++;
              await tx.run('INSERT INTO t (id, v) VALUES (?, ?)', 1, 'x');
            }, { retry: 2 }),
          (err: unknown) => {
            assert.equal(isBusyError(err), true, 'final failure should still be busy');
            return true;
          },
        );
        // 1 initial attempt + 2 retries — all blocked, exhausted.
        assert.equal(calls, 3);
      } finally {
        await retryDb.close();
        locker.exec('COMMIT');
        locker.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not retry non-busy errors', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          calls++;
          await tx.run('SELECT 1');
          throw new Error('boom');
        }, { retry: 5 }),
      /boom/,
    );
    // A non-busy error must propagate immediately — exactly one attempt.
    assert.equal(calls, 1);
  });

  it('never interleaves concurrent transactions (atomic blocks)', async () => {
    await db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY, v TEXT)');
    const results = await Promise.all([
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t_tx (v) VALUES (?)', 'a');
        // Give the sibling a real chance to run concurrently.
        await new Promise((r) => setTimeout(r, 30));
        await tx.run('INSERT INTO t_tx (v) VALUES (?)', 'b');
        return 'tx-a';
      }),
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t_tx (v) VALUES (?)', 'c');
        await new Promise((r) => setTimeout(r, 30));
        await tx.run('INSERT INTO t_tx (v) VALUES (?)', 'd');
        return 'tx-b';
      }),
    ]);
    assert.deepEqual(results, ['tx-a', 'tx-b']);
    // Each transaction must remain its own physical transaction. If they were
    // merged (the pre-serialization bug), the second would become a
    // SAVEPOINT of the first and a later rollback of the first would undo the
    // second's writes. Here both commit independently.
    const rows = await db.all<{ v: string }>('SELECT v FROM t_tx ORDER BY v');
    assert.deepEqual(rows, [{ v: 'a' }, { v: 'b' }, { v: 'c' }, { v: 'd' }]);
  });

  it('a plain op shared across the lane waits for the running transaction', async () => {
    await db.exec('CREATE TABLE t_tx (id INTEGER PRIMARY KEY, v TEXT)');
    // Fire two transactions and a plain op concurrently: the op must not land
    // inside either transaction — it waits until the lane is free.
    const op = db.run('INSERT INTO t_tx (v) VALUES (?)', 'op');
    const t1 = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t_tx (v) VALUES (?)', 'a');
    });
    const t2 = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t_tx (v) VALUES (?)', 'b');
    });
    await Promise.all([op, t1, t2]);
    const rows = await db.all<{ v: string }>('SELECT v FROM t_tx ORDER BY v');
    assert.deepEqual(rows, [{ v: 'a' }, { v: 'b' }, { v: 'op' }]);
  });

  it('propagates busy errors with errcode across the worker boundary', async () => {
    const { file, dir } = tmpFile('sqlo-async-busy-');
    try {
      // A separate connection holds the write lock (BEGIN EXCLUSIVE).
      const locker = new DatabaseSync(file);
      locker.exec('CREATE TABLE t (id INTEGER)');
      locker.exec('BEGIN EXCLUSIVE');

      const busyDb = new AsyncSqlo(file);
      try {
        await assert.rejects(
          () => busyDb.run('INSERT INTO t (id) VALUES (1)'),
          (err: unknown) => {
            assert.equal(isBusyError(err), true, 'worker error should classify as busy');
            assert.equal(isConstraintError(err), false);
            return true;
          },
        );
      } finally {
        await busyDb.close();
      }

      locker.exec('COMMIT');
      locker.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries a busy transaction and succeeds once the lock is released', async () => {
    const { file, dir } = tmpFile('sqlo-async-retry-');
    try {
      const setup = new AsyncSqlo(file);
      await setup.exec('CREATE TABLE t (id INTEGER, v TEXT)');
      await setup.close();

      const locker = new DatabaseSync(file);
      locker.exec('BEGIN EXCLUSIVE');

      // Release the lock shortly after the first attempt hits BUSY.
      const release = setTimeout(() => {
        locker.exec('COMMIT');
        locker.close();
      }, 120);

      const retryDb = new AsyncSqlo(file);
      try {
        await retryDb.transaction(async (tx) => {
          await tx.run('INSERT INTO t (id, v) VALUES (?, ?)', 1, 'x');
        }, { retry: 5 });
        // The write must have landed after the retry succeeded.
        const rows = await retryDb.all<{ v: string }>('SELECT v FROM t');
        assert.deepEqual(rows, [{ v: 'x' }]);
      } finally {
        clearTimeout(release);
        await retryDb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AsyncSqlo migrations', () => {
  it('applies pending migrations and records them', async () => {
    await db.exec('CREATE TABLE t1 (id INTEGER)');
    const applied = await db.migrate([
      { name: '0001_init', up: 'CREATE TABLE IF NOT EXISTS m1 (id INTEGER)' },
      { name: '0002_add', up: 'ALTER TABLE t1 ADD COLUMN extra TEXT' },
    ]);
    assert.deepEqual(
      applied.map((m) => m.name),
      ['0001_init', '0002_add'],
    );

    const status = await db.migrationStatus([
      { name: '0001_init', up: '' },
      { name: '0002_add', up: '' },
      { name: '0003_future', up: '' },
    ]);
    assert.deepEqual(
      status.map((s) => ({ name: s.name, applied: s.appliedAt !== null })),
      [
        { name: '0001_init', applied: true },
        { name: '0002_add', applied: true },
        { name: '0003_future', applied: false },
      ],
    );
    assert.ok(status[0]!.appliedAt, 'appliedAt is a non-empty timestamp');

    // Re-running is a no-op.
    const again = await db.migrate([{ name: '0001_init', up: '' }]);
    assert.equal(again.length, 0);
  });

  it('runs function-form migrations with an async exec', async () => {
    let called = false;
    const applied = await db.migrate([
      {
        name: 'fn_migration',
        up: async ({ exec }) => {
          called = true;
          await exec('CREATE TABLE IF NOT EXISTS fn_t (id INTEGER)');
        },
      },
    ]);
    assert.equal(applied.length, 1);
    assert.equal(called, true);
    const tables = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='fn_t'`,
    );
    assert.equal(tables.length, 1);
  });

  it('keeps earlier migrations applied when a later one fails (per-migration tx)', async () => {
    await assert.rejects(
      () =>
        db.migrate([
          { name: 'good', up: 'CREATE TABLE IF NOT EXISTS good_t (id INTEGER)' },
          { name: 'bad', up: 'INSERT INTO missing_table (id) VALUES (1)' },
        ]),
      /Migration "bad" failed/,
    );

    // 001 committed independently, so it is recorded and its table exists.
    const status = await db.migrationStatus([
      { name: 'good', up: '' },
      { name: 'bad', up: '' },
    ]);
    assert.ok(status[0]!.appliedAt !== null, 'good migration stays applied');
    assert.equal(status[1]!.appliedAt, null, 'bad migration is not recorded');

    const tables = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name = 'good_t'`,
    );
    assert.equal(tables.length, 1);
  });
});

describe('AsyncSqlo backup', () => {
  it('backs up to a file that opens and contains the data', async () => {
    const { file, dir } = tmpFile('sqlo-async-backup-');
    try {
      const src = new AsyncSqlo(file);
      await src.exec('CREATE TABLE t (id INTEGER, v TEXT)');
      await src.run('INSERT INTO t (id, v) VALUES (?, ?)', 1, 'x');
      const target = join(dir, 'backup.sqlite');
      await src.backup(target);

      const check = new DatabaseSync(target);
      try {
        const row = check.prepare('SELECT v FROM t WHERE id = ?').get(1) as { v: string } | undefined;
        assert.equal(row?.v, 'x');
      } finally {
        check.close();
        await src.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AsyncSqlo error propagation', () => {
  it('preserves constraint errcode across the worker boundary', async () => {
    await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT UNIQUE)');
    await db.run('INSERT INTO u (id, email) VALUES (?, ?)', 1, 'dup@x.io');
    await assert.rejects(
      () => db.run('INSERT INTO u (id, email) VALUES (?, ?)', 2, 'dup@x.io'),
      (err: unknown) => {
        assert.equal(isConstraintError(err), true, 'worker error should classify as constraint');
        assert.equal(isBusyError(err), false);
        return true;
      },
    );
  });

  it('rejects with the underlying SQL error message', async () => {
    await assert.rejects(() => db.exec('THIS IS NOT VALID SQL'), /syntax error/i);
  });

  it('define() rejects structurally invalid schemas on the main thread', () => {
    assert.throws(
      () =>
        db.define({
          name: 'bad',
          columns: {
            // autoIncrement requires INTEGER + primaryKey — a structural error.
            id: { type: 'TEXT', autoIncrement: true },
          },
        }),
      /Invalid schema/,
    );
  });
});

describe('AsyncSqlo constructor options', () => {
  it('readBigInts forwards to the worker and returns bigint', async () => {
    const bigDb = new AsyncSqlo(':memory:', { readBigInts: true });
    try {
      await bigDb.exec('CREATE TABLE t (id INTEGER)');
      await bigDb.run('INSERT INTO t (id) VALUES (?)', 9007199254740993n);
      const row = await bigDb.get<{ id: unknown }>('SELECT id FROM t');
      assert.equal(row?.id, 9007199254740993n);
    } finally {
      await bigDb.close();
    }
  });

  it('warns when references exist but enforcement is explicitly disabled', async () => {
    const warnings: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = (w: string | Error) => warnings.push(typeof w === 'string' ? w : w.message);
    try {
      const fkDb = new AsyncSqlo(':memory:', { enableForeignKeyConstraints: false });
      try {
        fkDb.define({
          name: 't',
          columns: {
            id: { type: 'INTEGER', primaryKey: true },
            ref: { type: 'INTEGER', references: { table: 'other', column: 'id' } },
          },
        });
      } finally {
        await fkDb.close();
      }
    } finally {
      process.emitWarning = original;
    }
    assert.ok(warnings.some((w) => w.includes('foreign key enforcement disabled')));
  });
});
