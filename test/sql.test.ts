/**
 * sql() tagged template and identifier quoting tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql, raw, quoteIdent, quoteTable, isFragment, isIdent } from '../src/index.ts';

describe('sql tag', () => {
  it('quotes identifiers and collects literals as params', () => {
    const q = sql`SELECT * FROM ${sql.ident('users')} WHERE ${sql.ident('name')} = ${'alice'}`;
    assert.equal(q.text, 'SELECT * FROM "users" WHERE "name" = ?');
    assert.deepEqual(q.params, ['alice']);
  });

  it('carries a fragment as raw sql without re-quoting', () => {
    const table = raw('"users"');
    const q = sql`SELECT * FROM ${table} WHERE ${sql.ident('name')} = ${'alice'}`;
    assert.equal(q.text, 'SELECT * FROM "users" WHERE "name" = ?');
    assert.deepEqual(q.params, ['alice']);
  });

  it('treats plain string values as bound params for safety', () => {
    // Strings are never identifiers — they become ? placeholders, preventing injection.
    const q = sql`SELECT * FROM ${'users; DROP TABLE users'}`;
    assert.equal(q.text, 'SELECT * FROM ?');
    assert.deepEqual(q.params, ['users; DROP TABLE users']);
  });

  it('rejects invalid identifiers via sql.ident', () => {
    assert.throws(
      () => sql.ident('users; DROP TABLE users'),
      /Invalid identifier/,
    );
  });

  it('handles empty template', () => {
    const q = sql``;
    assert.equal(q.text, '');
    assert.deepEqual(q.params, []);
  });
});

describe('quoteIdent / quoteTable', () => {
  it('quotes simple identifiers', () => {
    assert.equal(quoteIdent('users'), '"users"');
    assert.equal(quoteTable('users'), '"users"');
  });

  it('rejects identifiers with embedded quotes', () => {
    assert.throws(() => quoteIdent('a"b'), /Invalid SQL identifier/);
  });

  it('supports dotted names via quoteTable', () => {
    assert.equal(quoteTable('main.users'), '"main"."users"');
  });

  it('supports table aliases in quoteTable (AS and bare forms)', () => {
    assert.equal(quoteTable('users AS u'), '"users" AS "u"');
    assert.equal(quoteTable('users as u'), '"users" AS "u"');
    assert.equal(quoteTable('users u'), '"users" AS "u"');
  });

  it('rejects invalid identifiers', () => {
    for (const bad of ['', 'a b', '1abc', 'a;b', 'a-b']) {
      assert.throws(() => quoteIdent(bad), /Invalid SQL identifier/, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('isFragment', () => {
  it('distinguishes fragments from strings', () => {
    const f = raw('COUNT(*)');
    assert.equal(isFragment(f), true);
    assert.equal(isFragment('COUNT(*)'), false);
    assert.equal(isFragment(42), false);
  });
});

describe('isIdent', () => {
  it('distinguishes identifiers from strings', () => {
    const ident = sql.ident('users');
    assert.equal(isIdent(ident), true);
    assert.equal(isIdent('users'), false);
    assert.equal(isIdent(sql`users`), false);
  });
});

describe('quoteTable', () => {
  it('quotes plain table names', () => {
    assert.equal(quoteTable('users'), '"users"');
  });

  it('splits a dotted schema.table', () => {
    assert.equal(quoteTable('audit.logs'), '"audit"."logs"');
  });

  it('handles an alias via space ("table alias")', () => {
    assert.equal(quoteTable('users u'), '"users" AS "u"');
    assert.equal(quoteTable('users AS u'), '"users" AS "u"');
  });
});

describe('sql tag misuse', () => {
  it('throws when called as a plain function, not a tagged template', () => {
    // @ts-expect-error — intentional misuse
    assert.throws(() => sql('SELECT 1'), /tagged template/i);
  });
});