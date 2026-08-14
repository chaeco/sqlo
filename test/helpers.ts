/**
 * Test utilities — in‑memory database helpers.
 */

import { Sqlo } from '../src/index.ts';

export function createDb(): Sqlo {
  return new Sqlo({ path: ':memory:' });
}

export const userSchema = {
  name: 'users',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'TEXT', notNull: true },
    email: { type: 'TEXT', notNull: true, unique: true },
    age: { type: 'INTEGER' },
    active: { type: 'INTEGER', default: 1 } as const,
    createdAt: { type: 'TEXT', default: "datetime('now')" } as const,
  },
} as const;

export const postSchema = {
  name: 'posts',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    userId: {
      type: 'INTEGER',
      references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    },
    title: { type: 'TEXT', notNull: true },
    body: { type: 'TEXT' },
    published: { type: 'INTEGER', default: 0 } as const,
  },
} as const;