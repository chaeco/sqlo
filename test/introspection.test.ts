import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo, reflectTableSchema } from '../src/index.ts';

test('databaseList() reports main and attached databases with paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-intro-'));
  const mainPath = join(dir, 'main.db');
  const auxPath = join(dir, 'aux.db');
  const db = new Sqlo({ path: mainPath });
  db.attach(auxPath, 'aux');
  const mainReal = realpathSync(mainPath);
  const auxReal = realpathSync(auxPath);

  const list = db.databaseList();
  const main = list.find((d) => d.name === 'main');
  const aux = list.find((d) => d.name === 'aux');
  assert.ok(main, 'main entry present');
  assert.equal(main!.file, mainReal);
  assert.ok(aux, 'aux entry present');
  assert.equal(aux!.file, auxReal);

  db.close();
});

test('databaseList() reports empty file path for in-memory databases', () => {
  const db = new Sqlo({ path: ':memory:' });
  const list = db.databaseList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, 'main');
  assert.equal(list[0]!.file, '');
  db.close();
});

test('isOpen reflects connection state across close()', () => {
  const db = new Sqlo({ path: ':memory:' });
  assert.equal(db.isOpen, true);
  db.close();
  assert.equal(db.isOpen, false);
});

test('version() returns a SQLite version string', () => {
  const db = new Sqlo({ path: ':memory:' });
  const v = db.version;
  assert.match(v, /^\d+\.\d+/);
  db.close();
});

test('tableExists() detects tables in main and attached schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-intro-'));
  const db = new Sqlo({ path: join(dir, 'main.db') });
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  db.attach(join(dir, 'aux.db'), 'aux');
  db.exec('CREATE TABLE aux.logs (id INTEGER PRIMARY KEY)');

  assert.equal(db.tableExists('users'), true);
  assert.equal(db.tableExists('missing'), false);
  assert.equal(db.tableExists('aux.logs'), true);
  assert.equal(db.tableExists('aux.missing'), false);
  db.close();
});

test('backup() creates a consistent copy that opens independently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-intro-'));
  const src = join(dir, 'src.db');
  const dst = join(dir, 'backup.db');
  const db = new Sqlo({ path: src });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec('INSERT INTO t (v) VALUES (\'a\'), (\'b\'), (\'c\')');

  db.backup(dst);
  assert.ok(existsSync(dst));

  // The backup is a real, independent database.
  const bk = new Sqlo({ path: dst });
  const rows = bk.all('SELECT v FROM t ORDER BY id');
  assert.deepEqual(rows, [{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
  bk.close();
  db.close();
});

test('backup() parameterizes the target path (spaces, quotes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-intro-'));
  const db = new Sqlo({ path: join(dir, 'src.db') });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  const weird = join(dir, "weird 'name' space.db");
  db.backup(weird);
  assert.ok(existsSync(weird));
  db.close();
});

test('Model.deleteAll() clears all rows and returns the count', () => {
  const db = new Sqlo({ path: ':memory:' });
  const items = db.define({
    name: 'items',
    columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, v: { type: 'TEXT' } },
  });
  items.sync();
  items.insertMany([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);

  assert.equal(items.count(), 3);
  const deleted = items.deleteAll();
  assert.equal(deleted, 3);
  assert.equal(items.count(), 0);
  db.close();
});

test('reflectTableSchema ignores quoted text when detecting table options', () => {
  const db = new Sqlo({ path: ':memory:' });
  db.exec(
    `CREATE TABLE tricky (
      name TEXT CHECK (name <> 'STRICT'),
      note TEXT DEFAULT 'AUTOINCREMENT WITHOUT ROWID'
    )`,
  );
  const def = reflectTableSchema(db, 'tricky');
  assert.ok(!def.strict, 'STRICT inside a string literal must not set strict');
  assert.ok(!def.withoutRowId, 'WITHOUT ROWID inside a string literal must not set withoutRowId');
  db.close();
});

test('reflectTableSchema keeps expression defaults as raw SQL text', () => {
  const db = new Sqlo({ path: ':memory:' });
  db.exec(`CREATE TABLE expr_defaults (
    ts TEXT DEFAULT CURRENT_TIMESTAMP,
    stamp TEXT DEFAULT (datetime('now'))
  )`);
  const def = reflectTableSchema(db, 'expr_defaults');
  assert.equal(def.columns.ts!.default, 'CURRENT_TIMESTAMP');
  assert.match(String(def.columns.stamp!.default), /datetime\('now'\)/);
  db.close();
});
