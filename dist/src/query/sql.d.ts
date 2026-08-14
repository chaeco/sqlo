/**
 * Safe SQL composition helpers.
 *
 * - `sql\`...\`` — tagged template that builds a SqlFragment with bound params.
 * - `sql.ident('col')` — safely quoted identifier.
 * - `sql.raw(text, params?)` — manual fragment.
 * - `quoteIdent(name)` — double-quote and escape a SQL identifier.
 */
import type { SqlFragment, Ident } from '../schema/types.js';
/**
 * Double-quote a SQL identifier (table name, column name), splitting on `.`.
 * Throws on invalid characters.
 */
export declare function quoteIdent(name: string): string;
/**
 * Quote a table reference (supports "table AS alias").
 */
export declare function quoteTable(table: string): string;
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
export declare function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment;
export declare namespace sql {
    var ident: (name: string) => Ident;
}
/**
 * Create a SqlFragment manually (no param binding applied — caller is responsible).
 */
export declare function raw(text: string, params?: readonly unknown[]): SqlFragment;
/**
 * Type guard — is `v` a `SqlFragment` (created by `sql\`...\`` or `raw()`)?
 */
export declare function isFragment(v: unknown): v is SqlFragment;
/**
 * Type guard — is `v` an `Ident` (created by `sql.ident()`)?
 */
export declare function isIdent(v: unknown): v is Ident;
//# sourceMappingURL=sql.d.ts.map