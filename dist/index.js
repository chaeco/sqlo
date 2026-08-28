import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

/**
 * Schema validation.
 *
 * `validateSchema` checks a `TableDef` for structural errors (missing type,
 * bad autoIncrement/references/CHECK combos, unknown index columns, …) and
 * returns non-fatal warnings (e.g. non-standard column type names, which
 * SQLite accepts via type affinity). It is shared by `db.define()` and
 * `loadTableDefSync()` so that JSON-loaded table definitions are validated at
 * load time, not deferred until `define()`.
 *
 * `schemaHasReferences` is used to warn when foreign keys are declared but the
 * connection has `enableForeignKeyConstraints: false`.
 */
const VALID_COLUMN_TYPES = new Set([
    'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
    'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP',
    'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'CLOB',
    'DOUBLE', 'FLOAT', 'DECIMAL', 'TINYINT', 'SMALLINT',
    'MEDIUMINT', 'BIGINT', 'INT', 'INT2', 'INT8',
]);
const VALID_REF_ACTIONS = new Set([
    'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION',
]);
function schemaHasReferences(schema) {
    return Object.values(schema.columns).some((col) => col.references !== undefined);
}
function validateSchema(schema) {
    const errors = [];
    const warnings = [];
    if (!schema.name) {
        errors.push('Table name is required.');
    }
    else if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(schema.name)) {
        errors.push(`Invalid table name: "${schema.name}". ` +
            'Use "table" or "schema.table" (for attached databases).');
    }
    const colNames = Object.keys(schema.columns);
    if (colNames.length === 0) {
        errors.push('At least one column is required.');
    }
    for (const name of colNames) {
        const col = schema.columns[name];
        if (!col.type) {
            errors.push(`Column "${name}" is missing a "type".`);
        }
        else if (!VALID_COLUMN_TYPES.has(col.type.toUpperCase())) {
            // SQLite accepts arbitrary type names (type affinity). Follow SQLite's
            // semantics but warn — a non-standard type name is often a typo.
            warnings.push(`Column "${name}" has a non-standard type "${col.type}". ` +
                'SQLite accepts it (type affinity), but ensure this is intentional.');
        }
        if (col.autoIncrement && (!col.primaryKey || col.type.toUpperCase() !== 'INTEGER')) {
            errors.push(`Column "${name}": autoIncrement requires type INTEGER and primaryKey=true.`);
        }
        if (col.references) {
            const ref = col.references;
            if (ref.onDelete && !VALID_REF_ACTIONS.has(ref.onDelete)) {
                errors.push(`Column "${name}": invalid onDelete "${ref.onDelete}".`);
            }
            if (ref.onUpdate && !VALID_REF_ACTIONS.has(ref.onUpdate)) {
                errors.push(`Column "${name}": invalid onUpdate "${ref.onUpdate}".`);
            }
        }
        if (col.check && typeof col.check !== 'string' && col.check.params.length > 0) {
            errors.push(`Column "${name}": CHECK constraint cannot contain bound parameters.`);
        }
    }
    // Validate indexes
    if (schema.indexes) {
        const idxNames = new Set();
        for (const idx of schema.indexes) {
            if (idxNames.has(idx.name)) {
                errors.push(`Duplicate index name: "${idx.name}".`);
            }
            idxNames.add(idx.name);
            if (idx.columns.length === 0) {
                errors.push(`Index "${idx.name}" has no columns.`);
            }
            for (const c of idx.columns) {
                const colName = typeof c === 'string' ? c : c.name;
                if (!schema.columns[colName]) {
                    errors.push(`Index "${idx.name}" references unknown column "${colName}".`);
                }
            }
            if (idx.where && typeof idx.where !== 'string' && idx.where.params.length > 0) {
                errors.push(`Index "${idx.name}": WHERE clause cannot contain bound parameters.`);
            }
        }
    }
    // Validate table-level CHECK constraints
    if (schema.checks) {
        for (let i = 0; i < schema.checks.length; i++) {
            const chk = schema.checks[i];
            if (typeof chk !== 'string' && chk.params.length > 0) {
                errors.push(`CHECK constraint #${i} on table "${schema.name}" cannot contain bound parameters.`);
            }
        }
    }
    return { errors, warnings };
}

/**
 * Sqlo type definitions.
 * All canonical types live here — column definitions, table schemas,
 * type inference helpers, and where expression operators.
 */
// ---------------------------------------------------------------------------
// Symbol brands for SqlFragment and Ident
// ---------------------------------------------------------------------------
const SQL_FRAGMENT = Symbol('sqlo.sqlFragment');
const SQL_IDENT = Symbol('sqlo.sqlIdent');

/**
 * Safe SQL composition helpers.
 *
 * - `sql\`...\`` — tagged template that builds a SqlFragment with bound params.
 * - `sql.ident('col')` — safely quoted identifier.
 * - `sql.raw(text, params?)` — manual fragment.
 * - `quoteIdent(name)` — double-quote and escape a SQL identifier.
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const IDENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_$]*)(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/;
/**
 * Double-quote a SQL identifier (table name, column name), splitting on `.`.
 * Throws on invalid characters.
 */
function quoteIdent(name) {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid SQL identifier: "${name}". ` +
            'Identifiers must match /[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)*/');
    }
    return name
        .split('.')
        .map((part) => `"${part.replace(/"/g, '""')}"`)
        .join('.');
}
/**
 * Quote a table reference (supports "table AS alias").
 */
