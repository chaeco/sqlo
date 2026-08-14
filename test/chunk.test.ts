import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sqlo } from '../src/index.ts';

function makeDb() {
  const db = new Sqlo({ path: ':memory:' });
  const items = db.define({
    name: 'items',
    columns: {
      id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
      v: { type: 'TEXT' },
    },
  });
  items.sync();
  return { db, items };
}

test('insertMany with chunkSize inserts all rows in chunks', () => {
  const { db, items } = makeDb();
  const rows = Array.from({ length: 10 }, (_, i) => ({ v: `v${i}` }));
  const inserted = items.insertMany(rows, { chunkSize: 3 });
  assert.equal(inserted.length, 10);
  assert.equal(items.count(), 10);
  assert.equal(items.all().length, 10);
  db.close();
});

test('insertMany chunkSize commits chunks independently', () => {
  const { db, items } = makeDb();
  // Use explicit id values to make the second chunk collide with the first.
  const explicit = [
    { id: 1, v: 'a' },
    { id: 2, v: 'b' },
    { id: 1, v: 'duplicate' }, // conflicts with id 1 in chunk 1
    { id: 3, v: 'c' },
  ] as never;
  // Chunk 1 (id 1,2) commits and stays. Chunk 2 fails on the duplicate id —
  // the error propagates, but chunk 1 is NOT rolled back.
  assert.throws(() => items.insertMany(explicit, { chunkSize: 2 }));
  assert.equal(items.count(), 2, 'first chunk committed and remains');
  assert.equal(items.findOne({ id: 1 })!.v, 'a');
  assert.equal(items.findOne({ id: 3 }), undefined);
  db.close();
});

test('insertMany without chunkSize stays atomic (single transaction)', () => {
  const { db, items } = makeDb();
  const explicit = [
    { id: 1, v: 'a' },
    { id: 2, v: 'b' },
    { id: 1, v: 'duplicate' }, // collides — whole batch must roll back
  ] as never;
  assert.throws(() => items.insertMany(explicit));
  assert.equal(items.count(), 0);
  db.close();
});

test('insertMany with chunkSize inside an outer transaction stays nested', () => {
  const { db, items } = makeDb();
  const rows = Array.from({ length: 6 }, (_, i) => ({ v: `v${i}` }));
  // The outer transaction aborts after insert — everything (all chunks) must
  // roll back together because the chunks participate in the outer tx.
  assert.throws(() =>
    db.transaction(() => {
      items.insertMany(rows, { chunkSize: 2 });
      throw new Error('abort outer');
    }),
    /abort outer/,
  );
  assert.equal(items.count(), 0, 'outer rollback discards all chunks');
  db.close();
});

test('insertMany empty array returns empty regardless of chunkSize', () => {
  const { db, items } = makeDb();
  assert.deepEqual(items.insertMany([], { chunkSize: 5 }), []);
  db.close();
});
