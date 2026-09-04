import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
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
 * Runtime check — is `name` a safe single/qualified SQL identifier?
 * Used by DDL generators to reject injection-prone inputs that are emitted
 * unquoted (collation names, etc.).
 */
function isValidIdent(name) {
    return IDENT_RE.test(name);
}
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
    if (col.collate !== undefined) {
        // Collation names are emitted as bare identifiers — validate so a
        // hostile value can't inject DDL. Built-ins: BINARY / NOCASE / RTRIM;
        // custom collations (registered via extensions) must be plain identifiers.
        if (!isValidIdent(col.collate)) {
            throw new Error(`Invalid collation name: "${col.collate}". ` +
                'Must be a plain SQL identifier (e.g. BINARY, NOCASE, RTRIM).');
        }
        parts.push(`COLLATE ${col.collate}`);
    }
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
            // Direction is emitted unquoted — whitelist it (runtime callers may
            // pass arbitrary strings that TypeScript can't see).
            const dir = c.direction?.toUpperCase();
            if (dir !== undefined && dir !== 'ASC' && dir !== 'DESC') {
                throw new Error(`Invalid index direction "${c.direction}" for index "${idx.name}". Expected "ASC" or "DESC".`);
            }
            return `${quoteIdent(c.name)}${dir ? ` ${dir}` : ''}`;
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
        const d = dir.toUpperCase();
        if (d !== 'ASC' && d !== 'DESC') {
            throw new Error(`Invalid orderBy direction: "${dir}". Expected "ASC" or "DESC".`);
        }
        if (isFragment(col)) {
            this.#s.orderBys.push({ col: col.text, dir: d });
            return this;
        }
        this.#s.orderBys.push({ col: quoteIdent(col), dir: d });
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
    // ---- Build helpers (terminal SQL, not executed) ----
    /**
     * Compile the `first()` query — a LIMIT 1 copy of the current builder.
     * Pure: does not mutate the builder and never executes. Shared with the
     * async `AsyncQueryBuilder`, which reuses the exact same SQL.
     */
    buildFirstSql() {
        return this.#clone().limit(1).toSql();
    }
    /**
     * Compile the `count()` query — COUNT(*) over the current builder.
     * Pure: never executes. Shared with the async `AsyncQueryBuilder`.
     */
    buildCountSql() {
        const params = [];
        let countSql;
        if (this.#s.groupBys.length > 0 || this.#s.joins.length > 0) {
            // Wrap in subquery to handle GROUP BY / JOIN row multiplication
            const inner = this.toSql();
            countSql = `SELECT COUNT(*) AS "c" FROM (${inner.sql})`;
            params.push(...inner.params);
        }
        else if (this.#s.distinct) {
            // Honour DISTINCT: COUNT(DISTINCT col) for a single projected column,
            // a DISTINCT subquery for multi-column / whole-row DISTINCT.
            if (this.#s.selectCols && this.#s.selectCols.length === 1) {
                countSql = `SELECT COUNT(DISTINCT ${this.#s.selectCols[0]}) AS "c" FROM ${quoteTable(this.#s.table)}`;
                const whereClause = this.#buildWhereClauses(this.#s.whereGroups, params);
                if (whereClause)
                    countSql += ` ${whereClause}`;
            }
            else {
                const inner = this.toSql();
                countSql = `SELECT COUNT(*) AS "c" FROM (${inner.sql})`;
                params.push(...inner.params);
            }
        }
        else {
            countSql = `SELECT COUNT(*) AS "c" FROM ${quoteTable(this.#s.table)}`;
            const whereClause = this.#buildWhereClauses(this.#s.whereGroups, params);
            if (whereClause)
                countSql += ` ${whereClause}`;
        }
        return { sql: countSql, params };
    }
    /**
     * Compile the `pluck(col)` query — a SELECT of a single column copy of the
     * current builder. Pure: never executes. Shared with the async
     * `AsyncQueryBuilder`.
     */
    buildPluckSql(col) {
        return this.#clone().select(col).toSql();
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
        const { sql, params } = this.buildFirstSql();
        const stmt = this.#exec.prepare(sql);
        return stmt.get(...params);
    }
    /**
     * Execute COUNT query.
     */
    count() {
        const { sql, params } = this.buildCountSql();
        const stmt = this.#exec.prepare(sql);
        const row = stmt.get(...params);
        // Coerce: with readBigInts the driver returns a bigint, but COUNT never
        // exceeds the safe-integer range in realistic use — surface a number.
        return row?.c === undefined ? 0 : Number(row.c);
    }
    /**
     * Execute and return values of a single column.
     * Does not mutate the builder — projection is applied on a copy.
     */
    pluck(col) {
        const { sql, params } = this.buildPluckSql(col);
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
                const arr = requireArray(op, val);
                if (arr.length === 0)
                    return { text: '0', params: [] };
                const ph = arr.map(() => '?').join(', ');
                return { text: `${col} IN (${ph})`, params: extractValues(arr) };
            }
            case 'notIn': {
                const arr = requireArray(op, val);
                if (arr.length === 0)
                    return { text: '1', params: [] };
                const ph = arr.map(() => '?').join(', ');
                return { text: `${col} NOT IN (${ph})`, params: extractValues(arr) };
            }
            case 'between': {
                const pair = requireArray(op, val);
                if (pair.length !== 2) {
                    throw new Error(`Where operator "between" requires a [min, max] tuple with exactly 2 elements, ` +
                        `got ${pair.length}.`);
                }
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
/** Validate that an operator value is an array with a clear error message. */
function requireArray(op, val) {
    if (!Array.isArray(val)) {
        throw new Error(`Where operator "${op}" requires an array, got ${val === null ? 'null' : typeof val}.`);
    }
    return val;
}

/**
 * Model — CRUD operations bound to a table schema.
 */
// ---------------------------------------------------------------------------
// Pure insert helpers
//
// The INSERT pipeline is shared between the synchronous `Model` and the async
// `AsyncModel`: both validate keys, compile the same SQL, and resolve the row
// the same way. Keeping these as pure functions (schema + data in, SQL + params
// out) means there is exactly one place that knows how an insert is built.
// ---------------------------------------------------------------------------
/**
 * Validate that every key in `data` is a declared column of the table.
 * Unknown keys are a programming error — surface them eagerly.
 */
function validateKeys(schema, table, data) {
    if (typeof data !== 'object' || data === null)
        return;
    const colSet = new Set(Object.keys(schema.columns));
    for (const key of Object.keys(data)) {
        if (!colSet.has(key)) {
            throw new Error(`Unknown column "${key}" on table "${table}". ` +
                `Valid columns: ${[...colSet].join(', ')}`);
        }
    }
}
/**
 * The primary key column names of a schema (in declaration order).
 */
function pkColumns(schema) {
    return Object.entries(schema.columns)
        .filter(([, col]) => col.primaryKey)
        .map(([name]) => name);
}
/**
 * Compile an INSERT statement for `data`. Returns the SQL, the bound values,
 * and whether the insert uses `DEFAULT VALUES` (no explicit columns).
 */
function buildInsertSql(_schema, table, data) {
    // Explicit `undefined` means "not provided" — same as an absent key. Keeping
    // it would make node:sqlite reject the binding with an opaque TypeError.
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    const cols = entries.map(([k]) => k);
    if (cols.length === 0) {
        // INSERT with no columns: use DEFAULT VALUES
        return { sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`, values: [], isEmpty: true };
    }
    const colIdents = cols.map((c) => quoteIdent(c)).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const values = entries.map(([, v]) => v);
    return {
        sql: `INSERT INTO ${quoteIdent(table)} (${colIdents}) VALUES (${placeholders})`,
        values,
        isEmpty: false,
    };
}
/**
 * Compile the SELECT that resolves a row after insert — by `lastInsertRowid`
 * on rowid tables, or by its primary-key columns on WITHOUT ROWID tables.
 */
function resolveAfterInsertSql(schema, table, data, lastInsertRowid) {
    if (schema.withoutRowId) {
        const pks = pkColumns(schema);
        const where = {};
        for (const pk of pks) {
            const v = data[pk];
            if (v === undefined) {
                throw new Error(`Cannot resolve row after insert on WITHOUT ROWID table "${table}": ` +
                    `primary key column "${pk}" was not provided in insert data.`);
            }
            where[pk] = v;
        }
        const conds = Object.entries(where).map(([k]) => `${quoteIdent(k)} = ?`);
        return { sql: `SELECT * FROM ${quoteIdent(table)} WHERE ${conds.join(' AND ')}`, params: Object.values(where) };
    }
    // Rowid table: use lastInsertRowid (which is also the INTEGER PRIMARY KEY alias)
    return { sql: `SELECT * FROM ${quoteIdent(table)} WHERE rowid = ?`, params: [lastInsertRowid] };
}
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
        validateKeys(this.#schema, this.table, data);
        const { sql, values, isEmpty } = buildInsertSql(this.#schema, this.table, data);
        const result = this.#exec.prepare(sql).run(...values);
        const rid = isEmpty ? this.#lastInsertRowid() : result.lastInsertRowid;
        const { sql: selSql, params } = resolveAfterInsertSql(this.#schema, this.table, data, rid);
        return this.#exec.prepare(selSql).get(...params);
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
        if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new Error(`insertMany: chunkSize must be a positive integer, got ${options?.chunkSize}.`);
        }
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
        const pkCols = pkColumns(this.#schema);
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
        validateKeys(this.#schema, this.table, patch);
        // Explicit `undefined` means "not patched" (matching the PatchOf type) —
        // never bind it, node:sqlite would reject it with an opaque TypeError.
        const patchEntries = Object.entries(patch).filter(([, v]) => v !== undefined);
        const patchKeys = patchEntries.map(([k]) => k);
        if (patchKeys.length === 0)
            return 0;
        const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
        const patchValues = patchEntries.map(([, v]) => v);
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
    #lastInsertRowid() {
        const row = this.#exec.prepare('SELECT last_insert_rowid() AS "rid"').get();
        return row?.rid ?? 0;
    }
}

/**
 * Migration utilities — file loader and runner helpers.
 *
 * Core migration logic lives in `Sqlo.migrate()` and `Sqlo.migrationStatus()`.
 * This module provides the file‑based loader.
 */
const _require = createRequire(import.meta.url);
// ---------------------------------------------------------------------------
// Migration primitives (pure)
//
// The version-table schema and pending computation are shared between the
// synchronous `Sqlo.migrate()` / `Sqlo.migrationStatus()` and the async
// `AsyncSqlo` wrapper, which reuses the exact same SQL. Only the transaction
// wrapping differs: sync Sqlo uses its SAVEPOINT machinery directly, while
// AsyncSqlo delegates to worker txBegin/txCommit/txRollback primitives.
// ---------------------------------------------------------------------------
/**
 * The version table reference for a schema. `'main'` keeps the historical
 * bare name (`_sqlo_migrations`) so existing databases keep their migration
 * history; any other schema is an attached database and is quoted explicitly.
 */
function migrationTableRef(schema) {
    return schema === 'main'
        ? '"_sqlo_migrations"'
        : `${quoteIdent(schema)}."_sqlo_migrations"`;
}
/**
 * CREATE TABLE IF NOT EXISTS for the version table in the given schema.
 */
function ensureMigrationTableSql(schema) {
    return `CREATE TABLE IF NOT EXISTS ${migrationTableRef(schema)} (
    "name" TEXT PRIMARY KEY NOT NULL,
    "applied_at" TEXT NOT NULL
  )`;
}
/**
 * SELECT listing applied migration names and timestamps, ordered by name.
 */
function getAppliedMigrationsSql(schema) {
    return `SELECT "name", "applied_at" FROM ${migrationTableRef(schema)} ORDER BY "name"`;
}
/**
 * INSERT recording an applied migration.
 */
function insertMigrationRecordSql(schema) {
    return `INSERT INTO ${migrationTableRef(schema)} ("name", "applied_at") VALUES (?, ?)`;
}
/**
 * The subset of `migrations` not yet present in `applied`, preserving order.
 */
function computePending(migrations, applied) {
    return migrations.filter((m) => !applied.has(m.name));
}
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
    // defensive about messages from other layers. Only match the BUSY message —
    // "table X is locked" is SQLITE_LOCKED (a different condition).
    const msg = err.message ?? '';
    return /database is locked/i.test(msg);
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
 * Parameter binding normalization.
 *
 * node:sqlite rejects `boolean` values ("Provided value cannot be bound..."),
 * but `BOOLEAN` is a documented column type in this ORM (stored as INTEGER
 * per SQLite type affinity). Coerce at the binding boundary so `true`/`false`
 * work everywhere — inserts, updates, where clauses — instead of surfacing an
 * opaque driver error. All other values pass through untouched.
 */
function toBindable(value) {
    if (typeof value === 'boolean')
        return value ? 1 : 0;
    return value;
}
function toBindables(params) {
    return params.map(toBindable);
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
            // 5000ms — the README-documented default and the production-sane choice:
            // SQLite's own default is 0, which makes any concurrent writer fail
            // with SQLITE_BUSY instantly. Callers who want the raw fail-fast
            // behaviour can pass `busyTimeout: 0` explicitly.
            busyTimeout: opts.busyTimeout ?? 5000,
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
        if (this.#options.open) {
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
        const rows = plainRows(stmt.all(...toBindables(params)));
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
        const row = plainRow(stmt.get(...toBindables(params)));
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
        const result = stmt.run(...toBindables(params));
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
                const rows = plainRows(stmt.all(...toBindables(params)));
                self.#log('query', `all: ${sql}`, { sql, params, durationMs: performance.now() - started });
                return rows;
            },
            get(...params) {
                const started = performance.now();
                const row = plainRow(stmt.get(...toBindables(params)));
                self.#log('query', `get: ${sql}`, { sql, params, durationMs: performance.now() - started });
                return row;
            },
            run(...params) {
                const started = performance.now();
                const result = stmt.run(...toBindables(params));
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
                // Exponential backoff: 50ms, 100ms, 200ms, ...
                const delay = 50 * 2 ** (attempt - 1);
                // Synchronous sleep via Atomics.wait — legal on Node's main thread (only
                // browsers restrict it to workers). We must not use a bare empty spin
                // loop here: rollup tree-shakes it out of the bundle as a side-effect-
                // free statement, which silently removes the backoff from `dist`. 
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
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
            // Guard the classic misuse: an async callback resolves AFTER this method
            // has returned, so awaiting inside it would silently run outside the
            // (already committed) transaction. Fail loudly instead.
            if (result !== null && typeof result === 'object' &&
                typeof result.then === 'function') {
                throw new TypeError('Sqlo.transaction() received an async callback (returned a Promise). ' +
                    'The synchronous API cannot keep a transaction open across awaits — ' +
                    'use AsyncSqlo.transaction() instead.');
            }
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
            try {
                if (this.#txDepth === 0) {
                    this.#db.exec('ROLLBACK');
                    this.#log('transaction', 'ROLLBACK transaction', { level: 'warn' });
                }
                else {
                    this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                    this.#log('transaction', `ROLLBACK TO SAVEPOINT (depth ${this.#txDepth})`, { level: 'warn' });
                }
            }
            catch {
                // The rollback itself failed (e.g. the failing statement already
                // aborted the transaction). Never let that mask the original error.
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
        const pending = computePending(migrations, applied);
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
                try {
                    if (this.#txDepth === 0) {
                        this.#db.exec('ROLLBACK');
                    }
                    else {
                        this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                    }
                }
                catch {
                    // Rollback already handled by the failing statement — keep going.
                }
                const scope = this.#txDepth === 0 ? 'transaction rolled back' : 'rolled back to savepoint';
                throw new Error(`Migration "${m.name}" failed (${scope}).`, { cause: err });
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
    /**
     * Open the database connection.
     *
     * Required after constructing with `{ open: false }`; also reopens a
     * connection closed via `close()` (node:sqlite reopens at the path given to
     * the constructor — file contents persist, `:memory:` contents do not).
     * Idempotent: calling it on an already-open connection is a no-op.
     */
    open() {
        if (!this.#db.isOpen) {
            this.#db.open();
            // Re-apply connection PRAGMAs — the constructor skips them when opened
            // with `open: false` (node:sqlite rejects exec on a closed connection).
            if (this.#options.busyTimeout > 0) {
                this.#db.exec(`PRAGMA busy_timeout = ${this.#options.busyTimeout}`);
            }
            if (this.#options.journalMode !== 'DELETE') {
                this.#db.exec(`PRAGMA journal_mode = ${this.#options.journalMode}`);
            }
            this.#log('connection', `open database ${this.#options.path === ':memory:' ? '(in-memory)' : this.#options.path}`);
        }
        this.#closed = false;
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
    #ensureMigrationTable(schema) {
        this.#db.exec(ensureMigrationTableSql(schema));
    }
    #getAppliedMigrations(schema) {
        const rows = this.#db.prepare(getAppliedMigrationsSql(schema)).all();
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
        this.#db.prepare(insertMigrationRecordSql(schema)).run(m.name, ts);
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
        const db = new Sqlo({ path, ...(this.#options ?? {}) });
        // Migrations are applied unconditionally and idempotently: the version
        // table records what is already applied, so this is a no-op for migrated
        // databases — and it heals a database file that a previous crash left
        // behind before its baseline migrations finished (the old "file is new"
        // check skipped migration in exactly that case).
        if (this.#migrations.length > 0) {
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
    // SQLite requires a REFERENCES column added via ALTER TABLE to have a NULL default.
    if (col.references && col.default !== undefined && col.default !== null) {
        return `Column "${name}" has a FOREIGN KEY with a non-NULL DEFAULT — SQLite cannot add it with ALTER TABLE. Requires a table-rebuild migration.`;
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
    // Keyword detection runs on a copy with string literals and quoted
    // identifiers stripped, so text like CHECK (x <> 'STRICT') or a column
    // named "STRICT" cannot produce a false positive.
    let strict = false;
    let withoutRowId = false;
    const sqlRow = exec.prepare(`SELECT sql FROM ${master} WHERE type = ? AND name = ?`).get('table', name);
    if (sqlRow?.sql) {
        const stripped = stripQuoted(sqlRow.sql);
        strict = /\bSTRICT\b/.test(stripped);
        withoutRowId = /\bWITHOUT\s+ROWID\b/i.test(stripped);
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
    // Strip string literals / quoted identifiers first: a DEFAULT 'AUTOINCREMENT'
    // or a column named "AUTOINCREMENT" must not count as the keyword.
    return /\bAUTOINCREMENT\b/i.test(row?.sql ? stripQuoted(row.sql) : '');
}
/**
 * Replace single-quoted string literals and double-quoted identifiers with
 * empty placeholders, so keyword scans only see real SQL keywords.
 */
function stripQuoted(sql) {
    return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}
/**
 * Best-effort conversion of a SQLite default-value literal into a JS value.
 * SQLite reports defaults as strings (e.g. "0", "'draft'", "CURRENT_TIMESTAMP").
 * Numeric literals become numbers, quoted strings become strings, everything
 * else (expressions, keywords) is kept as-is.
 */
function parseDefaultLiteral(raw) {
    const s = raw.trim();
    // Number (incl. scientific notation and bare-fraction forms like .5)
    if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
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
 * Async ORM layer — AsyncModel and AsyncQueryBuilder.
 *
 * The "brain on the main thread, hands in the worker" split: the main thread
 * owns all types and query construction (pure functions, zero blocking); the
 * worker is a remote connection that only executes final SQL. These classes
 * mirror the synchronous `Model` and `QueryBuilder` APIs, but every terminal
 * call is a single RPC to the worker.
 *
 * Query construction is deliberately shared with the sync layer:
 * `AsyncQueryBuilder` wraps a real `QueryBuilder` used purely for SQL
 * compilation (`toSql`, `buildWhere`, `buildFirstSql`, …), never for
 * execution; insert/update pipelines reuse the same pure helpers as `Model`.
 * There is exactly one place that knows how a query is built.
 */
// ---------------------------------------------------------------------------
// AsyncQueryBuilder
// ---------------------------------------------------------------------------
/**
 * An executor that is never used for actual execution. AsyncQueryBuilder only
 * compiles SQL through the wrapped QueryBuilder; final execution always goes
 * through `#exec` (a single RPC). Defensive: if a non-terminal wrapper ever
 * leaked into a sync terminal method, this throws loudly instead of silently
 * running on the main thread.
 */
const UNREACHABLE_EXECUTOR = {
    prepare() {
        throw new Error('AsyncQueryBuilder compiles SQL on the main thread but never executes ' +
            'synchronously — use the async terminal methods (all/first/count/pluck).');
    },
};
/**
 * Fluent async SELECT query builder.
 *
 * Chain the same methods as the sync `QueryBuilder`; only the terminal calls
 * (`all`, `first`, `count`, `pluck`) are async — each runs as a single RPC to
 * the worker. Non-terminal chaining is synchronous and free (SQL stays on the
 * main thread).
 */
class AsyncQueryBuilder {
    #qb;
    #exec;
    /**
     * @param exec AsyncExecutor that executes compiled SQL (an AsyncSqlo).
     * @param table Table name to query (`"table"` or `"schema.table"`).
     */
    constructor(exec, table) {
        this.#exec = exec;
        this.#qb = new QueryBuilder(UNREACHABLE_EXECUTOR, table);
    }
    // ---- SELECT ----
    /** Restrict the SELECT to the given columns (quoted as identifiers). */
    select(...cols) {
        this.#qb.select(...cols);
        return this;
    }
    /** Emit `SELECT DISTINCT` to de-duplicate result rows. */
    distinct() {
        this.#qb.distinct();
        return this;
    }
    // ---- JOIN ----
    /** INNER JOIN `table` on a `sql\`...\`` ON clause. */
    join(table, on) {
        this.#qb.join(table, on);
        return this;
    }
    /** LEFT JOIN `table` on a `sql\`...\`` ON clause. */
    leftJoin(table, on) {
        this.#qb.leftJoin(table, on);
        return this;
    }
    /** RIGHT JOIN `table` on a `sql\`...\`` ON clause. */
    rightJoin(table, on) {
        this.#qb.rightJoin(table, on);
        return this;
    }
    /** FULL OUTER JOIN `table` on a `sql\`...\`` ON clause. */
    fullJoin(table, on) {
        this.#qb.fullJoin(table, on);
        return this;
    }
    // ---- WHERE ----
    /** Add an AND condition — plain-object expression or `sql\`...\`` fragment. */
    where(cond) {
        this.#qb.where(cond);
        return this;
    }
    /** Add an OR condition — same accepted shapes as `where()`. */
    orWhere(cond) {
        this.#qb.orWhere(cond);
        return this;
    }
    /** Append a raw SQL fragment as an AND condition (no param binding). */
    raw(fragment) {
        this.#qb.raw(fragment);
        return this;
    }
    // ---- GROUP / HAVING / ORDER ----
    /** GROUP BY the given columns (quoted as identifiers). */
    groupBy(...cols) {
        this.#qb.groupBy(...cols);
        return this;
    }
    /** HAVING condition on aggregated groups — same shapes as `where()`. */
    having(cond) {
        this.#qb.having(cond);
        return this;
    }
    /** ORDER BY a column (quoted) or a `sql\`...\`` fragment, with direction. */
    orderBy(col, dir = 'ASC') {
        this.#qb.orderBy(col, dir);
        return this;
    }
    /** LIMIT the number of returned rows (bound as a parameter). */
    limit(n) {
        this.#qb.limit(n);
        return this;
    }
    /** OFFSET the result window (bound as a parameter; usually paired with `limit()`). */
    offset(n) {
        this.#qb.offset(n);
        return this;
    }
    // ---- Build SQL (pure, synchronous) ----
    /** Build only the WHERE clause (with params) — used for UPDATE/DELETE composition. */
    buildWhere() {
        return this.#qb.buildWhere();
    }
    /** Return the compiled SQL string and bound parameters. */
    toSql() {
        return this.#qb.toSql();
    }
    /** Compile the `first()` query (LIMIT 1 copy of the builder). Pure. */
    buildFirstSql() {
        return this.#qb.buildFirstSql();
    }
    /** Compile the `count()` query (COUNT(*) over the builder). Pure. */
    buildCountSql() {
        return this.#qb.buildCountSql();
    }
    /** Compile the `pluck(col)` query (projection copy of the builder). Pure. */
    buildPluckSql(col) {
        return this.#qb.buildPluckSql(col);
    }
    // ---- Execute (one RPC each) ----
    /** Execute and return all matching rows. */
    async all() {
        const { sql, params } = this.toSql();
        return this.#exec.all(sql, ...params);
    }
    /** Execute and return the first row, or undefined if none. */
    async first() {
        const { sql, params } = this.buildFirstSql();
        return this.#exec.get(sql, ...params);
    }
    /** Execute the COUNT query. */
    async count() {
        const { sql, params } = this.buildCountSql();
        const row = await this.#exec.get(sql, ...params);
        // Coerce: with readBigInts the driver returns a bigint — COUNT fits a
        // safe integer in realistic use, surface a plain number.
        return row?.c === undefined ? 0 : Number(row.c);
    }
    /** Execute and return values of a single column. */
    async pluck(col) {
        const { sql, params } = this.buildPluckSql(col);
        const rows = await this.#exec.all(sql, ...params);
        return rows.map((r) => r[col]);
    }
}
// ---------------------------------------------------------------------------
// AsyncModel
// ---------------------------------------------------------------------------
/**
 * Async typed CRUD operations bound to a single table schema — the async
 * mirror of `Model`, created via `AsyncSqlo#define(schema)`.
 *
 * Insert/read/update/delete methods are type-driven by the schema's row,
 * insert, and patch types and share their SQL construction with the sync
 * layer. Tables are created explicitly with `sync()` — never automatically.
 * Every method returns a Promise; each call crosses the worker boundary once.
 */
class AsyncModel {
    #schema;
    #exec;
    table;
    /**
     * @param exec AsyncExecutor that executes prepared statements (an AsyncSqlo).
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
    async sync() {
        await this.#exec.exec(tableDDL(this.#schema));
        for (const ddl of indexDDLs(this.#schema)) {
            await this.#exec.exec(ddl);
        }
    }
    // ---- INSERT ----
    /**
     * Insert a row and return the full row.
     */
    async insert(data) {
        validateKeys(this.#schema, this.table, data);
        const { sql, values, isEmpty } = buildInsertSql(this.#schema, this.table, data);
        const result = await this.#exec.run(sql, ...values);
        const rid = isEmpty ? await this.#lastInsertRowid() : result.lastInsertRowid;
        const { sql: selSql, params } = resolveAfterInsertSql(this.#schema, this.table, data, rid);
        return (await this.#exec.get(selSql, ...params));
    }
    /**
     * Insert multiple rows atomically — either all succeed or none are kept.
     *
     * Wrapped in a transaction when the executor supports it (AsyncSqlo does).
     * When called inside an outer `db.transaction(...)`, this nests via
     * SAVEPOINT and participates in the outer commit/rollback.
     *
     * For very large batches, pass `{ chunkSize }` to insert in chunks — each
     * chunk gets its own transaction (when not already inside an outer
     * transaction), keeping write-lock hold time and memory bounded. Errors
     * within a chunk roll back only that chunk; previously committed chunks
     * stay.
     */
    async insertMany(rows, options) {
        if (rows.length === 0)
            return [];
        const chunkSize = options?.chunkSize ?? rows.length;
        if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new Error(`insertMany: chunkSize must be a positive integer, got ${options?.chunkSize}.`);
        }
        const tx = this.#exec.transaction;
        const results = [];
        // Inside a transaction, insert through a model bound to the handle — the
        // `db`-bound execution path is serialized behind the active transaction
        // and would deadlock if used here.
        const insertAll = async (exec, list) => {
            const m = new AsyncModel(exec, this.#schema);
            const out = [];
            for (const r of list)
                out.push(await m.insert(r));
            return out;
        };
        if (chunkSize >= rows.length) {
            // Single batch — keep the existing atomic behaviour.
            if (tx) {
                return (await this.#exec.transaction(async (t) => insertAll(t, rows)));
            }
            return insertAll(this.#exec, rows);
        }
        for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);
            if (tx) {
                const inserted = (await this.#exec.transaction(async (t) => insertAll(t, chunk)));
                results.push(...inserted);
            }
            else {
                results.push(...(await insertAll(this.#exec, chunk)));
            }
        }
        return results;
    }
    // ---- SELECT ----
    /**
     * Find a row by its primary key (first primaryKey column).
     * Accepts number / bigint for INTEGER keys and string for TEXT/UUID keys.
     */
    async findById(id) {
        const pkCols = pkColumns(this.#schema);
        if (pkCols.length === 0) {
            throw new Error(`Table "${this.table}" has no primary key column defined. Use findOne() instead.`);
        }
        const where = {};
        where[pkCols[0]] = id;
        return this.findOne(where);
    }
    /** Find a single row matching the condition. */
    async findOne(where) {
        const qb = this.query();
        qb.where(where);
        return qb.first();
    }
    /** Find all rows matching the optional condition. */
    async findAll(where) {
        const qb = this.query();
        if (where !== undefined)
            qb.where(where);
        return qb.all();
    }
    /** Convenience: alias for findAll(). */
    async all() {
        return this.findAll();
    }
    // ---- UPDATE ----
    /**
     * Update rows matching the condition. Returns the number of affected rows.
     * The `where` argument is required.
     */
    async update(patch, where) {
        validateKeys(this.#schema, this.table, patch);
        // Explicit `undefined` means "not patched" (matching the PatchOf type) —
        // never bind it, node:sqlite would reject it with an opaque TypeError.
        const patchEntries = Object.entries(patch).filter(([, v]) => v !== undefined);
        const patchKeys = patchEntries.map(([k]) => k);
        if (patchKeys.length === 0)
            return 0;
        const setClause = patchKeys.map((k) => `${quoteIdent(k)} = ?`).join(', ');
        const patchValues = patchEntries.map(([, v]) => v);
        const qb = new QueryBuilder(UNREACHABLE_EXECUTOR, this.table);
        qb.where(where);
        const { clause, params } = qb.buildWhere();
        if (!clause) {
            throw new Error('update() requires a WHERE condition. Use db.exec() for bulk updates.');
        }
        const result = await this.#exec.run(`UPDATE ${quoteIdent(this.table)} SET ${setClause}${clause}`, ...patchValues, ...params);
        return Number(result.changes);
    }
    // ---- DELETE ----
    /**
     * Delete rows matching the condition. Returns the number of deleted rows.
     * The `where` argument is required.
     */
    async delete(where) {
        const qb = new QueryBuilder(UNREACHABLE_EXECUTOR, this.table);
        qb.where(where);
        const { clause, params } = qb.buildWhere();
        if (!clause) {
            throw new Error('delete() requires a WHERE condition. Use db.exec() for bulk deletes.');
        }
        const result = await this.#exec.run(`DELETE FROM ${quoteIdent(this.table)}${clause}`, ...params);
        return Number(result.changes);
    }
    /**
     * Delete all rows in the table. Returns the number of deleted rows.
     * Explicit escape hatch — unlike `delete()`, no WHERE is required.
     */
    async deleteAll() {
        const result = await this.#exec.run(`DELETE FROM ${quoteIdent(this.table)}`);
        return Number(result.changes);
    }
    // ---- COUNT / EXISTS ----
    /** Count rows matching the optional condition. */
    async count(where) {
        const qb = this.query();
        if (where !== undefined)
            qb.where(where);
        return qb.count();
    }
    /** Check if at least one row matches the condition (LIMIT 1 query). */
    async exists(where) {
        return (await this.findOne(where)) !== undefined;
    }
    // ---- Query builder ----
    /** Get a fluent AsyncQueryBuilder for this table. */
    query() {
        return new AsyncQueryBuilder(this.#exec, this.table);
    }
    /**
     * Return a copy of this model bound to a different executor (e.g. an
     * `AsyncTransaction` handle), keeping the exact same type. Use it inside a
     * transaction callback via `tx.model(...)`.
     */
    withExecutor(exec) {
        return new AsyncModel(exec, this.#schema);
    }
    // ---- Internal ----
    async #lastInsertRowid() {
        const row = await this.#exec.get('SELECT last_insert_rowid() AS "rid"');
        return row?.rid ?? 0;
    }
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
 *
 * Architecture — "brain on the main thread, hands in the worker":
 * The main thread owns all types and query construction (pure functions,
 * zero blocking); the worker is a remote connection that only executes
 * final SQL. `define` / models / the query builder live on the main thread
 * and mirror the sync API exactly; every terminal call is a single RPC.
 * Only execution crosses the worker boundary, so the sync and async layers
 * share one place that knows how a query is built.
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
 *
 * Mirrors the synchronous `Sqlo` API for schema (`define` / `syncAll`),
 * models (`AsyncModel`), transactions, and migrations. Query construction
 * stays on the main thread; only execution crosses to the worker.
 */
class AsyncSqlo {
    #worker;
    #pending = new Map();
    #models = new Map();
    #nextId = 1;
    /**
     * Active transaction nesting depth on this connection. While > 0, ordinary
     * db-level operations join the open transaction (connection semantics —
     * the same mental model as the sync `Sqlo`), instead of being queued behind
     * it on the FIFO lane, where an awaited call would deadlock the transaction.
     */
    #txDepth = 0;
    /**
     * Worker liveness. Once the worker has errored or exited, every future
     * `#send` fails fast instead of posting a message that would never be
     * answered (which would leave callers awaiting forever).
     */
    #dead = false;
    #deadError;
    /**
     * Tail of the FIFO dispatch lane. Outside transactions, every operation
     * (exec/all/get/run, backup, close) and every transaction is enqueued onto
     * this chain, so concurrent transactions cannot merge into one physical
     * transaction. While a transaction is open, ordinary operations bypass the
     * lane and join the open transaction instead (see {@link #dispatch}) —
     * connection semantics, mirroring the sync `Sqlo`.
     */
    #tail = Promise.resolve();
    #fkEnabled;
    /**
     * @param path Database file path (or `':memory:'`) opened inside the worker.
     * @param options Options forwarded to the worker's `DatabaseSync`
     *   constructor. `journalMode` and `busyTimeout` are applied as PRAGMAs
     *   inside the worker (node:sqlite has no constructor options for them) —
     *   same behaviour as the synchronous `Sqlo`. Foreign-key enforcement
     *   defaults to `true` (matching the synchronous `Sqlo`), so `define()` can
     *   warn when it is disabled while the schema declares references.
     */
    constructor(path, options) {
        // Align the foreign-key default with the sync Sqlo (#60): enforcement is
        // ON by default. Pass the resolved flag to the worker's DatabaseSync and
        // remember it here for the define() warning.
        const fkEnabled = options?.enableForeignKeyConstraints !== false;
        this.#fkEnabled = fkEnabled;
        // busyTimeout defaults to 5000ms for parity with the sync Sqlo; an
        // explicit value (including 0) wins. Resolve the default BEFORE the spread
        // so an explicit `busyTimeout: undefined` can't punch through and leave
        // the worker with SQLite's raw fail-fast default (0) while the sync Sqlo
        // would apply 5000ms.
        const workerOptions = {
            ...options,
            busyTimeout: options?.busyTimeout ?? 5000,
            enableForeignKeyConstraints: fkEnabled,
        };
        const workerPath = resolve(__dirname$1, 'async-worker.js');
        this.#worker = new Worker(workerPath, {
            workerData: { path, options: workerOptions },
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
                // Rebuild the SQLite error carrying errcode/errstr so the main thread
                // can classify it with isBusyError / isConstraintError — postMessage
                // would otherwise strip the extended result codes.
                const err = new Error(msg.error?.message ?? 'Unknown worker error');
                err.name = msg.error?.name ?? 'Error';
                if (msg.error?.stack)
                    err.stack = msg.error.stack;
                if (typeof msg.error?.errcode === 'number')
                    err.errcode = msg.error.errcode;
                if (typeof msg.error?.errstr === 'string')
                    err.errstr = msg.error.errstr;
                pending.reject(err);
            }
        });
        this.#worker.on('error', (err) => {
            // Mark dead first so queued operations also fail fast, then reject all
            // in-flight requests.
            this.#markDead(err);
            for (const [, p] of this.#pending) {
                p.reject(err);
            }
            this.#pending.clear();
        });
        this.#worker.on('exit', (code) => {
            this.#markDead(code !== 0
                ? new Error(`AsyncSqlo worker exited unexpectedly (code ${code}). Create a new AsyncSqlo instance.`)
                : new Error('AsyncSqlo worker has exited. Create a new AsyncSqlo instance to continue.'));
            if (code !== 0) {
                for (const [, p] of this.#pending) {
                    p.reject(this.#deadError);
                }
                this.#pending.clear();
            }
        });
    }
    #markDead(err) {
        if (!this.#dead) {
            this.#dead = true;
            this.#deadError = err;
        }
    }
    // ---- Dispatch lane ----
    #enqueue(task) {
        const run = this.#tail.then(task);
        // Keep the chain alive even when a task rejects.
        this.#tail = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * Dispatch an ordinary db-level operation. While a transaction is open on
     * the connection, operations join it directly (mirroring the sync `Sqlo`,
     * where any statement issued inside `transaction()` participates in the
     * transaction). Outside a transaction they are serialized on the FIFO lane.
     *
     * Dispatching around the lane during a transaction is what makes an awaited
     * db-bound model call inside `db.transaction(async (tx) => ...)` work
     * instead of deadlocking: the lane is blocked by the transaction until the
     * callback finishes, so a queued op could never run while the callback
     * awaits it.
     */
    #dispatch(op, sql, params = []) {
        if (this.#txDepth > 0) {
            return this.#send(op, sql, params);
        }
        return this.#enqueue(() => this.#send(op, sql, params));
    }
    #send(op, sql, params = []) {
        if (this.#dead) {
            return Promise.reject(this.#deadError ?? new Error('AsyncSqlo worker is no longer running.'));
        }
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
        return this.#dispatch('exec', sql);
    }
    /**
     * Execute and return all rows.
     */
    all(sql, ...params) {
        return this.#dispatch('all', sql, params);
    }
    /**
     * Execute and return the first row, or undefined.
     */
    get(sql, ...params) {
        return this.#dispatch('get', sql, params);
    }
    /**
     * Execute and return { changes, lastInsertRowid }.
     *
     * `changes` / `lastInsertRowid` may be `bigint` when the worker returns
     * large integers — coerce with `Number()` if you need a plain number.
     */
    run(sql, ...params) {
        return this.#dispatch('run', sql, params);
    }
    // ---- Schema & Model ----
    /**
     * Define a model for a table — the async mirror of `Sqlo#define`.
     *
     * ```ts
     * const users = await db.define({
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
        if (!this.#fkEnabled && schemaHasReferences(schema)) {
            process.emitWarning(`Table "${schema.name}" declares foreign key references but the connection has ` +
                'foreign key enforcement disabled (enableForeignKeyConstraints: false). ' +
                'ON DELETE / ON UPDATE actions will NOT fire. Enable the option to enforce them.', { code: 'SQLO_FOREIGN_KEYS_DISABLED' });
        }
        const model = new AsyncModel(this, schema);
        this.#models.set(schema.name, model);
        return model;
    }
    /**
     * Create all defined tables and indexes.
     */
    async syncAll() {
        for (const model of this.#models.values()) {
            await model.sync();
        }
    }
    // ---- Transaction ----
    /**
     * Run a function inside a transaction — the async mirror of
     * `Sqlo#transaction`. The callback receives an explicit transaction handle
     * (`tx`); operations through it run inside the transaction. db-bound
     * operations issued while the transaction is open (including awaited
     * calls on `db.define()`d models) join the transaction too — the same
     * connection semantics as the sync `Sqlo`. `tx.model(m)` remains the
     * recommended, unambiguous way to run model operations in a transaction.
     *
     * ```ts
     * await db.transaction(async (tx) => {
     *   const u = tx.model(users); // type-safe copy bound to the transaction
     *   await u.update({ balance: 0 }, { id });
     *   await tx.run('UPDATE ledger SET amount = ? WHERE id = ?', 100, 1);
     * });
     * ```
     *
     * Nested transactions are available on the handle:
     * `tx.transaction(async (inner) => { ... })` — and a nested
     * `db.transaction(...)` call works as well — they use SAVEPOINT / RELEASE
     * in the worker and share the outer transaction's fate.
     *
     * Production concurrency: SQLite is single-writer, so concurrent writers can
     * hit `SQLITE_BUSY`. Pass `{ retry: n }` to automatically re-run the whole
     * transaction (from a fresh `BEGIN`) with exponential backoff when the
     * database is locked. The backoff uses a real `setTimeout` sleep (unlike the
     * sync API's busy-wait). Other errors propagate immediately. Retries only
     * apply to top-level transactions — a nested (SAVEPOINT) transaction belongs
     * to an outer one and is never retried.
     */
    async transaction(fn, options) {
        let attempt = 0;
        const maxRetries = options?.retry ?? 0;
        for (;;) {
            try {
                // Nested call (a db.transaction inside an active transaction, e.g. via
                // migrate()): run it directly — the worker turns it into a SAVEPOINT.
                // Enqueueing it would deadlock: the lane is blocked by the outer
                // transaction, which is awaiting this very call.
                if (this.#txDepth > 0) {
                    return await this.#transactionOnce(fn);
                }
                // Enqueue the whole transaction as one indivisible block so it can
                // never be interleaved with concurrent operations or transactions.
                return await this.#enqueue(() => this.#transactionOnce(fn));
            }
            catch (err) {
                if (!isBusyError(err) || attempt >= maxRetries)
                    throw err;
                attempt++;
                // Exponential backoff: 50ms, 100ms, 200ms, ... as a real sleep.
                // While sleeping, the dispatch lane is free for other requests.
                const delay = 50 * 2 ** (attempt - 1);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    async #transactionOnce(fn) {
        await this.#send('txBegin', '');
        this.#txDepth++;
        const tx = this.#makeTransaction();
        try {
            const result = await fn(tx);
            await this.#send('txCommit', '');
            return result;
        }
        catch (err) {
            try {
                await this.#send('txRollback', '');
            }
            catch {
                // A failed rollback must not mask the original error.
            }
            throw err;
        }
        finally {
            this.#txDepth--;
        }
    }
    /**
     * Build the explicit transaction handle. Operations on the handle dispatch
     * directly to the worker (bypassing the FIFO lane) because the enclosing
     * transaction already holds the lane — the worker processes them serially
     * and inside the open transaction. Nested `tx.transaction(...)` recurse
     * into `#transactionOnce`, which the worker turns into a SAVEPOINT.
     */
    #makeTransaction() {
        const owner = this;
        const tx = {
            exec: (sql) => owner.#send('exec', sql),
            all: (sql, ...params) => owner.#send('all', sql, params),
            get: (sql, ...params) => owner.#send('get', sql, params),
            run: (sql, ...params) => owner.#send('run', sql, params),
            transaction: (fn) => owner.#transactionOnce(fn),
            model: (m) => m.withExecutor(tx),
        };
        return tx;
    }
    // ---- Migration ----
    /**
     * Run pending migrations — the async mirror of `Sqlo#migrate`. Returns the
     * list of newly applied migrations.
     *
     * Reuses the same pure migration SQL as the sync layer (version table,
     * applied lookup, pending computation). Each migration runs in its own
     * transaction through the worker's transaction primitives, so already
     * applied migrations survive a later failure.
     *
     * Pass `{ schema: 'aux' }` to manage the migrations of an attached
     * database — the version table is created inside that schema.
     */
    async migrate(migrations, options) {
        const schema = options?.schema ?? 'main';
        await this.exec(ensureMigrationTableSql(schema));
        const rows = await this.all(getAppliedMigrationsSql(schema));
        const applied = new Map();
        for (const row of rows)
            applied.set(row.name, row.applied_at);
        const pending = computePending(migrations, applied);
        for (const m of pending) {
            try {
                await this.transaction(async (tx) => {
                    await this.#applyMigration(tx, m, schema);
                });
            }
            catch (err) {
                throw new Error(`Migration "${m.name}" failed. DB has been rolled back.`, { cause: err });
            }
        }
        return pending;
    }
    async #applyMigration(tx, m, schema) {
        const ts = new Date().toISOString();
        if (typeof m.up === 'string') {
            await tx.exec(m.up);
        }
        else {
            await m.up({ exec: async (sql) => { await tx.exec(sql); } });
        }
        await tx.run(insertMigrationRecordSql(schema), m.name, ts);
    }
    /**
     * List all migrations with their applied status — the async mirror of
     * `Sqlo#migrationStatus`. Pass `{ schema }` to inspect an attached
     * database's migration history.
     */
    async migrationStatus(migrations, options) {
        const schema = options?.schema ?? 'main';
        await this.exec(ensureMigrationTableSql(schema));
        const rows = await this.all(getAppliedMigrationsSql(schema));
        const applied = new Map();
        for (const row of rows)
            applied.set(row.name, row.applied_at);
        return migrations.map((m) => ({
            name: m.name,
            appliedAt: applied.get(m.name) ?? null,
        }));
    }
    // ---- Backup ----
    /**
     * Create an online backup of the database to another file — the async
     * mirror of `Sqlo#backup`. Uses SQLite's `VACUUM INTO`, which takes a
     * consistent snapshot even while the database is in use.
     *
     * @param target File path of the backup to create.
     */
    backup(target) {
        return this.#enqueue(() => this.#send('backup', target));
    }
    // ---- Close ----
    /**
     * Close the worker and its database connection. Waits for all queued
     * operations (including any running transaction) to finish first.
     */
    close() {
        return this.#enqueue(() => this.#send('close', ''));
    }
    /**
     * Terminate the worker immediately (without graceful shutdown). All pending
     * and future operations reject — in-flight requests when the worker dies,
     * and anything sent afterwards (fail-fast, never a hanging promise).
     */
    terminate() {
        this.#markDead(new Error('AsyncSqlo worker was terminated. Create a new AsyncSqlo instance.'));
        this.#worker.terminate();
    }
}

export { AsyncModel, AsyncQueryBuilder, AsyncSqlo, Model, MultiSqlo, QueryBuilder, SQLITE, Sqlo, columnDDL, generateMigrationSql, indexDDLs, isBusyError, isConstraintError, isFragment, isIdent, loadMigrations, loadMigrationsSync, loadTableDefSync, quoteIdent, quoteTable, raw, reflectTableSchema, schemaDiff, sql, tableDDL };
//# sourceMappingURL=index.js.map