function quoteTable(table) {
    const parts = table.split(/\s+as\s+/i);
    if (parts.length === 2) {
        const [t, alias] = parts;
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
function isTemplateStringsArray(v) {
    return (Array.isArray(v) &&
        Object.prototype.hasOwnProperty.call(v, 'raw'));
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
function sql(strings, ...values) {
    if (!isTemplateStringsArray(strings)) {
        throw new TypeError('sql\`...\` must be used as a tagged template literal, not a function call.');
    }
    const parts = [];
    const params = [];
    for (let i = 0; i < strings.length; i++) {
        parts.push(strings[i]);
        if (i < values.length) {
            const v = values[i];
            if (isFragment(v)) {
                parts.push(v.text);
                params.push(...v.params);
            }
            else if (isIdent(v)) {
                parts.push(quoteIdent(v.value));
            }
            else {
                parts.push('?');
                params.push(v);
            }
        }
    }
    return Object.freeze({
        [SQL_FRAGMENT]: true,
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
function raw(text, params = []) {
    return Object.freeze({
        [SQL_FRAGMENT]: true,
        text,
        params,
    });
}
// ---------------------------------------------------------------------------
// Identifier helper
// ---------------------------------------------------------------------------
sql.ident = function ident(name) {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid identifier: "${name}". ` +
            'Must match /[A-Za-z_][A-Za-z0-9_$]*(\\.[A-Za-z_][A-Za-z0-9_$]*)*/');
    }
    return Object.freeze({
        [SQL_IDENT]: true,
        value: name,
    });
};
// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
/**
 * Type guard — is `v` a `SqlFragment` (created by `sql\`...\`` or `raw()`)?
 */
function isFragment(v) {
    return typeof v === 'object' && v !== null && v[SQL_FRAGMENT] === true;
}
/**
 * Type guard — is `v` an `Ident` (created by `sql.ident()`)?
 */
function isIdent(v) {
    return typeof v === 'object' && v !== null && v[SQL_IDENT] === true;
}

/**
 * DDL (Data Definition Language) generators.
 * Translates a TableDef into CREATE TABLE / CREATE INDEX statements.
 */
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
function columnDDL(col) {
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
function tableDDL(schema) {
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
function indexDDLs(schema) {
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

/**
 * Fluent SQLite query builder.
 * Generates SELECT statements with parameter binding.
 */
var _a;
// ---------------------------------------------------------------------------
// QueryBuilder
// ---------------------------------------------------------------------------
/**
 * Fluent SQLite SELECT query builder.
 *
 * Builds a parameter-bound SELECT statement through method chaining and
 * executes it with `all()` / `first()` / `count()` / `pluck()`. Obtain one
 * via `model.query()`.
 */
class QueryBuilder {
    #s;
    #exec;
    /**
     * @param exec Executor that runs prepared statements (usually a Sqlo).
     * @param table Table name to query (`"table"` or `"schema.table"`).
     */
    constructor(exec, table) {
        this.#exec = exec;
        this.#s = {
            selectCols: null,
            distinct: false,
            table,
            joins: [],
            whereGroups: [],
            groupBys: [],
            havings: [],
            orderBys: [],
            limitV: null,
            offsetV: null,
        };
    }
    // ---- SELECT ----
    /**
     * Restrict the SELECT to the given columns (quoted as identifiers).
     * Calling with no arguments resets to `SELECT *`.
     */
    select(...cols) {
        this.#s.selectCols = cols.map((c) => quoteIdent(c));
        return this;
    }
    /** Emit `SELECT DISTINCT` to de-duplicate result rows. */
    distinct() {
        this.#s.distinct = true;
        return this;
    }
    // ---- JOIN ----
    #join(type, table, on) {
        this.#s.joins.push({ type, table, on });
        return this;
    }
    /** INNER JOIN `table` on a `sql\`...\`` ON clause. */
    join(table, on) {
        return this.#join('INNER', table, on);
    }
    /** LEFT JOIN `table` on a `sql\`...\`` ON clause. */
    leftJoin(table, on) {
        return this.#join('LEFT', table, on);
    }
    /** RIGHT JOIN `table` on a `sql\`...\`` ON clause. */
    rightJoin(table, on) {
        return this.#join('RIGHT', table, on);
    }
    /** FULL OUTER JOIN `table` on a `sql\`...\`` ON clause. */
    fullJoin(table, on) {
        return this.#join('FULL', table, on);
    }
    // ---- WHERE ----
    /**
     * Add a condition combined with the existing ones via AND.
     * Accepts a plain-object expression (`{ age: { gte: 18 } }`, `{ id: [1,2] }`,
     * `{ name: null }`) or a `sql\`...\`` fragment.
     */
    where(cond) {
        this.#s.whereGroups.push({ type: 'AND', fragments: this.#objectToFragments(cond) });
        return this;
    }
    /**
     * Add a condition combined with the existing ones via OR.
     * Same accepted shapes as `where()`.
     */
    orWhere(cond) {
        this.#s.whereGroups.push({ type: 'OR', fragments: this.#objectToFragments(cond) });
        return this;
    }
    /**
     * Append a raw SQL fragment as an AND condition (no param binding).
     * Prefer `where(sql\`...\`)` for safety.
     */
    raw(fragment) {
        if (typeof fragment === 'string') {
            fragment = { text: fragment, params: [], $$sql: true };
        }
        this.#s.whereGroups.push({ type: 'AND', fragments: [fragment] });
        return this;
    }
    // ---- GROUP / HAVING / ORDER ----
    /** GROUP BY the given columns (quoted as identifiers). */
    groupBy(...cols) {
        this.#s.groupBys.push(...cols.map((c) => quoteIdent(c)));
        return this;
    }
    /** HAVING condition on aggregated groups — same shapes as `where()`. */
    having(cond) {
        this.#s.havings.push({ type: 'AND', fragments: this.#objectToFragments(cond) });
        return this;
    }
    /**
     * ORDER BY a column (quoted) or a `sql\`...\`` fragment, with an optional
     * direction (`'ASC'` default, or `'DESC'`).
     */
    orderBy(col, dir = 'ASC') {
        if (isFragment(col)) {
            this.#s.orderBys.push({ col: col.text, dir: dir.toUpperCase() });
            return this;
        }
        this.#s.orderBys.push({ col: quoteIdent(col), dir: dir.toUpperCase() });
        return this;
    }
    /** LIMIT the number of returned rows (bound as a parameter). */
    limit(n) {
        this.#s.limitV = n;
        return this;
    }
    /** OFFSET the result window (bound as a parameter; usually paired with `limit()`). */
    offset(n) {
        this.#s.offsetV = n;
        return this;
    }
    // ---- Build SQL ----
    /**
     * Build only the WHERE clause (with params) for the current query state.
     * Returns `{ clause, params }` where `clause` is the full
     * `WHERE ...` fragment (or `''` when no conditions were added).
     *
     * Used by `Model#update` / `Model#delete` to compose UPDATE/DELETE
     * statements without re-parsing a complete SELECT — avoids fragile
     * string slicing on the compiled SQL.
     */
    buildWhere() {
        const params = [];
        const clause = this.#buildWhereClauses(this.#s.whereGroups, params);
        return { clause, params };
    }
    /**
     * Returns the compiled SQL string and bound parameters.
     */
    toSql() {
        const parts = [];
        const params = [];
        // SELECT
        let select = 'SELECT ';
        if (this.#s.distinct)
            select += 'DISTINCT ';
        if (this.#s.selectCols && this.#s.selectCols.length > 0) {
            select += this.#s.selectCols.join(', ');
        }
        else {
            select += '*';
        }
        parts.push(select);
        // FROM
        parts.push(`FROM ${quoteTable(this.#s.table)}`);
        // JOINs
        for (const join of this.#s.joins) {
            const jt = join.type === 'INNER' ? 'JOIN' : `${join.type} JOIN`;
            parts.push(`${jt} ${quoteTable(join.table)} ON ${join.on.text}`);
            params.push(...join.on.params);
        }
        // WHERE
        const whereSql = this.#buildWhereClauses(this.#s.whereGroups, params);
        if (whereSql)
            parts.push(whereSql);
        // GROUP BY
        if (this.#s.groupBys.length > 0) {
            parts.push(`GROUP BY ${this.#s.groupBys.join(', ')}`);
        }
        // HAVING
        const havingSql = this.#buildWhereClauses(this.#s.havings, params, 'HAVING');
        if (havingSql)
            parts.push(havingSql);
        // ORDER BY
        if (this.#s.orderBys.length > 0) {
            parts.push(`ORDER BY ${this.#s.orderBys.map((o) => `${o.col} ${o.dir}`).join(', ')}`);
        }
        // LIMIT / OFFSET
        if (this.#s.limitV !== null) {
            parts.push('LIMIT ?');
            params.push(this.#s.limitV);
        }
        if (this.#s.offsetV !== null) {
            parts.push('OFFSET ?');
            params.push(this.#s.offsetV);
        }
        return { sql: parts.join(' '), params };
    }
    // ---- Execute ----
    /**
     * Execute and return all matching rows.
     */
    all() {
        const { sql, params } = this.toSql();
        const stmt = this.#exec.prepare(sql);
        return stmt.all(...params);
    }
    /**
     * Execute and return the first row, or undefined if none.
     * Does not mutate the builder — the underlying LIMIT 1 is applied on a
     * copy, so the builder stays reusable afterwards.
     */
    first() {
        const q = this.#clone().limit(1).toSql();
        const stmt = this.#exec.prepare(q.sql);
        return stmt.get(...q.params);
    }
    /**
     * Execute COUNT query.
     */
    count() {
        const params = [];
        let countSql;
        if (this.#s.groupBys.length > 0 || this.#s.joins.length > 0) {
            // Wrap in subquery to handle GROUP BY / JOIN row multiplication
            const inner = this.toSql();
            countSql = `SELECT COUNT(*) AS "c" FROM (${inner.sql})`;
            params.push(...inner.params);
        }
        else {
            countSql = `SELECT COUNT(*) AS "c" FROM ${quoteTable(this.#s.table)}`;
            const whereClause = this.#buildWhereClauses(this.#s.whereGroups, params);
            if (whereClause)
                countSql += ` ${whereClause}`;
        }
        const stmt = this.#exec.prepare(countSql);
        const row = stmt.get(...params);
        return row?.c ?? 0;
    }
    /**
     * Execute and return values of a single column.
     * Does not mutate the builder — projection is applied on a copy.
     */
    pluck(col) {
        const { sql, params } = this.#clone().select(col).toSql();
        const stmt = this.#exec.prepare(sql);
        const rows = stmt.all(...params);
        return rows.map((r) => r[col]);
    }
    // ---- Internal helpers ----
    /**
     * Return a shallow copy of this builder with the same query state.
     * Used by terminal methods (first, pluck) so they don't mutate the
     * original builder, keeping it reusable for further chaining.
     */
    #clone() {
        const copy = new _a(this.#exec, this.#s.table);
        copy.#s = {
            selectCols: this.#s.selectCols ? [...this.#s.selectCols] : null,
            distinct: this.#s.distinct,
            table: this.#s.table,
            joins: [...this.#s.joins],
            whereGroups: this.#s.whereGroups.map((g) => ({
                type: g.type,
                fragments: [...g.fragments],
            })),
            groupBys: [...this.#s.groupBys],
            havings: this.#s.havings.map((g) => ({
                type: g.type,
                fragments: [...g.fragments],
            })),
            orderBys: [...this.#s.orderBys],
            limitV: this.#s.limitV,
            offsetV: this.#s.offsetV,
        };
        return copy;
    }
    #buildWhereClauses(groups, params, keyword = 'WHERE') {
        if (groups.length === 0)
            return '';
        const groupSqls = [];
        for (const group of groups) {
            const frags = group.fragments;
            if (frags.length === 0)
                continue;
            const combined = frags
                .map((f) => {
                params.push(...f.params);
                return f.text;
            })
                .join(' AND ');
            groupSqls.push(combined);
        }
        if (groupSqls.length === 0)
            return '';
        // Build group joining: consecutive groups with the same operator join naturally;
        // when the operator changes, parenthesize the accumulated result only if it is
        // already compound (multiple conditions), to avoid noisy single-condition parens.
        let result = groupSqls[0];
        let lastOp = groups[0].type;
        let compound = result.includes(' AND ') || result.includes(' OR ');
        for (let i = 1; i < groupSqls.length; i++) {
            const op = groups[i].type;
            const cur = groupSqls[i];
            if (op === lastOp) {
                result += ` ${op} ${cur}`;
                compound = true;
            }
            else {
                if (compound)
                    result = `(${result})`;
                result += ` ${op} ${cur}`;
                compound = true;
                lastOp = op;
            }
        }
        return `${keyword} ${result}`;
    }
    #objectToFragments(cond) {
        if (isFragment(cond))
            return [cond];
        const fragments = [];
        const entries = Object.entries(cond);
        for (const [key, val] of entries) {
            if (val === undefined)
                continue;
            const col = quoteIdent(key);
            fragments.push(this.#valueToFragment(col, val));
        }
        return fragments;
    }
    #valueToFragment(col, val) {
        // null
        if (val === null) {
            return { text: `${col} IS NULL`, params: [] };
        }
        // array → IN
        if (Array.isArray(val)) {
            if (val.length === 0) {
                return { text: '0', params: [] };
            }
            const placeholders = val.map(() => '?').join(', ');
            return { text: `${col} IN (${placeholders})`, params: extractValues(val) };
        }
        // WhereOps object
        if (typeof val === 'object' && val !== null) {
            const ops = val;
            const fragments = [];
            for (const [op, opVal] of Object.entries(ops)) {
                if (opVal === undefined)
                    continue;
                const f = this.#opToFragment(col, op, opVal);
                if (f)
                    fragments.push(f);
            }
            if (fragments.length === 0) {
                return { text: '1', params: [] };
            }
            // Multiple ops on same column: AND-join them
            const combined = fragments.map((f) => f.text).join(' AND ');
            const paramList = fragments.flatMap((f) => f.params);
            return { text: combined, params: paramList };
        }
        // plain value: col = ?
        return { text: `${col} = ?`, params: [val] };
    }
    #opToFragment(col, op, val) {
        switch (op) {
            case 'eq': return { text: `${col} = ?`, params: [val] };
            case 'ne': return { text: `${col} <> ?`, params: [val] };
            case 'gt': return { text: `${col} > ?`, params: [val] };
            case 'gte': return { text: `${col} >= ?`, params: [val] };
            case 'lt': return { text: `${col} < ?`, params: [val] };
            case 'lte': return { text: `${col} <= ?`, params: [val] };
            case 'like': return { text: `${col} LIKE ?`, params: [val] };
            case 'notLike': return { text: `${col} NOT LIKE ?`, params: [val] };
            case 'glob': return { text: `${col} GLOB ?`, params: [val] };
            case 'notGlob': return { text: `${col} NOT GLOB ?`, params: [val] };
            case 'in': {
                const arr = val;
                if (arr.length === 0)
                    return { text: '0', params: [] };
                const ph = arr.map(() => '?').join(', ');
                return { text: `${col} IN (${ph})`, params: extractValues(arr) };
            }
            case 'notIn': {
                const arr = val;
                if (arr.length === 0)
                    return { text: '1', params: [] };
                const ph = arr.map(() => '?').join(', ');
                return { text: `${col} NOT IN (${ph})`, params: extractValues(arr) };
            }
            case 'between': {
                const pair = val;
                return { text: `${col} BETWEEN ? AND ?`, params: [pair[0], pair[1]] };
            }
            case 'is': return { text: `${col} IS ?`, params: [val] };
            case 'isNot': return { text: `${col} IS NOT ?`, params: [val] };
            case 'isNull':
                return { text: val ? `${col} IS NULL` : `${col} IS NOT NULL`, params: [] };
            case 'notNull':
                return { text: val ? `${col} IS NOT NULL` : `${col} IS NULL`, params: [] };
            default:
                throw new Error(`Unknown where operator: "${op}"`);
        }
    }
}
_a = QueryBuilder;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractValues(arr) {
    return arr;
}

/**
 * Model — CRUD operations bound to a table schema.
 */
// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
/**
 * Typed CRUD operations bound to a single table schema.
 *
 * Created via `db.define(schema)`. Insert/read/update/delete methods are
 * type-driven by the schema's row, insert, and patch types. Tables are
 * created explicitly with `sync()` — never automatically.
 */
class Model {
    #schema;
    #exec;
    table;
    /**
     * @param exec Executor that runs prepared statements (usually a Sqlo).
     * @param schema The table definition that drives this model's types.
     */
    constructor(exec, schema) {
        this.#exec = exec;
        this.#schema = schema;
        this.table = schema.name;
    }
    // ---- Schema sync ----
    /**
     * Create the table (and indexes) if they do not exist.
     * Must be called explicitly — the ORM will not auto-create tables.
     */
    sync() {
        this.#exec.prepare(tableDDL(this.#schema)).run();
        for (const ddl of indexDDLs(this.#schema)) {
            this.#exec.prepare(ddl).run();
        }
    }
    // ---- INSERT ----
    /**
     * Insert a row and return the full row.
     */
    insert(data) {
        this.#validateKeys(data);
        const cols = Object.keys(data);
        if (cols.length === 0) {
            // INSERT with no columns: use DEFAULT VALUES
            this.#exec.prepare(`INSERT INTO ${quoteIdent(this.table)} DEFAULT VALUES`).run();
            return this.#resolveAfterInsert(data, this.#lastInsertRowid());
        }
        const colIdents = cols.map((c) => quoteIdent(c)).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const values = Object.values(data);
        const stmt = this.#exec.prepare(`INSERT INTO ${quoteIdent(this.table)} (${colIdents}) VALUES (${placeholders})`);
        const result = stmt.run(...values);
        return this.#resolveAfterInsert(data, result.lastInsertRowid);
    }
    /**
     * Insert multiple rows atomically — either all succeed or none are kept.
     *
     * Wrapped in a transaction when the executor supports it (Sqlo does).
     * When called inside an outer `db.transaction(...)`, this nests via
     * SAVEPOINT and participates in the outer commit/rollback.
     */
    /**
     * Insert multiple rows and return the inserted rows (with generated ids).
     * Wrapped in a transaction when the executor supports it (Sqlo does).
     * When called inside an outer `db.transaction(...)`, this nests via
     * SAVEPOINT and participates in the outer commit/rollback.
     *
     * For very large batches, pass `{ chunkSize }` to insert in chunks — each
     * chunk gets its own transaction (when not already inside an outer
     * transaction), keeping write-lock hold time and memory bounded. Errors
     * within a chunk roll back only that chunk; previously committed chunks
     * stay.
     *
     * @example
     * model.insertMany(rows, { chunkSize: 1000 });
     */
    insertMany(rows, options) {
        if (rows.length === 0)
            return [];
        const chunkSize = options?.chunkSize ?? rows.length;
        const tx = this.#exec.transaction;
        const results = [];
        if (chunkSize >= rows.length) {
            // Single batch — keep the existing atomic behaviour.
            if (tx) {
                return tx.call(this.#exec, () => rows.map((r) => this.insert(r)));
            }
            return rows.map((r) => this.insert(r));
        }
        for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);
            if (tx) {
                const inserted = tx.call(this.#exec, () => chunk.map((r) => this.insert(r)));
                results.push(...inserted);
            }
            else {
                results.push(...chunk.map((r) => this.insert(r)));
            }
        }
        return results;
    }
    // ---- SELECT ----
    /**
     * Find a row by its primary key (first primaryKey column).
     * Accepts number / bigint for INTEGER keys and string for TEXT/UUID keys.
     * Returns undefined if no rowid-based key column is found — use findOne() instead.
     */
    findById(id) {
        const pkCols = this.#pkColumns();
        if (pkCols.length === 0) {
            throw new Error(`Table "${this.table}" has no primary key column defined. Use findOne() instead.`);
        }
        const where = {};
        where[pkCols[0]] = id;
        return this.findOne(where);
    }
    /**
     * Find a single row matching the condition.
     */
    findOne(where) {
        const qb = this.query();
        qb.where(where);
        return qb.first();
    }
    /**
     * Find all rows matching the optional condition.
     */
    findAll(where) {
        const qb = this.query();
        if (where !== undefined)
            qb.where(where);
        return qb.all();
    }
    /**
     * Convenience: alias for findAll().
     */
    all() {
        return this.findAll();
    }
    // ---- UPDATE ----
    /**
     * Update rows matching the condition. Returns the number of affected rows.
     * The `where` argument is required — use `db.exec(...)` or model query builder for bulk updates.
     */
    update(patch, where) {
        this.#validateKeys(patch);
        const patchKeys = Object.keys(patch);
        if (patchKeys.length === 0)
            return 0;
        const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
        const patchValues = Object.values(patch);
        const qb = new QueryBuilder(this.#exec, this.table);
        qb.where(where);
        const { clause, params } = qb.buildWhere();
        if (!clause) {
            throw new Error('update() requires a WHERE condition. Use db.exec() for bulk updates.');
        }
        const updateSql = `UPDATE ${quoteIdent(this.table)} SET ${setClause}${clause}`;
        const stmt = this.#exec.prepare(updateSql);
        const result = stmt.run(...patchValues, ...params);
        return Number(result.changes);
    }
    // ---- DELETE ----
    /**
     * Delete rows matching the condition. Returns the number of deleted rows.
     * The `where` argument is required.
     */
    delete(where) {
        const qb = new QueryBuilder(this.#exec, this.table);
        qb.where(where);
        const { clause, params } = qb.buildWhere();
        if (!clause) {
            throw new Error('delete() requires a WHERE condition. Use db.exec() for bulk deletes.');
        }
        const stmt = this.#exec.prepare(`DELETE FROM ${quoteIdent(this.table)}${clause}`);
        const result = stmt.run(...params);
        return Number(result.changes);
    }
    /**
     * Delete all rows in the table. Returns the number of deleted rows.
     *
     * Explicit escape hatch — unlike `delete()`, no WHERE is required. Use for
     * test resets or full-table cleanup. (Deleting all rows never drops the
     * table or resets AUTOINCREMENT sequences.)
     */
    deleteAll() {
        const stmt = this.#exec.prepare(`DELETE FROM ${quoteIdent(this.table)}`);
        const result = stmt.run();
        return Number(result.changes);
    }
    // ---- COUNT / EXISTS ----
    /**
     * Count rows matching the optional condition.
     */
    count(where) {
        const qb = this.query();
        if (where !== undefined)
            qb.where(where);
        return qb.count();
    }
    /**
     * Check if at least one row matches the condition.
     * Uses a LIMIT 1 query — faster than count() on large tables.
     */
    exists(where) {
        return this.findOne(where) !== undefined;
    }
    // ---- Query builder ----
    /**
     * Get a fluent QueryBuilder for this table.
     */
    query() {
        return new QueryBuilder(this.#exec, this.table);
    }
    // ---- Internal ----
    #validateKeys(data) {
        if (typeof data !== 'object' || data === null)
            return;
        const colSet = new Set(Object.keys(this.#schema.columns));
        for (const key of Object.keys(data)) {
            if (!colSet.has(key)) {
                throw new Error(`Unknown column "${key}" on table "${this.table}". ` +
                    `Valid columns: ${[...colSet].join(', ')}`);
            }
        }
    }
    #lastInsertRowid() {
        const row = this.#exec.prepare('SELECT last_insert_rowid() AS "rid"').get();
        return row?.rid ?? 0;
    }
    #resolveAfterInsert(data, lastInsertRowid) {
        const schema = this.#schema;
        // If WITHOUT ROWID, use primary key columns from input
        if (schema.withoutRowId) {
            const pkCols = this.#pkColumns();
            const where = {};
            for (const pk of pkCols) {
                const v = data[pk];
                if (v === undefined) {
                    throw new Error(`Cannot resolve row after insert on WITHOUT ROWID table "${this.table}": ` +
                        `primary key column "${pk}" was not provided in insert data.`);
                }
                where[pk] = v;
            }
            return this.findOne(where);
        }
        // Rowid table: use lastInsertRowid (which is also the INTEGER PRIMARY KEY alias)
        const stmt = this.#exec.prepare(`SELECT * FROM ${quoteIdent(this.table)} WHERE rowid = ?`);
        return stmt.get(lastInsertRowid);
    }
    #pkColumns() {
        return Object.entries(this.#schema.columns)
            .filter(([, col]) => col.primaryKey)
            .map(([name]) => name);
    }
}

// ---------------------------------------------------------------------------
// SQLite error classification
//
// node:sqlite surfaces errors as plain `Error` objects carrying SQLite
// extended result codes on `errcode` / `errstr` (plus a `code` of
// `ERR_SQLITE_ERROR` for every SQLite failure). Sqlo deliberately does NOT
// wrap or re-map these errors (the founding spec says expose SQLite
// behaviour, never simulate it). Instead it provides narrow type guards so
// application code can branch on the actual SQLite result code.
// ---------------------------------------------------------------------------
/** SQLite result codes (subset — the ones application code branches on). */
const SQLITE = {
    /** SQLITE_ERROR — generic SQL error or missing database. */
    ERROR: 1,
    /** SQLITE_BUSY — the database file is locked (another connection is writing). */
    BUSY: 5,
    /** SQLITE_LOCKED — a table in the database is locked. */
    LOCKED: 6,
    /** SQLITE_READONLY — attempt to write a readonly database. */
    READONLY: 8,
    /** SQLITE_INTERRUPT — operation interrupted by `interrupt()`. */
    INTERRUPT: 9,
    /** SQLITE_CORRUPT — the database file is corrupt. */
    CORRUPT: 11,
    /** SQLITE_FULL — disk full. */
    FULL: 13,
    /** SQLITE_CONSTRAINT — a UNIQUE / NOT NULL / CHECK / FK constraint failed. */
    CONSTRAINT: 19,
};
/**
 * Type guard — is this an error caused by the database being locked
 * (`SQLITE_BUSY`, errcode 5)? SQLite is single-writer (see README); a busy
 * error means another connection holds the write lock. In production this is
 * the signal to back off and retry.
 */
function isBusyError(e) {
    if (typeof e !== 'object' || e === null)
        return false;
    const err = e;
    if (typeof err.errcode === 'number' && (err.errcode & 0xff) === SQLITE.BUSY)
        return true;
    if (err.errcode !== undefined)
        return false;
    // Fallback: node:sqlite always sets errcode for SQLite failures, but be
    // defensive about messages from other layers.
    const msg = err.message ?? '';
    return /database is locked/i.test(msg) || /locked/i.test(msg);
}
/**
 * Type guard — is this a constraint violation (`SQLITE_CONSTRAINT`, errcode
 * 19)? Covers UNIQUE, NOT NULL, CHECK and foreign-key violations.
 */
function isConstraintError(e) {
    if (typeof e !== 'object' || e === null)
        return false;
    const err = e;
    if (typeof err.errcode === 'number' && (err.errcode & 0xff) === SQLITE.CONSTRAINT) {
        return true;
    }
    if (err.errcode !== undefined)
        return false;
    const msg = err.message ?? '';
    return /constraint failed/i.test(msg);
}

// ---------------------------------------------------------------------------
// Behaviour logging
//
// Sqlo exposes an optional logging window (`onLog`) so applications can
// observe what the ORM is doing — queries, transactions, schema operations,
// connection lifecycle. Logging is opt-in and level-filtered; it never
// affects behaviour.
// ---------------------------------------------------------------------------
/** Numeric ordering for level filtering. */
const LEVEL_ORDER = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
/**
 * Should an entry of `level` be emitted given the configured threshold?
 * The threshold is inclusive: `warn` emits warn + error.
 */
function shouldLog(level, threshold) {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

/**
 * Sqlo — the core class wrapping a `node:sqlite` DatabaseSync instance.
 */
// ---------------------------------------------------------------------------
// Sqlo class
// ---------------------------------------------------------------------------
/**
 * The Sqlo ORM — a thin, synchronous wrapper over a `node:sqlite`
 * `DatabaseSync` connection.
 *
 * Provides typed models (`define`), parameter-bound query helpers
 * (`all` / `get` / `run`), transactions, SQL-file migrations, and raw access
 * to the underlying instance. SQLite-only, zero native dependencies.
 */
class Sqlo {
    #db;
    #options;
    #models = new Map();
    #closed = false;
    /** Re-entry guard: prevents an `onLog` callback from triggering new log events. */
    #logging = false;
    /**
     * Open (or create) a SQLite database.
     *
     * ```ts
     * const db = new Sqlo({ path: ':memory:' });
     * const db = new Sqlo({ path: './app.db' });
     * ```
     */
    constructor(options = {}) {
        const opts = typeof options === 'string' ? { path: options } : { ...options };
        const path = opts.path ?? ':memory:';
        this.#options = {
            path,
            open: opts.open ?? true,
            readBigInts: opts.readBigInts ?? false,
            enableForeignKeyConstraints: opts.enableForeignKeyConstraints ?? true,
            enableDoubleQuotedStringLiterals: opts.enableDoubleQuotedStringLiterals ?? false,
            allowExtension: opts.allowExtension ?? false,
            busyTimeout: opts.busyTimeout ?? 0,
            journalMode: opts.journalMode ?? 'DELETE',
            logLevel: opts.logLevel ?? 'warn',
            ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
        };
        this.#db = new DatabaseSync(path, {
            open: this.#options.open,
            readBigInts: this.#options.readBigInts,
            enableForeignKeyConstraints: this.#options.enableForeignKeyConstraints,
            enableDoubleQuotedStringLiterals: this.#options.enableDoubleQuotedStringLiterals,
            allowExtension: this.#options.allowExtension,
        });
        if (this.#options.busyTimeout > 0) {
            this.#db.exec(`PRAGMA busy_timeout = ${this.#options.busyTimeout}`);
        }
        if (opts.journalMode !== undefined && opts.journalMode !== 'DELETE') {
            this.#db.exec(`PRAGMA journal_mode = ${this.#options.journalMode}`);
        }
        this.#log('connection', `open database ${path === ':memory:' ? '(in-memory)' : path}`, {
            detail: `journalMode=${this.#options.journalMode}, fk=${this.#options.enableForeignKeyConstraints}`,
        });
    }
    // ---- Raw access ----
    /**
     * Returns the raw `node:sqlite` DatabaseSync instance for direct use.
     */
    raw() {
        return this.#db;
    }
    // ---- Connection state & introspection ----
    /**
     * Whether the underlying database connection is still open.
     *
     * Useful for lifecycle management (e.g. checking a cached instance from a
     * `MultiSqlo` pool, or a worker-owned instance) before using it.
     */
    get isOpen() {
        return this.#db.isOpen;
    }
    /**
     * The SQLite library version (e.g. `3.46.0`).
     */
    get version() {
        this.#ensureOpen();
        const row = this.#db.prepare('SELECT sqlite_version() AS v').get();
        return row.v;
    }
    /**
     * All attached databases with their schema name and backing file path.
     *
     * The first entry is always `main`. Attached databases (via `attach()`) are
     * listed after it. In-memory databases (`:memory:`) report an empty file path.
     *
     * Rows are normalized to plain objects (node:sqlite returns null-prototype rows).
     *
     * @example
     * db.databaseList()
     * // → [{ name: 'main', file: '/private/tmp/app.db' },
     * //    { name: 'audit', file: '/private/tmp/audit.db' }]
     */
    databaseList() {
        this.#ensureOpen();
        const rows = this.#db.prepare('PRAGMA database_list').all();
        return rows.map((r) => ({ name: r.name, file: r.file }));
    }
    /**
     * Check whether a table exists (optionally in a specific attached schema).
     *
     * Lightweight alternative to `reflectTableSchema` when you only need an
     * existence check — e.g. before `sync()`/`migrate()`, or in setup logic.
     *
     * @param name Table name, optionally `schema.table` (e.g. `'audit.logs'`).
     */
    tableExists(name) {
        this.#ensureOpen();
        let schema;
        let table = name;
        const dot = name.indexOf('.');
        if (dot > 0) {
            schema = name.slice(0, dot);
            table = name.slice(dot + 1);
        }
        const sql = schema
            ? `SELECT 1 FROM ${quoteIdent(schema)}.sqlite_master WHERE type = 'table' AND tbl_name = ?`
            : 'SELECT 1 FROM sqlite_master WHERE type = \'table\' AND tbl_name = ?';
        const row = this.#db.prepare(sql).get(table);
        return row !== undefined;
    }
    /**
     * Create an online backup of the current database to another file.
     *
     * Uses SQLite's `VACUUM INTO` (available since SQLite 3.27), which takes a
     * consistent snapshot even while the database is in use. The target path is
     * parameter-bound. Useful for pre-migration snapshots, scheduled backups, or
     * per-user backups in a `MultiSqlo` setup.
     *
     * @param target File path of the backup to create.
     */
    backup(target) {
        this.#ensureOpen();
        const started = performance.now();
        this.#db.prepare('VACUUM INTO ?').run(target);
        this.#log('connection', `backup to ${target}`, { detail: `took ${(performance.now() - started).toFixed(1)}ms` });
    }
    // ---- Low-level helpers ----
    /**
     * Execute a SQL string directly (no parameter binding).
     */
    exec(sql) {
        this.#ensureOpen();
        const started = performance.now();
        this.#db.exec(sql);
        this.#log('query', `exec: ${sql}`, { sql, durationMs: performance.now() - started });
    }
    /**
     * Prepare a statement and return all rows.
     */
    all(sql, ...params) {
        this.#ensureOpen();
        const started = performance.now();
        const stmt = this.#db.prepare(sql);
        const rows = plainRows(stmt.all(...params));
        this.#log('query', `all: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return rows;
    }
    /**
     * Prepare a statement and return the first row, or undefined.
     */
    get(sql, ...params) {
        this.#ensureOpen();
        const started = performance.now();
        const stmt = this.#db.prepare(sql);
        const row = plainRow(stmt.get(...params));
        this.#log('query', `get: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return row;
    }
    /**
     * Prepare a statement, execute it, and return the result info.
     */
    run(sql, ...params) {
        this.#ensureOpen();
        const started = performance.now();
        const stmt = this.#db.prepare(sql);
        const result = stmt.run(...params);
        this.#log('query', `run: ${sql}`, { sql, params, durationMs: performance.now() - started });
        return result;
    }
    /**
     * Implement the Executor interface for QueryBuilder / Model.
     */
    prepare(sql) {
        this.#ensureOpen();
        const stmt = this.#db.prepare(sql);
        const self = this;
        return {
            all(...params) {
                const started = performance.now();
                const rows = plainRows(stmt.all(...params));
                self.#log('query', `all: ${sql}`, { sql, params, durationMs: performance.now() - started });
                return rows;
            },
            get(...params) {
                const started = performance.now();
                const row = plainRow(stmt.get(...params));
                self.#log('query', `get: ${sql}`, { sql, params, durationMs: performance.now() - started });
                return row;
            },
            run(...params) {
                const started = performance.now();
                const result = stmt.run(...params);
                self.#log('query', `run: ${sql}`, { sql, params, durationMs: performance.now() - started });
                return result;
            },
        };
    }
    // ---- Behaviour logging ----
    /**
     * Emit a behaviour log entry through the configured `onLog` window,
     * filtered by `logLevel`. No-op when no window is configured.
     *
     * Re-entrancy guard: while `onLog` is executing, any further `#log` calls
     * are dropped. This prevents an `onLog` callback that itself performs
     * database operations (e.g. writing logs to a table) from recursively
     * triggering new log events.
     */
    #log(event, message, fields) {
        const onLog = this.#options.onLog;
        if (!onLog)
            return;
        if (this.#logging)
            return; // drop nested events — never recurse
        const level = fields?.level ?? 'info';
        if (!shouldLog(level, this.#options.logLevel))
            return;
        const entry = {
            level,
            event,
            message,
            timestamp: Date.now(),
            ...(fields?.sql !== undefined ? { sql: fields.sql } : {}),
            ...(fields?.params !== undefined ? { params: fields.params } : {}),
            ...(fields?.durationMs !== undefined ? { durationMs: Math.round(fields.durationMs * 10) / 10 } : {}),
            ...(fields?.detail !== undefined ? { detail: fields.detail } : {}),
        };
        this.#logging = true;
        try {
            onLog(entry);
        }
        catch {
            // A user log handler must never break the database operation.
        }
        finally {
            this.#logging = false;
        }
    }
    // ---- Transaction ----
    #txDepth = 0;
    /**
     * Run a function inside a transaction.
     * Nested transactions use SAVEPOINT / RELEASE.
     *
     * ```ts
     * db.transaction(() => {
     *   db.exec('INSERT ...');
     * });
     * ```
     *
     * Production concurrency: SQLite is single-writer, so concurrent writers can
     * hit `SQLITE_BUSY`. Pass `{ retry: n }` to automatically re-run the whole
     * transaction (from a fresh `BEGIN`) with exponential backoff when the
     * database is locked. Other errors propagate immediately. Retries only apply
     * to top-level transactions — a nested (SAVEPOINT) transaction belongs to an
     * outer one and is never retried.
     *
     * @example
     * db.transaction(() => {
     *   orders.insert({ ... });
     * }, { retry: 5 });
     */
    transaction(fn, options) {
        this.#ensureOpen();
        // Nested transactions (SAVEPOINT) are never retried — they share the outer
        // transaction's fate and can't be re-entered independently.
        if (this.#txDepth > 0 || (options?.retry ?? 0) <= 0) {
            return this.#transactionOnce(fn);
        }
        const maxRetries = options.retry;
        let attempt = 0;
        for (;;) {
            try {
                return this.#transactionOnce(fn);
            }
            catch (err) {
                if (!isBusyError(err) || attempt >= maxRetries)
                    throw err;
                attempt++;
                this.#log('transaction', `retry transaction (attempt ${attempt}/${maxRetries}) after SQLITE_BUSY`, {
                    detail: `backoff delay computed for attempt ${attempt}`,
                    level: 'warn',
                });
            }
        }
    }
    #transactionOnce(fn) {
        this.#ensureOpen();
        const isTop = this.#txDepth === 0;
        if (isTop) {
            this.#db.exec('BEGIN');
            this.#log('transaction', 'BEGIN transaction');
        }
        else {
            this.#db.exec(`SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
            this.#log('transaction', `BEGIN SAVEPOINT (depth ${this.#txDepth})`);
        }
        this.#txDepth++;
        try {
            const result = fn();
            this.#txDepth--;
            if (this.#txDepth === 0) {
                this.#db.exec('COMMIT');
                this.#log('transaction', 'COMMIT transaction');
            }
            else {
                this.#db.exec(`RELEASE SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                this.#log('transaction', `RELEASE SAVEPOINT (depth ${this.#txDepth})`);
            }
            return result;
        }
        catch (err) {
            this.#txDepth--;
            if (this.#txDepth === 0) {
                this.#db.exec('ROLLBACK');
                this.#log('transaction', 'ROLLBACK transaction', { level: 'warn' });
            }
            else {
                this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                this.#log('transaction', `ROLLBACK TO SAVEPOINT (depth ${this.#txDepth})`, { level: 'warn' });
            }
            throw err;
        }
    }
    // ---- Multiple databases (ATTACH / DETACH) ----
    /**
     * Attach another SQLite database file to this connection.
     *
     * After attaching, its tables are addressable with a `schema.table` name:
     *
     * ```ts
     * db.attach('./data/aux.db', 'aux');
     * const model = db.define({ name: 'aux.items', columns: { ... } });
     * ```
     *
     * The database name (`aux`) is validated as a safe identifier; the file
     * path is passed as a bound parameter (never concatenated).
     */
    attach(path, name) {
        this.#ensureOpen();
        const ident = quoteIdent(name);
        // The schema name cannot be a bound parameter — it's an identifier, so
        // it is validated and quoted; the file path is always bound.
        this.#db.prepare(`ATTACH DATABASE ? AS ${ident}`).run(path);
        this.#log('connection', `ATTACH database "${name}" from ${path}`);
    }
    /**
     * Detach a previously attached database. Its schema name becomes
     * unavailable for further queries.
     */
    detach(name) {
        this.#ensureOpen();
        this.#db.exec(`DETACH DATABASE ${quoteIdent(name)}`);
        this.#log('connection', `DETACH database "${name}"`);
    }
    // ---- Schema & Model ----
    /**
     * Define a model for a table.
     *
     * ```ts
     * const users = db.define({
     *   name: 'users',
     *   columns: {
     *     id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
     *     name: { type: 'TEXT', notNull: true },
     *   },
     * });
     * ```
     *
     * Does **not** create the table — call `users.sync()` or `db.syncAll()`.
     */
    define(schema) {
        this.#ensureOpen();
        // Validate the schema
        const { errors, warnings } = validateSchema(schema);
        if (errors.length > 0) {
            throw new Error(`Invalid schema for table "${schema.name}":\n  ${errors.join('\n  ')}`);
        }
        for (const warning of warnings) {
            process.emitWarning(warning, { code: 'SQLO_SCHEMA_WARNING' });
        }
        // Foreign keys: warn when the schema declares references but the
        // connection has foreign-key enforcement disabled — the declared
        // ON DELETE / ON UPDATE actions would silently not fire.
        if (!this.#options.enableForeignKeyConstraints && schemaHasReferences(schema)) {
            process.emitWarning(`Table "${schema.name}" declares foreign key references but the connection has ` +
                'foreign key enforcement disabled (enableForeignKeyConstraints: false). ' +
                'ON DELETE / ON UPDATE actions will NOT fire. Enable the option to enforce them.', { code: 'SQLO_FOREIGN_KEYS_DISABLED' });
        }
        const model = new Model(this, schema);
        this.#models.set(schema.name, model);
        this.#log('schema', `define model for "${schema.name}"`, {
            detail: `${Object.keys(schema.columns).length} columns, ${schema.indexes?.length ?? 0} indexes`,
        });
        return model;
    }
    /**
     * Create all defined tables and indexes.
     */
    syncAll() {
        this.#ensureOpen();
        for (const model of this.#models.values()) {
            model.sync();
        }
    }
    // ---- Migration ----
    /**
     * Run pending migrations.
     * Returns the list of newly applied migrations.
     *
     * By default migrations are tracked against the main database. Pass
     * `{ schema: 'aux' }` to manage the migrations of an attached database —
     * the version table is created inside that schema, so each database keeps
     * an independent migration history.
     *
     * ```ts
     * db.attach('./audit.db', 'audit');
     * db.migrate(auditMigrations, { schema: 'audit' });
     * ```
     */
    migrate(migrations, options) {
        this.#ensureOpen();
        const schema = options?.schema ?? 'main';
        this.#ensureMigrationTable(schema);
        const applied = this.#getAppliedMigrations(schema);
        const pending = migrations.filter((m) => !applied.has(m.name));
        for (const m of pending) {
            // Participate in an outer transaction when present (nested via SAVEPOINT),
            // otherwise open a dedicated transaction per migration so that already
            // applied migrations survive a later failure.
            if (this.#txDepth === 0) {
                this.#db.exec('BEGIN');
            }
            else {
                this.#db.exec(`SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
            }
            this.#txDepth++;
            try {
                this.#applyMigration(m, schema);
                this.#log('migrate', `applied migration "${m.name}"`, { detail: `schema "${schema}"` });
                this.#txDepth--;
                if (this.#txDepth === 0) {
                    this.#db.exec('COMMIT');
                }
                else {
                    this.#db.exec(`RELEASE SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                }
            }
            catch (err) {
                this.#txDepth--;
                this.#log('migrate', `migration "${m.name}" failed`, { detail: `schema "${schema}"`, level: 'error' });
                if (this.#txDepth === 0) {
                    this.#db.exec('ROLLBACK');
                }
                else {
                    this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                }
                throw new Error(`Migration "${m.name}" failed. DB has been rolled back.`, { cause: err });
            }
        }
        if (pending.length > 0) {
            this.#log('migrate', `applied ${pending.length} migration(s)`, { detail: `schema "${schema}"` });
        }
        else {
            this.#log('migrate', 'no pending migrations', { detail: `schema "${schema}"` });
        }
        return pending;
    }
    /**
     * List all migrations with their applied status.
     * Pass `{ schema }` to inspect an attached database's migration history.
     */
    migrationStatus(migrations, options) {
        this.#ensureOpen();
        const schema = options?.schema ?? 'main';
        this.#ensureMigrationTable(schema);
        const applied = this.#getAppliedMigrations(schema);
        return migrations.map((m) => ({
            name: m.name,
            appliedAt: applied.get(m.name) ?? null,
        }));
    }
    // ---- Close ----
    /**
     * Close the database connection.
     */
    close() {
        if (!this.#closed) {
            this.#db.close();
            this.#closed = true;
            this.#log('connection', 'close database');
        }
    }
    // ---- Internal ----
    #ensureOpen() {
        if (this.#closed) {
            throw new Error('Database is closed.');
        }
        if (!this.#db.isOpen) {
            // The raw connection may have been closed out-of-band via `raw()`;
            // surface a clear error instead of letting node:sqlite throw opaque
            // "database is not open" errors from an unexpected layer.
            throw new Error('Database connection is not open.');
        }
    }
    #migrationTableRef(schema) {
        // 'main' is the default schema — keep the historical bare table name
        // (`_sqlo_migrations`) so existing databases keep their migration history.
        // Any other schema is an attached database: quote it explicitly.
        return schema === 'main'
            ? '"_sqlo_migrations"'
            : `${quoteIdent(schema)}."_sqlo_migrations"`;
    }
    #ensureMigrationTable(schema) {
        this.#db.exec(`CREATE TABLE IF NOT EXISTS ${this.#migrationTableRef(schema)} (
        "name" TEXT PRIMARY KEY NOT NULL,
        "applied_at" TEXT NOT NULL
      )`);
    }
    #getAppliedMigrations(schema) {
        const rows = this.#db.prepare(`SELECT "name", "applied_at" FROM ${this.#migrationTableRef(schema)} ORDER BY "name"`).all();
        const map = new Map();
        for (const row of rows) {
            map.set(row.name, row.applied_at);
        }
        return map;
    }
    #applyMigration(m, schema) {
        const ts = new Date().toISOString();
        if (typeof m.up === 'string') {
            this.#db.exec(m.up);
        }
        else {
            m.up({ exec: (sql) => this.#db.exec(sql) });
        }
        this.#db.prepare(`INSERT INTO ${this.#migrationTableRef(schema)} ("name", "applied_at") VALUES (?, ?)`).run(m.name, ts);
    }
}
// ---------------------------------------------------------------------------
// Row normalization
//
// node:sqlite returns rows with a null prototype. The ORM layer normalizes
// them to plain objects for friendlier DX (deep-equal, JSON, spread). Users
// who need the raw objects can go through sqlo.raw().
// ---------------------------------------------------------------------------
function plainRow(row) {
    if (row === undefined)
        return undefined;
    return { ...row };
}
function plainRows(rows) {
    return rows.map((r) => ({ ...r }));
}
// ---------------------------------------------------------------------------

