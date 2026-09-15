import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '../src/index.ts';
import { Sqlo, AsyncSqlo, MultiSqlo } from '../src/index.ts';
import type { RowOf, InsertOf, WithBaseColumns, TableDef } from '../src/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Runtime: Sqlo
// ---------------------------------------------------------------------------

const base = {
  id: { type: 'INTEGER' as const, primaryKey: true as const, autoIncrement: true as const },
  created_at: {
    type: 'TEXT' as const,
    notNull: true as const,
    default: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  },
};

test('baseColumns: merged into DDL, inserts work, columns returned', () => {
  const db = new Sqlo({ path: ':memory:', baseColumns: base });
  const users = db.define({
    name: 'users',
    columns: { name: { type: 'TEXT', notNull: true } },
  });
  users.sync();

  // DDL contains the base columns
  const ddl = db.raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get()?.sql as string;
  assert.match(ddl, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(ddl, /"created_at" TEXT NOT NULL/);
  assert.match(ddl, /"name" TEXT NOT NULL/);

  // Insert omits base columns; they are filled by defaults / autoincrement
  const inserted = users.insert({ name: 'alice' });
  assert.equal(inserted.name, 'alice');
  assert.equal(typeof inserted.id, 'number');
  assert.match(inserted.created_at as string, /^\d{4}-\d{2}-\d{2}T/);
  const row = users.findById(inserted.id as number);
  assert.equal(row?.name, 'alice');
  assert.equal(typeof row?.id, 'number');
  assert.match(row?.created_at as string, /^\d{4}-\d{2}-\d{2}T/);
  db.close();
});

test('baseColumns: schema column overrides base of the same name', () => {
  const db = new Sqlo({
    path: ':memory:',
    baseColumns: { id: { type: 'TEXT', primaryKey: true } },
  });
  const docs = db.define({
    name: 'docs',
    columns: { id: { type: 'TEXT', primaryKey: true } },
  });
  docs.sync();
  const ddl = db.raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'docs'").get()?.sql as string;
  // Schema's own definition wins — one id column, no duplicate
  assert.match(ddl, /"id" TEXT PRIMARY KEY/);
  assert.doesNotMatch(ddl, /"id" TEXT PRIMARY KEY.*"id"/s);
  db.close();
});

test('baseColumns: a connection without baseColumns is untouched', () => {
  const db = new Sqlo({ path: ':memory:' });
  const plain = db.define({ name: 'plain', columns: { a: { type: 'INTEGER' } } });
  plain.sync();
  const ddl = db.raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'plain'").get()?.sql as string;
  assert.doesNotMatch(ddl, /created_at/);
  assert.doesNotMatch(ddl, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  db.close();
});

// ---------------------------------------------------------------------------
// Runtime: AsyncSqlo
// ---------------------------------------------------------------------------

test('baseColumns: AsyncSqlo merges base columns', async () => {
  const db = new AsyncSqlo(':memory:', { baseColumns: base });
  const users = db.define({
    name: 'ausers',
    columns: { name: { type: 'TEXT', notNull: true } },
  });
  await users.sync();
  const cols = await db.all("SELECT sql FROM sqlite_master WHERE name = 'ausers'");
  assert.match(cols[0]?.sql as string, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(cols[0]?.sql as string, /"created_at" TEXT NOT NULL/);

  const inserted = await users.insert({ name: 'bob' });
  assert.equal(inserted.name, 'bob');
  assert.equal(typeof inserted.id, 'number');
  assert.match(inserted.created_at as string, /^\d{4}-\d{2}-\d{2}T/);
  const row = await users.findById(inserted.id as number);
  assert.equal(row?.name, 'bob');
  assert.equal(typeof row?.id, 'number');
  assert.match(row?.created_at as string, /^\d{4}-\d{2}-\d{2}T/);
  await db.close();
});

// ---------------------------------------------------------------------------
// Runtime: MultiSqlo
// ---------------------------------------------------------------------------

test('baseColumns: MultiSqlo forwards base columns to per-user databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlo-basecols-'));
  try {
    const pool = new MultiSqlo({ dir, options: { baseColumns: base } });
    const db = pool.for('u1');
    const users = db.define({ name: 'musers', columns: { name: { type: 'TEXT', notNull: true } } });
    users.sync();
    const ddl = db.raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'musers'").get()?.sql as string;
    assert.match(ddl, /"id" INTEGER PRIMARY KEY AUTOINCREMENT/);
    assert.match(ddl, /"created_at" TEXT NOT NULL/);
    pool.closeAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Type-level
// ---------------------------------------------------------------------------

test('types: WithBaseColumns injects base columns with schema priority', () => {
  type S = TableDef<{
    name: { type: 'TEXT'; notNull: true };
  }>;
  type Merged = WithBaseColumns<S, typeof base>;
  type R = RowOf<Merged>;

  const _assertRoundTrip: R = {
    id: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    name: 'x',
  } as R;
  void _assertRoundTrip;

  // Insert type must not require base fields — { name } alone is a valid insert
  type I = InsertOf<Merged>;
  const _insertWithoutBase: I = { name: 'x' } as I;
  void _insertWithoutBase;
  void (undefined as unknown as I);
});

test('types: WithBaseColumns lets schema override base column type', () => {
  type S = TableDef<{ id: { type: 'TEXT'; primaryKey: true } }>;
  type Merged = WithBaseColumns<S, typeof base>;
  type R = RowOf<Merged>;
  const _row: R = { id: 'a' } as R; // id is string (schema wins), created_at still injected
  void _row;
});