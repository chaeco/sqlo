/**
 * DDL (Data Definition Language) generators.
 * Translates a TableDef into CREATE TABLE / CREATE INDEX statements.
 */
import { isFragment, quoteIdent } from "../query/sql.js";
// ---------------------------------------------------------------------------
// Fragment coercion
// ---------------------------------------------------------------------------
/**
 * Coerce a CHECK/WHERE expression to a SqlFragment.
 * Plain strings are treated as raw SQL with no bound params.
 */
function toFragment(x) {
    if (typeof x === 'string') {
        return { text: x, params: [] };
    }
    return x;
}
// ---------------------------------------------------------------------------
// Literal → SQLite default value representation
// ---------------------------------------------------------------------------
function escapeDefaultLiteral(value) {
    if (value === null || value === undefined)
        return 'NULL';
    if (typeof value === 'number')
        return String(value);
    if (typeof value === 'bigint')
        return String(value);
    if (typeof value === 'boolean')
        return value ? '1' : '0';
    if (isFragment(value)) {
        if (value.params.length > 0) {
            throw new Error('DEFAULT clause cannot contain bound parameters. ' +
                'Use a plain SQL fragment without params, e.g. sql`(datetime(\'now\'))`.');
        }
        return value.text;
    }
    // string
    const s = String(value);
    return `'${s.replace(/'/g, "''")}'`;
}
// ---------------------------------------------------------------------------
// Column DDL
// ---------------------------------------------------------------------------
/**
 * Generate the column definition fragment (everything after the column
 * name) for a single column: type, constraints, defaults, CHECK, and
 * foreign key references.
 *
 * @param col The column definition.
 * @returns A fragment like `TEXT NOT NULL DEFAULT 'draft'` or
 *   `INTEGER PRIMARY KEY AUTOINCREMENT`.
 */
export function columnDDL(col) {
    const parts = [];
    parts.push(col.type.toUpperCase());
    if (col.primaryKey)
        parts.push('PRIMARY KEY');
    if (col.autoIncrement)
        parts.push('AUTOINCREMENT');
    if (col.notNull)
        parts.push('NOT NULL');
    if (col.unique)
        parts.push('UNIQUE');
    if (col.collate !== undefined)
        parts.push(`COLLATE ${col.collate}`);
    if (col.default !== undefined)
        parts.push(`DEFAULT ${escapeDefaultLiteral(col.default)}`);
    if (col.check) {
        const chk = toFragment(col.check);
        if (chk.params.length > 0) {
            throw new Error(`Column CHECK constraint cannot contain bound parameters.`);
        }
        parts.push(`CHECK (${chk.text})`);
    }
    if (col.references) {
        const ref = col.references;
        let clause = `REFERENCES ${quoteIdent(ref.table)}(${quoteIdent(ref.column)})`;
        if (ref.onDelete)
            clause += ` ON DELETE ${ref.onDelete}`;
        if (ref.onUpdate)
            clause += ` ON UPDATE ${ref.onUpdate}`;
        parts.push(clause);
    }
    return parts.join(' ');
}
// ---------------------------------------------------------------------------
// Full CREATE TABLE
// ---------------------------------------------------------------------------
/**
 * Generate a `CREATE TABLE IF NOT EXISTS` statement from a table definition.
 * Columns, table-level CHECK constraints, `STRICT` and `WITHOUT ROWID`
 * options are all included.
 *
 * @param schema The table definition.
 * @returns A complete `CREATE TABLE IF NOT EXISTS "name" (...)` statement.
 */
export function tableDDL(schema) {
    const lines = [];
    const colNames = Object.keys(schema.columns);
    for (const name of colNames) {
        const col = schema.columns[name];
        lines.push(`  ${quoteIdent(name)} ${columnDDL(col)}`);
    }
    // Table-level CHECK constraints
    if (schema.checks) {
        for (let i = 0; i < schema.checks.length; i++) {
            const chk = toFragment(schema.checks[i]);
            if (chk.params.length > 0) {
                throw new Error(`CHECK constraint #${i} on table "${schema.name}" cannot contain bound parameters.`);
            }
            lines.push(`  CONSTRAINT "chk_${schema.name}_${i}" CHECK (${chk.text})`);
        }
    }
    const body = lines.join(',\n');
    let sql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema.name)} (\n${body}\n)`;
    if (schema.strict)
        sql += ' STRICT';
    if (schema.withoutRowId)
        sql += ' WITHOUT ROWID';
    return sql;
}
// ---------------------------------------------------------------------------
// Index DDL
// ---------------------------------------------------------------------------
/**
 * Generate `CREATE [UNIQUE] INDEX IF NOT EXISTS` statements for every index
 * declared in the table definition, including partial-index `WHERE` clauses
 * and per-column sort directions.
 *
 * @param schema The table definition.
 * @returns One `CREATE INDEX` statement per declared index; an empty array
 *   when the schema declares no indexes.
 */
export function indexDDLs(schema) {
    if (!schema.indexes || schema.indexes.length === 0)
        return [];
    return schema.indexes.map((idx) => {
        const colList = idx.columns.map((c) => {
            if (typeof c === 'string')
                return quoteIdent(c);
            return `${quoteIdent(c.name)}${c.direction ? ` ${c.direction}` : ''}`;
        }).join(', ');
        const unique = idx.unique ? 'UNIQUE ' : '';
        let sql = `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(idx.name)} ON ${quoteIdent(schema.name)} (${colList})`;
        if (idx.where) {
            sql += ` WHERE ${toFragment(idx.where).text}`;
        }
        return sql;
    });
}
//# sourceMappingURL=ddl.js.map