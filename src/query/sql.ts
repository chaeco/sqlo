/**
 * Safe SQL composition helpers.
 *
 * - `sql\`...\`` — tagged template that builds a SqlFragment with bound params.
 * - `sql.ident('col')` — safely quoted identifier.
 * - `sql.raw(text, params?)` — manual fragment.
 * - `quoteIdent(name)` — double-quote and escape a SQL identifier.
 */

import type { SqlFragment, Ident } from '../schema/types';
import { SQL_FRAGMENT, SQL_IDENT } from '../schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_$]*)(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

/**
 * Double-quote a SQL identifier (table name, column name), splitting on `.`.
 * Throws on invalid characters.
 */
export function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `Invalid SQL identifier: "${name}". ` +
      'Identifiers must match /[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)*/',
    );
  }
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

/**
 * Quote a table reference (supports "table AS alias").
 */
export function quoteTable(table: string): string {
  const parts = table.split(/\s+as\s+/i);
  if (parts.length === 2) {
    const [t, alias] = parts as [string, string];
    return `${quoteIdent(t)} AS ${quoteIdent(alias)}`;
  }
  // Without alias, split on whitespace (e.g. "table alias")
  const space = table.lastIndexOf(' ');
  if (space > 0) {
    const t = table.slice(0, space).trim();
    const alias = table.slice(space + 1).trim();
    if (t && alias && IDENT_RE.test(t) && IDENT_RE.test(alias)) {
      return `${quoteIdent(t)} AS ${quoteIdent(alias)}`;
    }
  }
  return quoteIdent(table);
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

function isTemplateStringsArray(v: unknown): v is TemplateStringsArray {
  return (
    Array.isArray(v) &&
    Object.prototype.hasOwnProperty.call(v, 'raw')
  );
}

// ---------------------------------------------------------------------------
// sql tagged template
// ---------------------------------------------------------------------------

/**
 * Tagged template for safe SQL composition.
 *
 * ```ts
 * sql\`SELECT * FROM users WHERE name = ${name}\`
 * ```
 *
 * Interpolated values become `?` placeholders with auto-collected parameters.
 * Use `sql.ident(...)` to interpolate identifiers (safe auto-quoting).
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlFragment {
  if (!isTemplateStringsArray(strings)) {
    throw new TypeError(
      'sql\`...\` must be used as a tagged template literal, not a function call.',
    );
  }
  const parts: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < strings.length; i++) {
    parts.push(strings[i]!);
    if (i < values.length) {
      const v = values[i]!;
      if (isFragment(v)) {
        parts.push(v.text);
        params.push(...v.params);
      } else if (isIdent(v)) {
        parts.push(quoteIdent(v.value));
      } else {
        parts.push('?');
        params.push(v);
      }
    }
  }

  return Object.freeze({
    [SQL_FRAGMENT]: true as const,
    text: parts.join(''),
    params,
  });
}

// ---------------------------------------------------------------------------
// Raw fragment helper
// ---------------------------------------------------------------------------

/**
 * Create a SqlFragment manually (no param binding applied — caller is responsible).
 */
export function raw(text: string, params: readonly unknown[] = []): SqlFragment {
  return Object.freeze({
    [SQL_FRAGMENT]: true as const,
    text,
    params,
  });
}

// ---------------------------------------------------------------------------
// Identifier helper
// ---------------------------------------------------------------------------

sql.ident = function ident(name: string): Ident {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `Invalid identifier: "${name}". ` +
      'Must match /[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)*/',
    );
  }
  return Object.freeze({
    [SQL_IDENT]: true as const,
    value: name,
  });
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Type guard — is `v` a `SqlFragment` (created by `sql\`...\`` or `raw()`)?
 */
export function isFragment(v: unknown): v is SqlFragment {
  return typeof v === 'object' && v !== null && (v as SqlFragment)[SQL_FRAGMENT] === true;
}

/**
 * Type guard — is `v` an `Ident` (created by `sql.ident()`)?
 */
export function isIdent(v: unknown): v is Ident {
  return typeof v === 'object' && v !== null && (v as Ident)[SQL_IDENT] === true;
}