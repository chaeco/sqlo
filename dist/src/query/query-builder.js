/**
 * Fluent SQLite query builder.
 * Generates SELECT statements with parameter binding.
 */
var _a;
import { isFragment, quoteIdent, quoteTable } from "./sql.js";
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
export class QueryBuilder {
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
//# sourceMappingURL=query-builder.js.map