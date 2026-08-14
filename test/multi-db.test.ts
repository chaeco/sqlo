/**
 * Multiple database support — ATTACH / DETACH and cross-database models.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo, reflectTableSchema, schemaDiff } from '../src/index.ts';

let dir: string;
let db: Sqlo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlo-multi-'));
  db = new Sqlo({ path: join(dir, 'main.db') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('attach / detach', () => {
  it('attaches a database and addresses its tables as schema.table', () => {
    const auxPath = join(dir, 'aux.db');
    db.attach(auxPath, 'aux');
    const model = db.define({
      name: 'aux.items',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        name: { type: 'TEXT', notNull: true },
      },
    });
    model.sync();
    const row = model.insert({ name: 'from-aux' });
    assert.equal(row.name, 'from-aux');
    assert.equal(model.count(), 1);
  });

  it('supports CRUD, insertMany, and cross-database raw queries', () => {
    const auxPath = join(dir, 'audit.db');
    db.attach(auxPath, 'audit');
    const audit = db.define({
      name: 'audit.logs',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        msg: { type: 'TEXT', notNull: true },
      },
    });
    audit.sync();
    audit.insert({ msg: 'one' });
    audit.insertMany([{ msg: 'two' }, { msg: 'three' }]);
    assert.equal(audit.count(), 3);
    assert.equal(audit.findById(2)?.msg, 'two');

    // Cross-schema raw query from the main connection.
    const rows = db.all<{ msg: string }>('SELECT msg FROM audit.logs ORDER BY id');
    assert.deepEqual(rows, [{ msg: 'one' }, { msg: 'two' }, { msg: 'three' }]);
  });

  it('detach makes the schema unavailable', () => {
    const auxPath = join(dir, 'aux.db');
    db.attach(auxPath, 'aux');
    const model = db.define({
      name: 'aux.t',
      columns: { id: { type: 'INTEGER', primaryKey: true } },
    });
    model.sync();
    db.detach('aux');
    assert.throws(() => db.all('SELECT * FROM aux.t'), /no such table/);
  });

  it('uses parameter binding for the attach path', () => {
    // Paths with characters that would break string concatenation are safe.
    const weirdDir = join(dir, 'dir with spaces');
    mkdirSync(weirdDir, { recursive: true });
    const auxPath = join(weirdDir, "quote'd.db");
    const raw = new Sqlo({ path: auxPath });
    raw.exec('CREATE TABLE t (id INTEGER)');
    raw.close();
    db.attach(auxPath, 'weird');
    const rows = db.all<{ id: number }>('SELECT * FROM weird.t');
    assert.deepEqual(rows, []);
  });

  it('rejects an invalid schema name in attach', () => {
    assert.throws(() => db.attach(join(dir, 'x.db'), 'bad name!'), /Invalid SQL identifier/);
  });
});

describe('cross-database schema introspection', () => {
  it('reflectTableSchema reads attached-database structure', () => {
    db.attach(join(dir, 'aux.db'), 'aux');
    const model = db.define({
      name: 'aux.items',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        name: { type: 'TEXT', notNull: true },
      },
    });
    model.sync();
    const actual = reflectTableSchema(db, 'aux.items');
    assert.equal(actual.name, 'aux.items');
    assert.deepEqual(actual.columns.name, { type: 'TEXT', notNull: true });

    const diff = schemaDiff(actual, {
      name: 'aux.items',
      columns: {
        id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
        name: { type: 'TEXT', notNull: true },
      },
    });
    assert.deepEqual(diff.addedColumns, []);
    assert.deepEqual(diff.changedColumns, []);
  });
});

describe('schema name validation', () => {
  it('accepts schema.table model names', () => {
    db.attach(join(dir, 'aux.db'), 'aux');
    const model = db.define({
      name: 'aux.ok',
      columns: { id: { type: 'INTEGER', primaryKey: true } },
    });
    assert.equal(model.table, 'aux.ok');
  });

  it('rejects names with too many dots or bad identifiers', () => {
    db.attach(join(dir, 'aux.db'), 'aux');
    for (const bad of ['a.b.c', 'a..b', 'aux.bad name', '..x']) {
      assert.throws(
        () => db.define({ name: bad, columns: { id: { type: 'INTEGER' } } }),
        /Invalid table name/,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('attached-database migrations', () => {
  it('manages an attached database migration history independently', () => {
    db.attach(join(dir, 'audit.db'), 'audit');
    const migrations = [
      { name: '001_events', up: 'CREATE TABLE audit.events (id INTEGER PRIMARY KEY, msg TEXT NOT NULL)' },
      { name: '002_index', up: 'CREATE INDEX audit.idx_events_msg ON events (msg)' },
    ];
    const applied = db.migrate(migrations, { schema: 'audit' });
    assert.deepEqual(applied.map((m) => m.name), ['001_events', '002_index']);

    // Version table lives in the audit schema, not the main one.
    const inAudit = db.all<{ name: string }>(
      "SELECT name FROM audit.sqlite_master WHERE type='table' AND name='_sqlo_migrations'",
    );
    assert.equal(inAudit.length, 1);

    // Idempotent on re-run.
    assert.equal(db.migrate(migrations, { schema: 'audit' }).length, 0);

    // Status reflects the audit schema.
    const status = db.migrationStatus(migrations, { schema: 'audit' });
    assert.ok(status.every((s) => s.appliedAt !== null));
  });

  it('keeps main and attached migration histories independent', () => {
    db.attach(join(dir, 'audit.db'), 'audit');
    const auditMigrations = [
      { name: '001_shared_name', up: 'CREATE TABLE audit.t (id INTEGER)' },
    ];
    const mainMigrations = [
      { name: '001_shared_name', up: 'CREATE TABLE main.t (id INTEGER)' },
    ];
    db.migrate(auditMigrations, { schema: 'audit' });
    db.migrate(mainMigrations);
    // Both ran even though they share a name — histories are separate.
    assert.equal(db.all('SELECT * FROM main.t').length, 0);
    assert.equal(db.all('SELECT * FROM audit.t').length, 0);
    // Re-running each is still a no-op in its own schema.
    assert.equal(db.migrate(auditMigrations, { schema: 'audit' }).length, 0);
    assert.equal(db.migrate(mainMigrations).length, 0);
  });

  it('rejects an invalid schema option', () => {
    assert.throws(
      () => db.migrate([{ name: 'x', up: 'SELECT 1' }], { schema: 'bad name!' }),
      /Invalid SQL identifier/,
    );
  });
});
