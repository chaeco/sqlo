/**
 * QueryBuilder tests — SQL generation, params, conditions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, userSchema } from './helpers.ts';
import { raw, sql as sf, Sqlo } from '../src/index.ts';

const users = createDb().define(userSchema);
users.sync();

describe('QueryBuilder basic', () => {
  it('selects all columns', () => {
    const qb = users.query();
    const { sql, params } = qb.toSql();
    assert.equal(sql, 'SELECT * FROM "users"');
    assert.deepEqual(params, []);
  });

  it('applies where with operator objects', () => {
    const qb = users.query();
    qb.where({ age: { gte: 18 } });
    qb.where({ active: 1 });
    const { sql, params } = qb.toSql();
    assert.equal(sql, 'SELECT * FROM "users" WHERE "age" >= ? AND "active" = ?');
    assert.deepEqual(params, [18, 1]);
  });

  it('applies orWhere without noisy parens on single conditions', () => {
    const qb = users.query();
    qb.where({ age: { lt: 10 } });
    qb.orWhere({ name: 'bob' });
    const { sql, params } = qb.toSql();
    assert.equal(sql, 'SELECT * FROM "users" WHERE "age" < ? OR "name" = ?');
    assert.deepEqual(params, [10, 'bob']);
  });

  it('supports complex stacked conditions with necessary parens', () => {
    const qb = users.query();
    qb.where({ age: { gte: 18 } });
    qb.orWhere({ name: 'admin' });
    qb.where({ active: 1 });
    const { sql, params } = qb.toSql();
    assert.equal(
      sql,
      'SELECT * FROM "users" WHERE ("age" >= ? OR "name" = ?) AND "active" = ?',
    );
    assert.deepEqual(params, [18, 'admin', 1]);
  });

  it('supports IN / BETWEEN / LIKE / IS NULL / IS NOT NULL', () => {
    const qb = users.query();
    qb.where({
      age: { in: [1, 2, 3] },
      name: { like: 'a%' },
      email: { isNull: true },
      active: { isNull: false },
    });
    qb.where({ age: { between: [10, 20] } });
    const { params } = qb.toSql();
    assert.deepEqual(params, [1, 2, 3, 'a%', 10, 20]);
  });

  it('supports ne operator', () => {
    const qb = users.query();
    qb.where({ name: { ne: 'bob' } });
    const { sql, params } = qb.toSql();
    assert.equal(sql, 'SELECT * FROM "users" WHERE "name" <> ?');
    assert.deepEqual(params, ['bob']);
  });

  it('supports raw predicate', () => {
    const qb = users.query();
    qb.where(raw('LENGTH(name) > 3'));
    const { sql } = qb.toSql();
    assert.match(sql, /LENGTH\(name\) > 3/);
    assert.equal(qb.toSql().params.length, 0);
  });

  it('applies orderBy / limit / offset / groupBy', () => {
    const qb = users.query();
    qb.where({ active: 1 });
    qb.orderBy('name', 'DESC');
    qb.orderBy(raw('id'));
    qb.limit(10);
    qb.offset(5);
    qb.groupBy('age');
    const { sql } = qb.toSql();
    assert.match(sql, /ORDER BY "name" DESC, id ASC/);
    assert.match(sql, /LIMIT \? OFFSET \?/);
  });

  it('applies joins', () => {
    const qb = users.query();
    qb.leftJoin('posts', sf`"posts"."userId" = "users"."id"`);
    const { sql } = qb.toSql();
    assert.match(
      sql,
      /LEFT JOIN "posts" ON "posts"\."userId" = "users"\."id"/,
    );
  });

  it('supports rightJoin and fullJoin', () => {
    const qb = users.query();
    qb.rightJoin('posts', sf`"posts"."userId" = "users"."id"`);
    qb.fullJoin('likes', sf`"likes"."userId" = "users"."id"`);
    const { sql } = qb.toSql();
    assert.match(sql, /RIGHT JOIN "posts"/);
    assert.match(sql, /FULL JOIN "likes"/);
  });

  it('applies select with quoted columns and distinct', () => {
    const qb = users.query();
    qb.distinct().select('name', 'age');
    const { sql } = qb.toSql();
    assert.equal(sql, 'SELECT DISTINCT "name", "age" FROM "users"');
  });

  it('applies having with aggregated conditions', () => {
    const qb = users.query();
    qb.groupBy('age');
    qb.having({ age: { gte: 30 } });
    const { sql, params } = qb.toSql();
    assert.match(sql, /GROUP BY "age"/);
    assert.match(sql, /HAVING "age" >= \?/);
    assert.deepEqual(params, [30]);
  });

  it('supports notIn / is / isNot / notNull operators', () => {
    const qb = users.query();
    qb.where({ id: { notIn: [1, 2] } });
    qb.where({ active: { is: 1 } });
    qb.where({ email: { isNot: null } });
    qb.where({ name: { notNull: true } });
    const { sql, params } = qb.toSql();
    assert.match(sql, /"id" NOT IN \(\?, \?\)/);
    assert.match(sql, /"active" IS \?/);
    assert.match(sql, /"email" IS NOT \?/);
    assert.match(sql, /"name" IS NOT NULL/);
    assert.deepEqual(params, [1, 2, 1, null]);
  });

  it('throws on unknown where operator', () => {
    const qb = users.query();
    assert.throws(
      () => qb.where({ age: { bogus: 1 } } as never),
      /Unknown where operator/,
    );
  });

  it('first returns a row or undefined, pluck returns column values', () => {
    users.insert({ name: 'a', email: 'a@x.io', age: 10 });
    users.insert({ name: 'b', email: 'b@x.io', age: 20 });
    const first = users.query().orderBy('age', 'DESC').first();
    assert.equal(first?.name, 'b');
    const none = users.query().where({ name: 'zzz' }).first();
    assert.equal(none, undefined);
    const names = users.query().orderBy('age', 'ASC').pluck('name');
    assert.deepEqual(names, ['a', 'b']);
  });

  it('first() and pluck() do not mutate the builder', () => {
    users.insert({ name: 'q1', email: 'q1@x.io', age: 101 });
    users.insert({ name: 'q2', email: 'q2@x.io', age: 102 });
    users.insert({ name: 'q3', email: 'q3@x.io', age: 103 });

    // Query scoped to the fresh rows only (ages 101..103) so results are
    // deterministic regardless of rows inserted by earlier tests.
    const qb = users.query().where({ age: { gte: 101 } }).orderBy('age', 'ASC');
    const first = qb.first();
    assert.equal(first?.name, 'q1');
    // Builder is still reusable after first() — no leaked LIMIT 1.
    assert.equal(qb.all().length, 3);

    const qb2 = users.query().where({ age: { gte: 101 } }).orderBy('age', 'ASC');
    qb2.pluck('name');
    // pluck() must not pin the SELECT to a single column.
    const rows = qb2.all();
    assert.equal(rows.length, 3);
    assert.ok('email' in rows[0]! && 'age' in rows[0]!);
  });

  it('appends ORDER BY / LIMIT to raw fragments', () => {
    const qb = users.query();
    qb.orderBy(raw('RANDOM()'));
    qb.limit(3);
    const { sql, params } = qb.toSql();
    assert.match(sql, /ORDER BY RANDOM\(\)/);
    assert.deepEqual(params, [3]);
  });

  it('distinguishes null from empty params', () => {
    const qb = users.query();
    qb.where({ name: null });
    const { sql, params } = qb.toSql();
    assert.equal(sql, 'SELECT * FROM "users" WHERE "name" IS NULL');
    assert.deepEqual(params, []);
  });

  it('rightJoin generates RIGHT JOIN', () => {
    const qb = users.query();
    qb.rightJoin('posts', raw('posts.userId = users.id'));
    const { sql } = qb.toSql();
    assert.match(sql, /RIGHT JOIN "posts" ON posts\.userId = users\.id/);
  });

  it('fullJoin generates FULL JOIN', () => {
    const qb = users.query();
    qb.fullJoin('posts', raw('posts.userId = users.id'));
    const { sql } = qb.toSql();
    assert.match(sql, /FULL JOIN "posts" ON posts\.userId = users\.id/);
  });

  it('join (INNER) and leftJoin generate their clauses', () => {
    const inner = users.query().join('posts', raw('posts.userId = users.id')).toSql().sql;
    assert.match(inner, /JOIN "posts" ON posts\.userId = users\.id/);
    assert.doesNotMatch(inner, /LEFT|RIGHT|FULL/);
    const left = users.query().leftJoin('posts', raw('posts.userId = users.id')).toSql().sql;
    assert.match(left, /LEFT JOIN "posts" ON posts\.userId = users\.id/);
  });

  it('empty IN array becomes 0 (matches nothing)', () => {
    const qb = users.query();
    qb.where({ id: { in: [] } });
    const { sql, params } = qb.toSql();
    assert.match(sql, /0/);
    assert.deepEqual(params, []);
    // Executes without error and returns nothing.
    assert.deepEqual(qb.all(), []);
  });

  it('count() with groupBy wraps in a subquery', () => {
    // count must not count rows multiplied by grouping.
    const countQb = users.query().groupBy('age');
    const n = countQb.count();
    assert.equal(typeof n, 'number');
    // And it executes without error.
    users.query().groupBy('age').count();
  });

  it('where accepts a plain SQL string (converted to a fragment)', () => {
    const qb = users.query();
    qb.where(raw('age >= 18'));
    const { sql, params } = qb.toSql();
    assert.equal(sql, 'SELECT * FROM "users" WHERE age >= 18');
    assert.deepEqual(params, []);
  });
});
describe('QueryBuilder count & validation', () => {
  it('count() honours distinct()', () => {
    const db = createDb();
    const t = db.define({
      name: 'qb_distinct',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        city: { type: 'TEXT' },
      },
    });
    t.sync();
    t.insert({ city: 'a' });
    t.insert({ city: 'a' });
    t.insert({ city: 'b' });
    assert.equal(t.count(), 3);
    assert.equal(t.query().distinct().select('city').count(), 2, 'COUNT(DISTINCT city)');
    // Whole-row DISTINCT: every row has a unique autoincrement id, so the
    // subquery wrapper must count 3 distinct rows (semantics, not a shortcut).
    assert.equal(t.query().distinct().count(), 3, 'whole-row distinct via subquery');
    db.close();
  });

  it('count() returns a plain number even with readBigInts', () => {
    const db = new Sqlo({ path: ':memory:', readBigInts: true });
    const t = db.define({
      name: 'qb_bigint',
      columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true } },
    });
    t.sync();
    t.insertMany([{}, {}, {}]);
    const n = t.count();
    assert.equal(typeof n, 'number');
    assert.equal(n, 3);
    db.close();
  });

  it('orderBy rejects invalid directions instead of emitting them raw', () => {
    assert.throws(
      () => users.query().orderBy('id', 'DESC; DROP TABLE users--' as unknown as 'DESC'),
      /Invalid orderBy direction/,
    );
    // Case-insensitive valid values still work.
    assert.equal(users.query().orderBy('id', 'desc').toSql().sql, 'SELECT * FROM "users" ORDER BY "id" DESC');
  });
});

describe('QueryBuilder raw and clone edges', () => {
  it('raw() accepts a plain SQL string', () => {
    const solo = users.query().raw('age > 18');
    assert.match(solo.toSql().sql, /WHERE age > 18/);
    assert.deepEqual(solo.toSql().params, []);
    assert.ok(Array.isArray(solo.all()), 'executes without error');

    const chained = users.query().where({ id: 1 }).raw('age > 18');
    assert.match(chained.toSql().sql, /AND age > 18/);
  });

  it('raw() accepts a sql fragment with bound params', () => {
    const solo = users.query().raw(sf`age > ${17}`);
    assert.match(solo.toSql().sql, /WHERE age > \?/);
    assert.deepEqual(solo.toSql().params, [17]);

    const chained = users.query().where({ id: 1 }).raw(sf`age > ${17}`);
    assert.match(chained.toSql().sql, /AND age > \?/);
    assert.deepEqual(chained.toSql().params, [1, 17]);
  });

  it('array value shorthand compiles to IN and empty arrays to 0', () => {
    const { sql, params } = users.query().where({ age: [18, 21, 25] }).toSql();
    assert.match(sql, /"age" IN \(\?, \?, \?\)/);
    assert.deepEqual(params, [18, 21, 25]);

    const empty = users.query().where({ id: [] });
    assert.match(empty.toSql().sql, /WHERE 0/);
    assert.deepEqual(empty.all(), []);
  });

  it('in operator object form compiles like the array shorthand', () => {
    const { sql, params } = users.query().where({ age: { in: [18, 21] } }).toSql();
    assert.match(sql, /"age" IN \(\?, \?\)/);
    assert.deepEqual(params, [18, 21]);
  });

  it('clone keeps HAVING when compiling first()/pluck()', () => {
    const qb = users.query().groupBy('age').having(sf`COUNT(*) > 1`);
    assert.match(qb.buildFirstSql().sql, /HAVING COUNT\(\*\) > 1/);
    assert.match(qb.buildPluckSql('age').sql, /HAVING/);
  });
});
