/**
 * schemaDiff / generateMigrationSql tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schemaDiff, generateMigrationSql, type TableDef } from '../src/index.ts';

const from: TableDef = {
  name: 'users',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'TEXT', notNull: true },
    age: { type: 'INTEGER' },
  },
  indexes: [
    { name: 'idx_users_name', columns: ['name'] },
  ],
};

describe('schemaDiff', () => {
  it('detects added columns and emits ADD COLUMN statements', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        email: { type: 'TEXT' },
      },
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.addedColumns, ['email']);
    assert.deepEqual(diff.removedColumns, []);
    assert.deepEqual(diff.changedColumns, []);
    assert.equal(diff.statements.length, 1);
    assert.match(diff.statements[0]!, /ALTER TABLE "users" ADD COLUMN "email" TEXT/);
    assert.deepEqual(diff.warnings, []);
  });

  it('warns when adding NOT NULL column without default', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        email: { type: 'TEXT', notNull: true },
      },
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.addedColumns, ['email']);
    assert.equal(diff.statements.length, 0);
    assert.equal(diff.warnings.length, 1);
    assert.match(diff.warnings[0]!, /NOT NULL without a DEFAULT/);
  });

  it('detects removed columns with a rebuild warning', () => {
    const to: TableDef = {
      ...from,
      columns: {
        id: from.columns.id!,
        name: from.columns.name!,
      },
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.removedColumns, ['age']);
    assert.match(diff.warnings[0]!, /was removed/);
  });

  it('detects changed columns with a rebuild warning', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        age: { type: 'REAL' },
      },
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.changedColumns, ['age']);
    assert.match(diff.warnings[0]!, /cannot ALTER COLUMN in place/);
  });

  it('detects added, removed, and changed indexes', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        email: { type: 'TEXT' },
      },
      indexes: [
        { name: 'idx_users_email', columns: ['email'], unique: true },
      ],
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.removedIndexes, ['idx_users_name']);
    assert.deepEqual(diff.addedIndexes, ['idx_users_email']);
    assert.ok(diff.statements.some((s) => s.includes('DROP INDEX IF EXISTS "idx_users_name"')));
    assert.ok(diff.statements.some((s) => s.includes('CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email"')));
  });

  it('reports identical schemas as no-op', () => {
    const diff = schemaDiff(from, { ...from, columns: { ...from.columns } });
    assert.deepEqual(diff.addedColumns, []);
    assert.deepEqual(diff.removedColumns, []);
    assert.deepEqual(diff.changedColumns, []);
    assert.deepEqual(diff.statements, []);
    assert.deepEqual(diff.warnings, []);
  });

  it('ignores column comment changes (documentation-only, no structural impact)', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        name: { type: 'TEXT', notNull: true, comment: 'display name' },
        age: { type: 'INTEGER', comment: 'years' },
      },
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.addedColumns, []);
    assert.deepEqual(diff.removedColumns, []);
    assert.deepEqual(diff.changedColumns, []);
    assert.deepEqual(diff.statements, []);
    assert.deepEqual(diff.warnings, []);
  });

  it('ignores table-level comment changes (documentation-only)', () => {
    const fromT: TableDef = {
      name: 't',
      comment: 'v1',
      columns: { id: { type: 'INTEGER' } },
    };
    const toT: TableDef = {
      name: 't',
      comment: 'v2',
      columns: { id: { type: 'INTEGER' } },
    };
    const diff = schemaDiff(fromT, toT);
    assert.deepEqual(diff.addedColumns, []);
    assert.deepEqual(diff.removedColumns, []);
    assert.deepEqual(diff.changedColumns, []);
    assert.deepEqual(diff.statements, []);
    assert.deepEqual(diff.warnings, []);
  });

  it('warns when adding a PRIMARY KEY column', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        uuid: { type: 'TEXT', primaryKey: true },
      },
    };
    const diff = schemaDiff(from, to);
    assert.deepEqual(diff.addedColumns, ['uuid']);
    assert.equal(diff.statements.length, 0);
    assert.match(diff.warnings[0]!, /cannot be added with ALTER TABLE/);
  });

  it('detects table-level option changes (strict / withoutRowId / checks)', () => {
    const strictTo: TableDef = { ...from, strict: true };
    const strictDiff = schemaDiff(from, strictTo);
    assert.match(strictDiff.warnings[0]!, /"strict" changed/);
    assert.match(strictDiff.warnings[0]!, /table-rebuild/);

    const rowidTo: TableDef = { ...from, withoutRowId: true };
    const rowidDiff = schemaDiff(from, rowidTo);
    assert.match(rowidDiff.warnings[0]!, /"withoutRowId" changed/);

    const checksTo: TableDef = { ...from, checks: ['a > 0'] };
    const checksDiff = schemaDiff(from, checksTo);
    assert.match(checksDiff.warnings[0]!, /CHECK constraints changed/);
  });

  it('reports table option changes in generated migration SQL', () => {
    const sql = generateMigrationSql(from, { ...from, strict: true });
    assert.match(sql, /"strict" changed/);
    assert.doesNotMatch(sql, /No schema differences/);
  });
});

describe('generateMigrationSql', () => {
  it('wraps safe statements with a review section', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        email: { type: 'TEXT' },
        nickname: { type: 'TEXT', notNull: true },
      },
    };
    const sql = generateMigrationSql(from, to, '-- auto-generated');
    assert.match(sql, /-- auto-generated/);
    assert.match(sql, /Safe statements/);
    assert.match(sql, /ALTER TABLE "users" ADD COLUMN "email" TEXT/);
    assert.match(sql, /Manual review required/);
    assert.match(sql, /nickname.*NOT NULL without a DEFAULT/);
  });

  it('notes when there is nothing to migrate', () => {
    const sql = generateMigrationSql(from, { ...from, columns: { ...from.columns } });
    assert.match(sql, /No schema differences/);
  });
});

describe('schemaDiff edge cases', () => {
  it('flags FK columns with non-NULL defaults as requiring a rebuild', () => {
    const to: TableDef = {
      ...from,
      columns: {
        ...from.columns,
        orgId: {
          type: 'INTEGER',
          references: { table: 'orgs', column: 'id' },
          default: 1,
        },
      },
    };
    const diff = schemaDiff(from, to);
    assert.equal(diff.statements.length, 0, 'must not emit an ALTER TABLE SQLite rejects');
    assert.match(diff.warnings.join('\n'), /FOREIGN KEY with a non-NULL DEFAULT/);
  });
});
