/**
 * JSON table definition loading + plain-string CHECK support.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo, loadTableDefSync } from '../src/index.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sqlo-json-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadTableDefSync', () => {
  it('loads a table definition from a JSON file', () => {
    const path = join(tmpDir, 'users.json');
    writeFileSync(
      path,
      JSON.stringify({
        name: 'users',
        columns: {
          id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
          name: { type: 'TEXT', notNull: true },
          age: { type: 'INTEGER', check: 'age >= 0' },
        },
        indexes: [{ name: 'idx_users_name', columns: ['name'] }],
      }),
    );
    const schema = loadTableDefSync(path);
    assert.equal(schema.name, 'users');
    assert.equal(schema.columns.age!.check, 'age >= 0');
    assert.equal(schema.indexes?.[0]?.name, 'idx_users_name');
  });

  it('loads a schema usable by db.define()', () => {
    const path = join(tmpDir, 't.json');
    writeFileSync(
      path,
      JSON.stringify({
        name: 'kv',
        columns: {
          key: { type: 'TEXT', primaryKey: true },
          value: { type: 'TEXT', notNull: true },
        },
        strict: true,
      }),
    );
    const db = new Sqlo({ path: ':memory:' });
    const model = db.define(loadTableDefSync(path));
    model.sync();
    const row = model.insert({ key: 'a', value: '1' });
    assert.equal(row.key, 'a');
    db.close();
  });

  it('throws on malformed JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{ not json');
    assert.throws(() => loadTableDefSync(path), /Failed to parse/);
  });

  it('throws when the JSON is not an object', () => {
    const path = join(tmpDir, 'arr.json');
    writeFileSync(path, '[1, 2, 3]');
    assert.throws(() => loadTableDefSync(path), /must contain a single object/);
  });
});

describe('plain-string CHECK / WHERE in define', () => {
  it('accepts a string column CHECK and table CHECK', () => {
    const db = new Sqlo({ path: ':memory:' });
    const model = db.define({
      name: 't',
      columns: {
        a: { type: 'INTEGER', check: 'a >= 0' },
        b: { type: 'INTEGER' },
      },
      checks: ['a < b'],
    });
    model.sync();
    // Valid insert works
    model.insert({ a: 1, b: 2 });
    // CHECK violations are rejected by SQLite
    assert.throws(
      () => model.insert({ a: -1, b: 2 }),
      /CHECK constraint failed/,
    );
    db.close();
  });

  it('accepts a string partial index WHERE', () => {
    const db = new Sqlo({ path: ':memory:' });
    const model = db.define({
      name: 't',
      columns: {
        a: { type: 'INTEGER' },
        active: { type: 'INTEGER' },
      },
      indexes: [{ name: 'idx_active', columns: ['a'], where: 'active = 1' }],
    });
    model.sync();
    const rows = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_active'",
    );
    assert.equal(rows.length, 1);
    db.close();
  });
});
