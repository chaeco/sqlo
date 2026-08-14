/**
 * Sqlo — the core class wrapping a `node:sqlite` DatabaseSync instance.
 */
import { DatabaseSync } from 'node:sqlite';
import { Model } from "../model/model.js";
import { quoteIdent } from "../query/sql.js";
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
export class Sqlo {
    #db;
    #options;
    #models = new Map();
    #closed = false;
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
    }
    // ---- Raw access ----
    /**
     * Returns the raw `node:sqlite` DatabaseSync instance for direct use.
     */
    raw() {
        return this.#db;
    }
    // ---- Low-level helpers ----
    /**
     * Execute a SQL string directly (no parameter binding).
     */
    exec(sql) {
        this.#ensureOpen();
        this.#db.exec(sql);
    }
    /**
     * Prepare a statement and return all rows.
     */
    all(sql, ...params) {
        this.#ensureOpen();
        const stmt = this.#db.prepare(sql);
        return plainRows(stmt.all(...params));
    }
    /**
     * Prepare a statement and return the first row, or undefined.
     */
    get(sql, ...params) {
        this.#ensureOpen();
        const stmt = this.#db.prepare(sql);
        return plainRow(stmt.get(...params));
    }
    /**
     * Prepare a statement, execute it, and return the result info.
     */
    run(sql, ...params) {
        this.#ensureOpen();
        const stmt = this.#db.prepare(sql);
        return stmt.run(...params);
    }
    /**
     * Implement the Executor interface for QueryBuilder / Model.
     */
    prepare(sql) {
        this.#ensureOpen();
        const stmt = this.#db.prepare(sql);
        return {
            all(...params) {
                return plainRows(stmt.all(...params));
            },
            get(...params) {
                return plainRow(stmt.get(...params));
            },
            run(...params) {
                return stmt.run(...params);
            },
        };
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
     */
    transaction(fn) {
        this.#ensureOpen();
        if (this.#txDepth === 0) {
            this.#db.exec('BEGIN');
        }
        else {
            this.#db.exec(`SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
        }
        this.#txDepth++;
        try {
            const result = fn();
            this.#txDepth--;
            if (this.#txDepth === 0) {
                this.#db.exec('COMMIT');
            }
            else {
                this.#db.exec(`RELEASE SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
            }
            return result;
        }
        catch (err) {
            this.#txDepth--;
            if (this.#txDepth === 0) {
                this.#db.exec('ROLLBACK');
            }
            else {
                this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
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
    }
    /**
     * Detach a previously attached database. Its schema name becomes
     * unavailable for further queries.
     */
    detach(name) {
        this.#ensureOpen();
        this.#db.exec(`DETACH DATABASE ${quoteIdent(name)}`);
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
                if (this.#txDepth === 0) {
                    this.#db.exec('ROLLBACK');
                }
                else {
                    this.#db.exec(`ROLLBACK TO SAVEPOINT "sqlo_sp_${this.#txDepth}"`);
                }
                throw new Error(`Migration "${m.name}" failed. DB has been rolled back.`, { cause: err });
            }
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
        }
    }
    // ---- Internal ----
    #ensureOpen() {
        if (this.#closed) {
            throw new Error('Database is closed.');
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
// Schema validation
// ---------------------------------------------------------------------------
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
//# sourceMappingURL=sqlo.js.map