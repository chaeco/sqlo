import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sqlo, type ColumnDef, type TableDef } from '../src/index.ts';

// --- type-level checks (compile-time, via @ts-expect-error) -----------------

test('ColumnDef rejects misspelled built-in type names at compile time', () => {
  // @ts-expect-error 'INTERGER' is not a known SQLite type name
  const bad: ColumnDef = { type: 'INTERGER' };
  void bad;

  // @ts-expect-error trailing space is not a known type name
  const badSpace: ColumnDef = { type: 'TEXT ' };
  void badSpace;

  assert.ok('compile-time guards are enforced');
});

test('comment must be a string at compile time', () => {
  // @ts-expect-error 'comment' is documentation-only and must be a string
  const badComment: ColumnDef = { type: 'INTEGER', comment: 123 };
  void badComment;

  const ok: ColumnDef = { type: 'INTEGER', comment: 'monthly reset' };
  void ok;
  assert.ok('comment accepts only strings');
});

test('comment is documentation-only: never a row column', () => {
  const db = new Sqlo({ path: ':memory:' });
  const users = db.define({
    name: 'users',
    columns: {
      id: { type: 'INTEGER', primaryKey: true },
      name: { type: 'TEXT', comment: 'display name' },
    },
  });
  users.sync();
  users.insert({ id: 1, name: 'a' });
  const rows = users.all();
  assert.equal(rows[0]?.name, 'a');
  // Row type has no `comment` projection (doc metadata is not a column)
  // @ts-expect-error 'comment' is documentation-only, not a column
  rows[0]?.comment;
  db.close();
});

test('table-level comment must be a string at compile time', () => {
  const ok: TableDef = {
    name: 't',
    comment: 'accounts',
    columns: { id: { type: 'INTEGER' } },
  };
  void ok;
  // @ts-expect-error table-level 'comment' is documentation-only and must be a string
  const bad: TableDef = { name: 't', comment: 123, columns: { id: { type: 'INTEGER' } } };
  void bad;
  assert.ok('table-level comment is compile-time string-checked');
});

test('ColumnDef accepts all five SQLite storage-class types', () => {
  const valid: ColumnDef[] = [
    { type: 'INTEGER' },
    { type: 'TEXT' },
    { type: 'REAL' },
    { type: 'BLOB' },
    { type: 'NUMERIC' },
  ];
  assert.equal(valid.length, 5);
});

test('ColumnDef still accepts custom / affinity type names', () => {
  // SQLite accepts arbitrary type names (type affinity rules); these must
  // remain expressible even though they are not built-in storage classes.
  const custom: ColumnDef<string>[] = [
    { type: 'UUID' } as ColumnDef<string>,
    { type: 'JSON' } as ColumnDef<string>,
    { type: 'BOOLEAN' } as ColumnDef<string>,
    { type: 'VARCHAR(255)' } as ColumnDef<string>,
  ];
  assert.equal(custom.length, 4);
});

// --- runtime smoke: custom type names survive define/sync/insert -------------

test('custom type names work end-to-end', () => {
  const db = new Sqlo({ path: ':memory:' });
  const table: TableDef = {
    name: 'items',
    columns: {
      id: { type: 'INTEGER', primaryKey: true },
      label: { type: 'UUID' },
      tags: { type: 'JSON' },
      flag: { type: 'BOOLEAN' },
    },
  };
  const items = db.define(table);
  items.sync();
  items.insert({ id: 1, label: 'abc', tags: '{}', flag: 1 } as never);
  assert.deepEqual(items.all(), [
    { id: 1, label: 'abc', tags: '{}', flag: 1 },
  ]);
  db.close();
});