/**
 * MultiSqlo — per-user database isolation for multi-tenant applications.
 *
 * Each user (tenant) gets their own independent SQLite database file and a
 * dedicated Sqlo connection. Data is fully isolated — nothing is shared
 * across users.
 *
 * ```ts
 * const pool = new MultiSqlo({
 *   dir: './data',
 *   migrations: [/* baseline schema for every new user's database *\/],
 * });
 *
 * const userDb = pool.for('user-123');   // cached; created + migrated on first access
 * const posts = userDb.define({ name: 'posts', ... });
 * ```
 */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Per-user database manager for multi-tenant applications.
 *
 * Each user (tenant) gets their own independent SQLite database file and a
 * dedicated Sqlo connection, so data is fully isolated across users. New
 * databases are created and baseline-migrated automatically on first access.
 */
class MultiSqlo {
    #dir;
    #migrations;
    #options;
    #fileName;
    #instances = new Map();
    /**
     * @param opts Directory to store per-user databases, baseline migrations,
     *   connection options, and an optional file-name strategy.
     */
    constructor(opts) {
        this.#dir = resolve(opts.dir);
        this.#migrations = opts.migrations ?? [];
        this.#options = opts.options;
        this.#fileName = opts.fileName ?? ((userId) => `${userId}.db`);
        mkdirSync(this.#dir, { recursive: true });
    }
    /**
     * Get the Sqlo instance for a user, creating and migrating their database
     * on first access. The instance is cached and reused across calls.
     *
     * @throws if `userId` is not a safe file name component.
     */
    for(userId) {
        if (!USER_ID_RE.test(userId)) {
            throw new Error(`Invalid userId: "${userId}". ` +
                'Must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ to be used as a file name.');
        }
        const cached = this.#instances.get(userId);
        if (cached)
            return cached;
        const fileName = this.#fileName(userId);
        if (fileName.includes('/') || fileName.includes('\\') || fileName === '..' || fileName === '.') {
            throw new Error(`fileName() for "${userId}" must be a plain file name, got "${fileName}".`);
        }
        const path = join(this.#dir, fileName);
        const isNew = !existsSync(path);
        const db = new Sqlo({ path, ...(this.#options ?? {}) });
        if (isNew && this.#migrations.length > 0) {
            db.migrate(this.#migrations);
        }
        this.#instances.set(userId, db);
        return db;
    }
    /**
     * Whether a user's instance is currently open (cached).
     */
    has(userId) {
        return this.#instances.has(userId);
    }
    /**
     * Close a single user's database connection.
     */
    close(userId) {
        const db = this.#instances.get(userId);
        if (db) {
            db.close();
            this.#instances.delete(userId);
        }
    }
    /**
     * Close every open user database and clear the cache.
     */
    closeAll() {
        for (const db of this.#instances.values()) {
            db.close();
        }
        this.#instances.clear();
    }
    /**
     * Number of currently open (cached) user instances.
     */
    get size() {
        return this.#instances.size;
    }
}

/**
 * Schema diff — compare two table definitions and produce migration guidance.
 *
 * Sqlo never applies schema changes automatically (#30: SQL-file migrations
 * only). This module is the "planning aid": it tells you exactly what SQL
 * would be needed to move from one table definition to another, split into
 * safe statements (which you can run via ALTER TABLE / CREATE INDEX) and
 * warnings (changes SQLite cannot apply in place — those require a
 * table-rebuild migration written by hand).
 */
function columnKey(col) {
    // Serialize type + constraints so we can detect meaningful changes while
    // ignoring key ordering. Plain-string CHECK/where are compared by text.
    // `comment` is intentionally excluded: it is documentation-only metadata
    // with no effect on the database structure, so editing a comment must not
    // surface as a structural change requiring a table rebuild.
    const chk = col.check;
    const checkText = chk === undefined ? undefined : (typeof chk === 'string' ? chk : chk.text);
    return JSON.stringify({
        type: col.type.toUpperCase(),
        primaryKey: col.primaryKey ?? false,
        autoIncrement: col.autoIncrement ?? false,
        notNull: col.notNull ?? false,
        unique: col.unique ?? false,
        collate: col.collate,
        default: col.default,
        check: checkText,
        references: col.references,
    });
}
function fragmentText(x) {
    return typeof x === 'string' ? x : x.text;
}
function sameIndexes(a, b) {
    if (a.name !== b.name)
        return false;
    if ((a.unique ?? false) !== (b.unique ?? false))
        return false;
    const colsA = a.columns.map((c) => (typeof c === 'string' ? c : `${c.name} ${c.direction ?? 'ASC'}`));
    const colsB = b.columns.map((c) => (typeof c === 'string' ? c : `${c.name} ${c.direction ?? 'ASC'}`));
    if (JSON.stringify(colsA) !== JSON.stringify(colsB))
        return false;
    const wA = a.where ? fragmentText(a.where) : null;
    const wB = b.where ? fragmentText(b.where) : null;
    return wA === wB;
}
function hasIncompatibleAddColumn(name, col) {
    // SQLite's ALTER TABLE ADD COLUMN cannot add PRIMARY KEY / UNIQUE columns.
    if (col.primaryKey || col.unique) {
        return `Column "${name}" cannot be added with ALTER TABLE because it is PRIMARY KEY or UNIQUE. Requires a table-rebuild migration.`;
    }
    if (col.notNull && col.default === undefined) {
        return `Column "${name}" is NOT NULL without a DEFAULT — SQLite cannot add it to a non-empty table. Add a DEFAULT or allow NULL.`;
    }
    return null;
}
/**
 * Compare two table definitions and produce migration guidance.
 */
function schemaDiff(from, to) {
    const result = {
        addedColumns: [],
        removedColumns: [],
        changedColumns: [],
        addedIndexes: [],
        removedIndexes: [],
        statements: [],
        warnings: [],
    };
    // ---- Columns ----
    const fromCols = Object.keys(from.columns);
    const toCols = Object.keys(to.columns);
    for (const name of toCols) {
        if (!from.columns[name]) {
            result.addedColumns.push(name);
            const col = to.columns[name];
            const warn = hasIncompatibleAddColumn(name, col);
            if (warn) {
                result.warnings.push(warn);
            }
            else {
                result.statements.push(`ALTER TABLE ${quoteIdent(to.name)} ADD COLUMN ${quoteIdent(name)} ${columnDDL(col)};`);
            }
        }
        else if (columnKey(from.columns[name]) !== columnKey(to.columns[name])) {
            result.changedColumns.push(name);
            result.warnings.push(`Column "${name}": type/constraints changed (SQLite cannot ALTER COLUMN in place). ` +
                `Requires a table-rebuild migration: create a new table, copy data, drop the old table, rename.`);
        }
    }
    for (const name of fromCols) {
        if (!to.columns[name]) {
            result.removedColumns.push(name);
            result.warnings.push(`Column "${name}" was removed. SQLite 3.35+ supports DROP COLUMN but it may fail on indexed/constrained columns — verify and write a rebuild migration if needed.`);
        }
    }
    // ---- Indexes ----
    const fromIdx = new Map((from.indexes ?? []).map((i) => [i.name, i]));
    const toIdx = new Map((to.indexes ?? []).map((i) => [i.name, i]));
    for (const [name, idx] of toIdx) {
        if (!fromIdx.has(name)) {
            result.addedIndexes.push(name);
            result.statements.push(...indexDDLs({ ...to, indexes: [idx] }));
        }
        else if (!sameIndexes(fromIdx.get(name), idx)) {
            result.removedIndexes.push(name);
            result.addedIndexes.push(name);
            result.statements.push(`DROP INDEX IF EXISTS ${quoteIdent(name)};`);
            result.statements.push(...indexDDLs({ ...to, indexes: [idx] }));
        }
    }
    for (const [name] of fromIdx) {
        if (!toIdx.has(name)) {
            result.removedIndexes.push(name);
            result.statements.push(`DROP INDEX IF EXISTS ${quoteIdent(name)};`);
        }
    }
    // ---- Table-level options (strict / withoutRowId / table checks) ----
    if ((from.strict ?? false) !== (to.strict ?? false)) {
        result.warnings.push(`Table option "strict" changed (${from.strict ?? false} → ${to.strict ?? false}). ` +
            `Cannot be applied in place — requires a table-rebuild migration.`);
    }
    if ((from.withoutRowId ?? false) !== (to.withoutRowId ?? false)) {
        result.warnings.push(`Table option "withoutRowId" changed (${from.withoutRowId ?? false} → ${to.withoutRowId ?? false}). ` +
            `Cannot be applied in place — requires a table-rebuild migration.`);
    }
    const fromChecks = (from.checks ?? []).map((c) => fragmentText(c));
    const toChecks = (to.checks ?? []).map((c) => fragmentText(c));
    if (JSON.stringify(fromChecks) !== JSON.stringify(toChecks)) {
        result.warnings.push(`Table-level CHECK constraints changed. Cannot be applied in place — requires a table-rebuild migration.`);
    }
    return result;
}
/**
 * Generate a ready-to-save migration SQL file from a schema diff.
 * The caller is expected to review and save the result as a `.sql` migration
 * file, then run it through `db.migrate()`.
 */
function generateMigrationSql(from, to, header = '') {
    const diff = schemaDiff(from, to);
    const lines = [];
    if (header)
        lines.push(header);
    lines.push(`-- Migration: ${to.name} (generated by schemaDiff)`);
    lines.push('');
    if (diff.statements.length > 0) {
        lines.push('-- Safe statements');
        lines.push(...diff.statements);
        lines.push('');
    }
    if (diff.warnings.length > 0) {
        lines.push('-- ⚠️  Manual review required (SQLite cannot apply in place):');
        lines.push(...diff.warnings.map((w) => `--   ${w}`));
        lines.push('');
    }
    if (diff.addedColumns.length === 0 && diff.removedColumns.length === 0 &&
        diff.changedColumns.length === 0 && diff.addedIndexes.length === 0 &&
        diff.removedIndexes.length === 0 && diff.warnings.length === 0) {
        lines.push('-- No schema differences.');
    }
    return lines.join('\n');
}

/**
 * Schema introspection — read the *actual* table structure from the
 * database and turn it into a TableDef that can be diffed against the
 * schema in your code.
 *
 * Real-world workflow: your database file already exists (created by an
 * older version), your code holds the latest schema. Introspect the live
 * table, then `schemaDiff(actual, desired)` to see exactly which columns /
 * indexes are missing and generate a migration.
 */
/**
 * Read a table's actual structure from the database.
 *
 * Returns a `TableDef` whose columns/indexes mirror what SQLite currently
 * has, suitable for passing as the `from` argument to `schemaDiff()`.
 *
 * ```ts
 * const actual = reflectTableSchema(db, 'users');
 * const diff = schemaDiff(actual, desiredSchema);
 * ```
 *
 * Detected: columns (type / notNull / primaryKey / default), indexes
 * (unique / partial), table options (strict / withoutRowId).
 *
 * Not detected (SQLite does not expose them via PRAGMA): column-level
 * CHECK expressions, column references (foreign keys), COLLATE, and
 * column comments (`ColumnDef.comment` is documentation-only metadata and
 * is not stored in the database). These are best read from your schema
 * files / migrations instead.
 */
function reflectTableSchema(exec, table) {
    const result = reflectRaw(exec, table);
    // Reflected column types come from PRAGMA at runtime and cannot be
    // statically verified against `SqliteType` — cast to the public `TableDef`.
    return result;
}
/** Runtime implementation of `reflectTableSchema` with broad column typing. */
function reflectRaw(exec, table) {
    // Split "schema.table" (attached database) from a bare "table" name.
    const parts = table.split('.');
    const schema = parts.length === 2 ? parts[0] : 'main';
    const name = parts.length === 2 ? parts[1] : table;
    const schemaIdent = quoteIdent(schema);
    const tableIdent = quoteIdent(name);
    // sqlite_master lives in each attached schema.
    const master = `${schemaIdent}.sqlite_master`;
    // Does the table exist?
    const existing = exec.prepare(`SELECT name FROM ${master} WHERE type = ? AND name = ?`).get('table', name);
    if (!existing) {
        throw new Error(`Table "${table}" does not exist.`);
    }
    // ---- Columns ----
    const colRows = exec.prepare(`PRAGMA ${schemaIdent}.table_info(${tableIdent})`).all();
    const columns = {};
    for (const col of colRows) {
        const def = {
            type: col.type || 'TEXT', // SQLite reports '' for typeless columns
        };
        if (col.pk > 0)
            def.primaryKey = true;
        if (col.notnull === 1)
            def.notNull = true;
        if (col.dflt_value !== null)
            def.default = parseDefaultLiteral(col.dflt_value);
        columns[col.name] = def;
    }
    // AUTOINCREMENT is not reported by PRAGMA table_info. When the column
    // is INTEGER PRIMARY KEY AND the table appears in sqlite_sequence, the
    // table was created with AUTOINCREMENT.
    const hasAutoincrement = isAutoincrementTable(exec, schema, name);
    // ---- Indexes (exclude implicit indexes SQLite manages internally) ----
    const idxRows = exec.prepare(`PRAGMA ${schemaIdent}.index_list(${tableIdent})`).all();
    const indexes = [];
    for (const idx of idxRows) {
        if (idx.origin === 'u') {
            // UNIQUE constraint → surface as `unique: true` on the column,
            // not as a standalone index.
            const info = exec.prepare(`PRAGMA ${schemaIdent}.index_info(${quoteIdent(idx.name)})`).all();
            const cols = info.sort((a, b) => a.seqno - b.seqno).map((i) => i.name);
            if (cols.length === 1 && cols[0] !== null) {
                const col = columns[cols[0]];
                if (col)
                    col.unique = true;
                continue;
            }
        }
        // origin 'pk' (primary key) is already captured in column definitions.
        if (idx.origin !== 'c')
            continue;
        const info = exec.prepare(`PRAGMA ${schemaIdent}.index_info(${quoteIdent(idx.name)})`).all();
        const cols = info
            .sort((a, b) => a.seqno - b.seqno)
            .map((i) => i.name)
            .filter((n) => n !== null);
        indexes.push({
            name: idx.name,
            columns: cols,
            ...(idx.unique === 1 ? { unique: true } : {}),
        });
    }
    // Attach AUTOINCREMENT to the single INTEGER PRIMARY KEY column if detected.
    if (hasAutoincrement) {
        for (const col of Object.values(columns)) {
            if (col.primaryKey && /INTEGER/i.test(col.type)) {
                col.autoIncrement = true;
                break;
            }
        }
    }
    // ---- Table options from the CREATE TABLE SQL ----
    let strict = false;
    let withoutRowId = false;
    const sqlRow = exec.prepare(`SELECT sql FROM ${master} WHERE type = ? AND name = ?`).get('table', name);
    if (sqlRow?.sql) {
        strict = /\bSTRICT\b/.test(sqlRow.sql);
        withoutRowId = /\bWITHOUT\s+ROWID\b/i.test(sqlRow.sql);
    }
    return {
        name: table,
        columns,
        ...(indexes.length > 0 ? { indexes } : {}),
        ...(strict ? { strict } : {}),
        ...(withoutRowId ? { withoutRowId } : {}),
    };
}
/**
 * Detect whether a table was created with AUTOINCREMENT. SQLite keeps a
 * `sqlite_sequence` table only for AUTOINCREMENT tables that have had rows
 * inserted; a table with no rows yet won't appear there. We instead check
 * the CREATE TABLE SQL for the AUTOINCREMENT keyword, which is reliable.
 */
function isAutoincrementTable(exec, schema, table) {
    const row = exec.prepare(`SELECT sql FROM ${quoteIdent(schema)}.sqlite_master WHERE type = ? AND name = ?`).get('table', table);
    return /\bAUTOINCREMENT\b/i.test(row?.sql ?? '');
}
/**
 * Best-effort conversion of a SQLite default-value literal into a JS value.
 * SQLite reports defaults as strings (e.g. "0", "'draft'", "CURRENT_TIMESTAMP").
 * Numeric literals become numbers, quoted strings become strings, everything
 * else (expressions, keywords) is kept as-is.
 */
function parseDefaultLiteral(raw) {
    const s = raw.trim();
    // Number
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
        return Number(s);
    }
    // Quoted string '...' (SQLite doubles single quotes inside)
    if (s.startsWith("'") && s.endsWith("'")) {
        return s.slice(1, -1).replace(/''/g, "'");
    }
    // Everything else (expressions, CURRENT_TIMESTAMP, function calls...)
    return s;
}

/**
 * Load table definitions from JSON.
 *
 * Table schemas are plain data, so they can live in `.json` files and be
 * loaded at runtime — useful for configuration-driven or multi-tenancy
 * setups. The loaded definition goes through the same `db.define()` schema
 * validation as object literals.
 *
 * Note: CHECK/WHERE constraints must be plain SQL strings in JSON (a JSON
 * file cannot express a bound-parameter fragment). This matches the
 * `SqlFragment | string` acceptance in `TableDef`.
 */
/**
 * Synchronously load a table definition from a JSON file.
 *
 * ```json
 * {
 *   "name": "users",
 *   "columns": {
 *     "id":   { "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
 *     "name": { "type": "TEXT", "notNull": true },
 *     "age":  { "type": "INTEGER", "check": "age >= 0" }
 *   },
 *   "indexes": [
 *     { "name": "idx_users_name", "columns": ["name"] }
 *   ]
 * }
 * ```
 */
function loadTableDefSync(jsonPath) {
    const absPath = resolve(jsonPath);
    const text = readFileSync(absPath, 'utf-8');
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        throw new Error(`Failed to parse table definition JSON "${jsonPath}": ${err.message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Table definition JSON "${jsonPath}" must contain a single object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`);
    }
    const def = parsed;
    const { errors } = validateSchema(def);
    if (errors.length > 0) {
        throw new Error(`Invalid table definition "${jsonPath}":\n  ${errors.join('\n  ')}`);
    }
    return def;
}

/**
 * Migration utilities — file loader and runner helpers.
 *
 * Core migration logic lives in `Sqlo.migrate()` and `Sqlo.migrationStatus()`.
 * This module provides the file‑based loader.
 */
const _require = createRequire(import.meta.url);
/**
 * Synchronously load migrations from a directory.
 *
 * - `.sql` files: treated as up‑only migrations (the entire file content is the SQL).
 * - `.mjs` / `.js` / `.cjs` files: must default‑export a `MigrationDef` or an array of `MigrationDef`.
 *
 * Files are sorted alphabetically by name.
 */
function loadMigrationsSync(dir) {
    const absDir = resolve(dir);
    const entries = readdirSync(absDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
    const migrations = [];
    for (const entry of entries) {
        const ext = entry.split('.').pop()?.toLowerCase();
        const name = entry.replace(/\.\w+$/, '');
        const fullPath = resolve(absDir, entry);
        if (ext === 'sql') {
            const sql = readFileSync(fullPath, 'utf-8');
            migrations.push({ name, up: sql });
        }
        else if (ext === 'js' || ext === 'cjs' || ext === 'mjs') {
            if (ext === 'mjs') {
                throw new Error(`Cannot load .mjs migration synchronously: "${entry}". ` +
                    'Use loadMigrations() (async) instead.');
            }
            const mod = _require(fullPath);
            const result = mod.default ?? mod;
            if (Array.isArray(result)) {
                migrations.push(...result);
            }
            else {
                migrations.push(result);
            }
        }
    }
    return migrations;
}
/**
 * Asynchronously load migrations from a directory using `import()`.
 *
 * Handles `.sql`, `.mjs`, `.js`, and `.cjs` files.
 */
async function loadMigrations(dir) {
    const absDir = resolve(dir);
    const entries = (await readdir(absDir, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
    const migrations = [];
    for (const entry of entries) {
        const ext = entry.split('.').pop()?.toLowerCase();
        const name = entry.replace(/\.\w+$/, '');
        const fullPath = resolve(absDir, entry);
        if (ext === 'sql') {
            const sql = await readFile(fullPath, 'utf-8');
            migrations.push({ name, up: sql });
        }
        else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
            const absUrl = ext === 'cjs'
                ? fullPath
                : `file://${fullPath}`;
            const mod = await import(absUrl);
            const result = mod.default ?? mod;
            if (Array.isArray(result)) {
                migrations.push(...result);
            }
            else {
                migrations.push(result);
            }
        }
    }
    return migrations;
}

/**
 * Async wrapper for Sqlo.
 *
 * Removes database operations from the main thread by delegating to a
 * worker thread. This prevents synchronous SQLite operations from blocking
 * the event loop in web server / request‑handling contexts.
 *
 * ⚠️  Honest disclaimer:
 * The underlying SQLite is still synchronous.  Using the async wrapper
 * only avoids event‑loop blocking — it does not make SQLite concurrent.
 * SQLite's single‑writer lock still applies.
 */
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = dirname(__filename$1);
// ---------------------------------------------------------------------------
// AsyncSqlo
// ---------------------------------------------------------------------------
/**
 * Async wrapper around Sqlo that delegates database operations to a worker
 * thread, avoiding event-loop blocking in request-handling contexts.
 *
 * **Honest disclaimer:** SQLite underneath is still synchronous and
 * single-writer. `AsyncSqlo` only avoids event-loop blocking — it does not
 * make SQLite concurrent, and multi-process writes still surface as lock
 * timeout errors.
 */
class AsyncSqlo {
    #worker;
    #pending = new Map();
    #nextId = 1;
    /**
     * @param path Database file path (or `':memory:'`) opened inside the worker.
     * @param options Options forwarded to the worker's `DatabaseSync` constructor.
     */
    constructor(path, options) {
        const workerPath = resolve(__dirname$1, 'async-worker.js');
        this.#worker = new Worker(workerPath, {
            workerData: { path, options },
        });
        this.#worker.on('message', (msg) => {
            const pending = this.#pending.get(msg.id);
            if (!pending)
                return;
            this.#pending.delete(msg.id);
            if (msg.ok) {
                pending.resolve(msg.data);
            }
            else {
                const err = new Error(msg.error?.message ?? 'Unknown worker error');
                err.name = msg.error?.name ?? 'Error';
                if (msg.error?.stack)
                    err.stack = msg.error.stack;
                pending.reject(err);
            }
        });
        this.#worker.on('error', (err) => {
            // Reject all pending
            for (const [, p] of this.#pending) {
                p.reject(err);
            }
            this.#pending.clear();
        });
        this.#worker.on('exit', (code) => {
            if (code !== 0) {
                const err = new Error(`Worker exited with code ${code}`);
                for (const [, p] of this.#pending) {
                    p.reject(err);
                }
                this.#pending.clear();
            }
        });
    }
    // ---- Methods ----
    #send(op, sql, params = []) {
        return new Promise((resolve, reject) => {
            const id = this.#nextId++;
            this.#pending.set(id, { resolve: resolve, reject });
            this.#worker.postMessage({ id, op, sql, params });
        });
    }
    /**
     * Execute a SQL string (no return value).
     */
    exec(sql) {
        return this.#send('exec', sql);
    }
    /**
     * Execute and return all rows.
     */
    all(sql, ...params) {
        return this.#send('all', sql, params);
    }
    /**
     * Execute and return the first row, or undefined.
     */
    get(sql, ...params) {
        return this.#send('get', sql, params);
    }
    /**
     * Execute and return { changes, lastInsertRowid }.
     *
     * `changes` / `lastInsertRowid` may be `bigint` when the worker returns
     * large integers — coerce with `Number()` if you need a plain number.
     */
    run(sql, ...params) {
        return this.#send('run', sql, params);
    }
    /**
     * Close the worker and its database connection.
     */
    close() {
        return this.#send('close', '');
    }
    /**
     * Terminate the worker immediately (without graceful shutdown).
     */
    terminate() {
        this.#worker.terminate();
    }
}

export { AsyncSqlo, Model, MultiSqlo, QueryBuilder, SQLITE, Sqlo, columnDDL, generateMigrationSql, indexDDLs, isBusyError, isConstraintError, isFragment, isIdent, loadMigrations, loadMigrationsSync, loadTableDefSync, quoteIdent, quoteTable, raw, reflectTableSchema, schemaDiff, sql, tableDDL };
//# sourceMappingURL=index.js.map
