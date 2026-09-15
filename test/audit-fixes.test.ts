/**
 * Regression tests for the security / data-integrity audit fixes.
 *
 * Each test below pins a behaviour that was previously a silent logic bug:
 * match-all WHERE filters, orphaned transactions, cross-request transaction
 * enlistment, DDL injection, lost ordering params, and so on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Sqlo,
  AsyncSqlo,
  MultiSqlo,
  raw,
  columnDDL,
  reflectTableSchema,
  schemaDiff,
} from '../src/index.ts';

function peopleDb() {
  const db = new Sqlo({ path: ':memory:' });
  const t = db.define({
    name: 'people',
    columns: {
      id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
      name: { type: 'TEXT' },
      age: { type: 'INTEGER' },
      data: { type: 'BLOB' },
    },
  });
  t.sync();
  return { db, t };
}

describe('fix: WHERE values cannot silently match every row', () => {
  it('rejects a non plain-object value instead of matching all rows', () => {
    const { db, t } = peopleDb();
    t.insertMany([{ name: 'a', age: 1 }, { name: 'b', age: 2 }]);

    assert.throws(
      () => t.query().where({ age: new Date() } as never).toSql(),
      /Invalid WHERE value/,
    );
    assert.throws(
      () => t.delete({ age: new Date() } as never),
      /Invalid WHERE value/,
    );
    assert.equal(t.count(), 2, 'nothing was deleted');
    db.close();
  });

  it('rejects an empty operator object instead of filtering nothing', () => {
    const { db, t } = peopleDb();
    t.insertMany([{ name: 'a' }, { name: 'b' }]);

    assert.throws(
      () => t.query().where({ age: {} }).toSql(),
      /Empty WHERE condition/,
    );
    assert.throws(
      () => t.update({ age: 9 }, { age: { eq: undefined } } as never),
      /Empty WHERE condition/,
    );
    assert.throws(
      () => t.delete({ age: { in: undefined } } as never),
      /Empty WHERE condition/,
    );
    assert.equal(t.count(), 2, 'nothing was updated or deleted');
    assert.equal(t.findAll({ age: undefined } as never).length, 2, 'omitted column is still a no-op');
    db.close();
  });

  it('supports BLOB equality filters', () => {
    const { db, t } = peopleDb();
    const blob = new Uint8Array([1, 2, 3]);
    t.insert({ name: 'blob', data: blob });
    const row = t.findOne({ data: blob });
    assert.ok(row);
    assert.equal(row.name, 'blob');
    db.close();
  });
});

describe('fix: WHERE group operators stay aligned', () => {
  it('keeps OR when an empty group is chained in between', () => {
    const { db, t } = peopleDb();
    const built = t.query()
      .where({ age: { gte: 18 } })
      .where({})
      .orWhere({ name: 'admin' })
      .toSql();
    assert.equal(built.sql, 'SELECT * FROM "people" WHERE "age" >= ? OR "name" = ?');
    assert.deepEqual(built.params, [18, 'admin']);
    db.close();
  });
});

describe('fix: ORDER BY fragment params are bound', () => {
  it('binds and applies params from an orderBy fragment', () => {
    const { db, t } = peopleDb();
    t.insertMany([{ name: 'a', age: 2 }, { name: 'b', age: 1 }]);
    const qb = t.query().orderBy(raw('CASE WHEN ? > 0 THEN "age" END', [1]));
    const built = qb.toSql();
    assert.equal((built.sql.match(/\?/g) ?? []).length, built.params.length);
    assert.deepEqual(qb.all().map((r) => r.age), [1, 2]);
    db.close();
  });
});

describe('fix: column types cannot inject DDL', () => {
  it('rejects an injection-shaped type at define()', () => {
    const db = new Sqlo({ path: ':memory:' });
    assert.throws(
      () => db.define({
        name: 'evil',
        columns: { a: { type: 'TEXT); CREATE TABLE pwned(x); /*' } as never },
      }),
      /unsafe type/,
    );
    db.close();
  });

  it('columnDDL rejects an unsafe type even when called directly', () => {
    assert.throws(() => columnDDL({ type: 'TEXT); DROP TABLE x; --' }), /unsafe column type/i);
  });

  it('still accepts legitimate sized and multi-word types', () => {
    assert.doesNotThrow(() => columnDDL({ type: 'VARCHAR(255)' }));
    assert.doesNotThrow(() => columnDDL({ type: 'DECIMAL(10, 5)' }));
    assert.doesNotThrow(() => columnDDL({ type: 'UNSIGNED BIG INT' }));
  });

  it('rejects an invalid journalMode at construction (PRAGMA injection)', () => {
    assert.throws(
      () => new Sqlo({ path: ':memory:', journalMode: 'MEMORY; CREATE TABLE x(y); --' as never }),
      /Invalid journalMode/,
    );
  });
});

describe('fix: transaction state survives a failed COMMIT', () => {
  it('does not leave the connection inside an orphaned transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-txfix-'));
    const path = join(dir, 'x.db');
    try {
      {
        const db = new Sqlo({ path });
        db.exec('PRAGMA foreign_keys=ON');
        db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY)');
        db.exec('CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');

        assert.throws(
          () => db.transaction(() => { db.run('INSERT INTO child(pid) VALUES (99)'); }),
          /FOREIGN KEY/,
        );
        // A later transaction must genuinely commit.
        db.transaction(() => { db.run('INSERT INTO parent(id) VALUES (7)'); });
        db.close();
      }
      const reopened = new Sqlo({ path });
      assert.deepEqual(reopened.all('SELECT * FROM parent'), [{ id: 7 }]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fix: migrate() rejects an async up()', () => {
  it('throws and does not record the migration as applied', () => {
    const db = new Sqlo({ path: ':memory:' });
    try {
      db.migrate([{ name: 'async_m', up: async () => { throw new Error('nope'); } }]);
      assert.fail('expected migrate() to throw');
    } catch (err) {
      const e = err as Error & { cause?: Error };
      assert.match(e.message, /Migration "async_m" failed/);
      assert.match(String(e.cause?.message), /returned a Promise/);
    }
    assert.deepEqual(
      db.migrationStatus([{ name: 'async_m', up: '' }]),
      [{ name: 'async_m', appliedAt: null }],
    );
    db.close();
  });
});

describe('fix: migrationStatus() is read-only', () => {
  it('does not create the version table', () => {
    const db = new Sqlo({ path: ':memory:' });
    const status = db.migrationStatus([{ name: 'x', up: 'CREATE TABLE x(id INTEGER)' }]);
    assert.deepEqual(status, [{ name: 'x', appliedAt: null }]);
    assert.equal(db.tableExists('_sqlo_migrations'), false);
    db.close();
  });
});

describe('fix: reflection preserves multi-column UNIQUE', () => {
  it('keeps the constraint and keeps schemaDiff stable', () => {
    const db = new Sqlo({ path: ':memory:' });
    db.exec('CREATE TABLE u (a TEXT, b TEXT, c TEXT, UNIQUE(a, b))');
    const reflected = reflectTableSchema(db, 'u');
    const unique = (reflected.indexes ?? []).find((i) => i.unique);
    assert.ok(unique, 'multi-column unique constraint is preserved');
    assert.deepEqual(unique.columns, ['a', 'b']);

    const diff = schemaDiff(reflected, {
      name: 'u',
      columns: reflected.columns,
      indexes: [{ name: unique.name, columns: ['a', 'b'], unique: true }],
    });
    assert.deepEqual(diff.addedIndexes, [], 'no spurious re-add');
    db.close();
  });
});

describe('fix: MultiSqlo hardening', () => {
  it('rejects a drive-relative fileName', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-multi-drive-'));
    try {
      const pool = new MultiSqlo({ dir, fileName: () => 'C:evil' });
      assert.throws(() => pool.for('u'), /plain file name/);
      pool.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the connection and keeps the pool consistent when bootstrap fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-multi-leak-'));
    try {
      const pool = new MultiSqlo({
        dir,
        migrations: [{ name: 'bad', up: () => { throw new Error('boom'); } }],
      });
      assert.throws(() => pool.for('u'), /Migration "bad" failed/);
      assert.equal(pool.size, 0);
      assert.equal(pool.has('u'), false);
      assert.doesNotThrow(() => pool.closeAll());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fix: syncAll() keeps every definition', () => {
  it('still creates indexes declared by an earlier definition of the same table', () => {
    const db = new Sqlo({ path: ':memory:' });
    db.define({
      name: 'dup',
      columns: { id: { type: 'INTEGER', primaryKey: true }, email: { type: 'TEXT' } },
      indexes: [{ name: 'idx_dup_email', columns: ['email'] }],
    });
    db.define({
      name: 'dup',
      columns: { id: { type: 'INTEGER', primaryKey: true }, email: { type: 'TEXT' } },
    });
    db.syncAll();
    const names = db.all<{ name: string }>('PRAGMA index_list("dup")').map((r) => r.name);
    assert.ok(names.includes('idx_dup_email'));
    db.close();
  });
});

describe('fix: identifier validation', () => {
  it('attach() rejects a dotted database name', () => {
    const db = new Sqlo({ path: ':memory:' });
    assert.throws(() => db.attach(':memory:', 'a.b'), /Invalid database name/);
    db.close();
  });

  it('tableExists() rejects an ambiguous dotted name', () => {
    const db = new Sqlo({ path: ':memory:' });
    assert.throws(() => db.tableExists('a.b.c'), /Invalid table name/);
    db.close();
  });
});

describe('fix: AsyncSqlo concurrency isolation', () => {
  it('concurrent DEFAULT VALUES inserts each return their own row', async () => {
    const db = new AsyncSqlo(':memory:');
    try {
      const m = db.define({
        name: 'rows',
        columns: {
          id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
          tag: { type: 'TEXT', default: 'x' },
        },
      });
      await m.sync();
      const returned = await Promise.all([
        m.insert({}), m.insert({}), m.insert({}), m.insert({}), m.insert({}),
      ]);
      assert.deepEqual(returned.map((r) => r.id).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    } finally {
      await db.close();
    }
  });

  it('does not enlist an unrelated concurrent operation into an open transaction', async () => {
    const db = new AsyncSqlo(':memory:');
    try {
      const m = db.define({
        name: 'notes',
        columns: {
          id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
          tag: { type: 'TEXT' },
        },
      });
      await m.sync();

      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let txStarted!: () => void;
      const started = new Promise<void>((r) => { txStarted = r; });

      // The .catch is attached immediately so the intentional rejection is
      // never an unhandled rejection.
      const txResult = db.transaction(async (tx) => {
        await tx.run('INSERT INTO notes(tag) VALUES (?)', 'tx');
        txStarted();
        await gate;
        throw new Error('abort');
      }).then(() => 'committed', (e: Error) => e.message);

      await started; // the transaction is open and parked on the gate

      // Issued from the test body (a different async context) while the
      // transaction is still open — must be queued, not absorbed.
      const unrelated = m.insert({ tag: 'unrelated' });
      release();
      assert.equal(await txResult, 'abort');
      const inserted = await unrelated;
      assert.equal(inserted.tag, 'unrelated');
      assert.ok(await m.findOne({ tag: 'unrelated' }), 'unrelated write survived the rollback');
      assert.equal(await m.count(), 1);
    } finally {
      await db.close();
    }
  });

  it('MultiSqlo evicts the least-recently-used connection at maxOpen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-lru-'));
    try {
      const pool = new MultiSqlo({ dir, maxOpen: 2 });
      const alice = pool.for('alice');
      const bob = pool.for('bob');
      // Touch alice so bob is now the least-recently-used.
      assert.equal(pool.for('alice'), alice);
      assert.equal(pool.size, 2);
      pool.for('carol'); // evicts bob
      assert.equal(pool.size, 2);
      assert.equal(pool.has('bob'), false);
      assert.equal(pool.has('alice'), true);
      assert.equal(pool.has('carol'), true);
      // The evicted connection is really closed...
      assert.throws(() => bob.exec('SELECT 1'), /closed/i);
      // ...and reopening yields a fresh, working instance.
      const bob2 = pool.for('bob');
      assert.notEqual(bob2, bob);
      assert.deepEqual(bob2.all('SELECT 1 AS ok'), [{ ok: 1 }]);
      pool.closeAll();
      assert.equal(pool.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MultiSqlo eviction keeps the database file (data survives reopen)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-lru-file-'));
    try {
      const pool = new MultiSqlo({ dir, maxOpen: 1 });
      const first = pool.for('alice');
      first.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
      first.run('INSERT INTO t VALUES (?)', 1);
      pool.for('bob'); // evicts and closes alice
      assert.equal(pool.has('alice'), false);
      const alice2 = pool.for('alice'); // reopen the same file
      assert.deepEqual(alice2.all('SELECT id FROM t'), [{ id: 1 }]);
      pool.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MultiSqlo maxOpen: Infinity disables eviction; invalid values throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-lru-inf-'));
    try {
      const pool = new MultiSqlo({ dir, maxOpen: Infinity });
      for (let i = 0; i < 5; i++) pool.for('u' + i);
      assert.equal(pool.size, 5);
      pool.closeAll();
      assert.throws(() => new MultiSqlo({ dir, maxOpen: 0 }), /Invalid maxOpen/);
      assert.throws(() => new MultiSqlo({ dir, maxOpen: 1.5 }), /Invalid maxOpen/);
      assert.throws(() => new MultiSqlo({ dir, maxOpen: -3 }), /Invalid maxOpen/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
