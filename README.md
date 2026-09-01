# sqlo

> **[中文文档](./README.zh-CN.md) · English · [更新日志](./CHANGELOG.md)**

A lightweight, type‑first, SQLite‑only ORM for Node.js — built exclusively on
the built‑in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module.

- **Zero third‑party native dependencies.** No `better-sqlite3`, no
  `sqlite-wasm`, no postinstall, no compile step. Just Node.
- **Type‑first.** A plain object schema drives TypeScript inference for
  entity, insert, patch, and query‑return types — no decorators, no classes.
- **SQLite‑only.** No cross‑database abstraction layer, no simulated features
  that SQLite lacks.
- **Minimal by design.** Schema, model, fluent query builder, type mapping,
  and SQL‑file migrations. No cache, no pool, no hooks.

> Requires **Node.js ≥ 22.5.0** (the version where `node:sqlite` shipped).

---

## Why Sqlo?

Most SQLite libraries for Node either pull in a native dependency
(`better-sqlite3`) or ship a WASM build (`sqlite-wasm`). `node:sqlite` gives
us the real thing with zero install cost. Sqlo is a thin, honest wrapper: it
exposes SQLite's synchronous API directly, binds every generated query with
parameters, and never pretends SQLite is something it isn't.

## Installation

```sh
npm install @chaeco/sqlo
```

No postinstall step, no native binaries, nothing to compile.

## Quick start

```ts
import { Sqlo } from '@chaeco/sqlo';

const db = new Sqlo({ path: ':memory:' });

const users = db.define({
  name: 'users',
  columns: {
    id:   { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'TEXT', notNull: true },
    email: { type: 'TEXT', notNull: true },
    age:   { type: 'INTEGER' },
  },
  indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
});

// Connection options (all optional):
//   path                            : database file path or ':memory:' (default)
//   enableForeignKeyConstraints     : enforce FK constraints (default true)
//   busyTimeout                     : busy timeout ms (default 5000)
//   journalMode                     : 'DELETE'|'TRUNCATE'|'PERSIST'|'MEMORY'|'WAL'|'OFF'
//                                     e.g. journalMode: 'WAL' — persisted in the db file
//   readBigInts                     : read INTEGER columns as bigint (default false)
//   enableDoubleQuotedStringLiterals: passed through to node:sqlite
//   allowExtension                  : passed through to node:sqlite

// DDL is explicit — the ORM never auto-creates tables.
users.sync();

// Insert returns the full row, fully typed.
const alice = users.insert({ name: 'alice', email: 'a@x.io', age: 30 });
//            ^? { id: number; name: string; email: string; age: number | null }

// Typed reads.
const found = users.findById(alice.id);
const adult = users.findOne({ age: { gte: 18 } });
const all = users.findAll();

db.close();
```

## Defining a schema

A schema is a plain object. TypeScript infers the row, insert, and patch
types from it — there is no separate model class to write.

```ts
import { sql, type TableDef } from '@chaeco/sqlo';

const posts = db.define({
  name: 'posts',
  columns: {
    id:     { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    userId: { type: 'INTEGER', notNull: true,
              references: { table: 'users', column: 'id', onDelete: 'CASCADE' } },
    title:  { type: 'TEXT', notNull: true },
    body:   { type: 'TEXT' },
    status: { type: 'TEXT', notNull: true, default: 'draft' },
    createdAt: { type: 'TEXT', notNull: true,
                 default: sql`(datetime('now'))` },
  },
  checks: [sql`length(title) > 0`],
  strict: true,
});
```

### Schemas from JSON

`check` / `checks` / partial-index `where` also accept plain SQL strings, so
a schema can live in a JSON file (useful for config-driven or multi-tenant
setups) and be loaded with `loadTableDefSync`:

```json
{
  "name": "users",
  "columns": {
    "id":   { "type": "INTEGER", "primaryKey": true, "autoIncrement": true },
    "name": { "type": "TEXT", "notNull": true },
    "age":  { "type": "INTEGER", "check": "age >= 0" }
  },
  "indexes": [
    { "name": "idx_users_name", "columns": ["name"] }
  ]
}
```

```ts
import { Sqlo, loadTableDefSync } from '@chaeco/sqlo';

const db = new Sqlo({ path: ':memory:' });
const users = db.define(loadTableDefSync('./schemas/users.json'));
users.sync();
```

The loaded definition goes through the same `db.define()` validation as
object literals — but `loadTableDefSync` validates it **at load time**, so
structural mistakes in your JSON (a column missing `type`, an index on an
unknown column, …) throw immediately with the file path instead of surfacing
later at `define()`. Note that a JSON schema cannot express bound-parameter
fragments — CHECK / WHERE constraints must be plain SQL strings there.

Supported column types include `INTEGER`, `REAL`, `TEXT`, `BLOB`, `NUMERIC`,
`BOOLEAN`, `DATE`, `DATETIME`, `TIMESTAMP`, and friends. The mapped JavaScript
types are inferred automatically:

| SQLite type | JS type   |
|-------------|-----------|
| `INTEGER`   | `number`  |
| `REAL`      | `number`  |
| `TEXT`      | `string`  |
| `BLOB`      | `Uint8Array` |
| `NUMERIC`   | `number`  |

Nullability rules:

- A column **without** `notNull` is `T | null` in rows, optional in inserts,
  and accepts `null` explicitly.
- An `autoIncrement`/`primaryKey` column is treated as non-nullable and
  optional in inserts.

```ts
type User = RowOf<typeof usersSchema>;    // { id: number; name: string; ... }
type NewUser = InsertOf<typeof usersSchema>;
type UserPatch = PatchOf<typeof usersSchema>;
```

### Comments are documentation-only

Every `TableDef` (a table-level `comment`) and every column (`comment: string`)
accepts free-text documentation that lives only in your schema definition:

```ts
db.define({
  name: 'users',
  comment: 'user accounts and profiles',
  columns: { score: { type: 'INTEGER', comment: '0–100, reset monthly' } },
});
```

SQLite has no comment syntax, so `comment` never appears in DDL, is ignored by
`schemaDiff()`, can't be read back by `reflectTableSchema()`, and round-trips
through `loadTableDefSync()` — which additionally validates the schema at load
time, so structural mistakes in your JSON (a column missing `type`, an index on
an unknown column, …) throw immediately instead of surfacing later at
`define()`.

### Foreign keys are enforced by default

Foreign key enforcement (`PRAGMA foreign_keys`) is **on by default**, so the
`ON DELETE` / `ON UPDATE` actions you declare in `references` actually fire.
If you explicitly disable it (`enableForeignKeyConstraints: false`) and then
define a table with `references`, Sqlo emits a one-time warning so the silent
no-op doesn't surprise you.

## Model CRUD

```ts
// Insert — returns the inserted row.
const u = users.insert({ name: 'bob', email: 'b@x.io', age: null });

// Read.
users.findById(u.id);          // Row | undefined
users.findOne({ email: 'b@x.io' });  // Row | undefined
users.findAll({ age: { gte: 18 } }); // Row[]
users.all();                   // alias for findAll()
users.count({ age: { gte: 18 } });
users.exists({ name: 'bob' }); // boolean

// Update — a WHERE condition is required.
const changed = users.update({ age: 31 }, { id: u.id }); // → number affected

// Delete — a WHERE condition is required.
const deleted = users.delete({ id: u.id }); // → number affected
```

### Migration safety on update/delete

`update()` and `delete()` **require** a WHERE condition — they throw rather
than let you wipe or overwrite an entire table by accident. For intentional
bulk operations, use `db.exec('UPDATE ...')` with a `sql\`...\`` fragment.

## Query builder

Every model has a fluent query builder. **All generated SQL is
parameter-bound** — values are never string-concatenated.

```ts
const rows = users
  .query()
  .where({ age: { gte: 18 } })
  .orWhere({ name: { like: 'a%' } })
  .orderBy('age', 'DESC')
  .limit(10)
  .all();
```

### Where expressions

```ts
// Equality (and null → IS NULL)
users.query().where({ email: 'a@x.io' });
users.query().where({ deletedAt: null });   // deletedAt IS NULL

// Operators
users.query().where({ age: { gt: 18 } });
users.query().where({ age: { gte: 18, lt: 65 } });   // AND-joined
users.query().where({ age: { ne: 30 } });
users.query().where({ age: { between: [18, 30] } });

// Arrays → IN
users.query().where({ id: [1, 2, 3] });

// LIKE / GLOB / NULL
users.query().where({ name: { like: 'a%' } });
users.query().where({ email: { notLike: '%@spam.io' } });
users.query().where({ age: { isNull: true } });
users.query().where({ age: { notNull: true } });

// Multiple fields AND together; orWhere flips to OR.
users.query().where({ age: { gte: 18 } }).orWhere({ name: { like: 'a%' } });
```

### Joins

```ts
import { sql } from '@chaeco/sqlo';

const rows = posts
  .query()
  .join('users', sql`users.id = posts.userId`)
  .where({ status: 'published' })
  .select('posts.id', 'posts.title', 'users.name')
  .all();
```

Joins support `join` (INNER), `leftJoin`, `rightJoin`, and `fullJoin`. The
`ON` clause is a `sql\`...\`` fragment — identifiers stay raw, values become
bound parameters.

### Aggregates, paging, projection

```ts
users.query().count();                          // number
posts.query().where({ userId: 1 }).pluck('title'); // string[]

users.query().groupBy('age').having({ age: { gte: 30 } }).all();
users.query().orderBy('age', 'DESC').limit(10).offset(20).all();
users.query().distinct().select('age').all();

// Inspect the compiled SQL + params for debugging.
const { sql, params } = users.query().where({ age: { gte: 18 } }).toSql();
```

## Safe SQL composition

The `sql` tagged template builds fragments with automatic parameter binding.
Interpolated values become `?` placeholders; identifiers must be wrapped with
`sql.ident(...)` (auto-quoted) to stay safe.

```ts
import { sql, raw } from '@chaeco/sqlo';

// Values are bound.
const frag = sql`SELECT * FROM users WHERE email = ${email} AND age > ${18}`;
// → text: 'SELECT * FROM users WHERE email = ? AND age > ?', params: [email, 18]

// Identifiers are quoted via sql.ident.
sql`SELECT ${sql.ident('name')} FROM users`;

// Manual fragment — caller is responsible for safety.
raw('1 = 1', []);
```

`quoteIdent` / `quoteTable` / `isFragment` / `isIdent` are also exported for
low‑level use.

## Schema evolution & column changes

Sqlo never applies schema changes automatically — migrations are SQL files
only. But when your table definition changes, `schemaDiff(from, to)` tells
you exactly what SQL is needed, split into **safe statements** (things SQLite
can apply in place) and **warnings** (changes that require a hand-written
table-rebuild migration).

The realistic workflow: your database file already exists (created by an
older version) and your code holds the latest schema. `reflectTableSchema`
reads the **actual** structure from the database so you can diff it against
your code schema — no need to keep a copy of the old schema around:

```ts
import { Sqlo, reflectTableSchema, schemaDiff, type TableDef } from '@chaeco/sqlo';

const db = new Sqlo({ path: './app.db' });

// The schema your code expects.
const desired: TableDef = {
  name: 'users',
  columns: { id: { type: 'INTEGER', primaryKey: true }, age: { type: 'INTEGER' } },
};

// What the database actually has right now.
const actual = reflectTableSchema(db, 'users');

const diff = schemaDiff(actual, desired);
// diff.addedColumns  → ['email']
// diff.statements    → ['ALTER TABLE "users" ADD COLUMN "email" TEXT;']
```

Or compare two schema objects directly:

```ts
import { schemaDiff, generateMigrationSql, type TableDef } from '@chaeco/sqlo';

const oldSchema: TableDef = {
  name: 'users',
  columns: { id: { type: 'INTEGER', primaryKey: true }, age: { type: 'INTEGER' } },
};

const newSchema: TableDef = {
  name: 'users',
  columns: {
    id: { type: 'INTEGER', primaryKey: true },
    age: { type: 'INTEGER' },
    email: { type: 'TEXT' },              // → ADD COLUMN (safe)
  },
};

const diff = schemaDiff(oldSchema, newSchema);
// diff.addedColumns  → ['email']
// diff.statements    → ['ALTER TABLE "users" ADD COLUMN "email" TEXT;']
// diff.warnings      → [] (or notes for NOT NULL / type changes / dropped columns)
```

Safe statements are exactly what `ALTER TABLE ADD COLUMN` and
`CREATE INDEX IF NOT EXISTS` can do in place:

- **Added column** with no `NOT NULL` requirement (or with a `DEFAULT`) →
  `ALTER TABLE ... ADD COLUMN`
- **Added / changed index** → `CREATE INDEX IF NOT EXISTS` / drop + recreate
- **Added table CHECK** → part of the rebuild path

Warnings flag what SQLite cannot change in place, so you must write a
table-rebuild migration by hand:

- Column type change or constraint tightening (e.g. `INTEGER` → `TEXT`, adding
  `NOT NULL` without a default)
- Dropped columns (supported on SQLite ≥ 3.35, but may fail on
  indexed/constrained columns)
- Added `PRIMARY KEY` / `UNIQUE` column (cannot be `ADD COLUMN`-ed)

To generate a ready-to-save migration file:

```ts
const migrationSql = generateMigrationSql(oldSchema, newSchema);
// Review it, save as migrations/003_*.sql, then db.migrate(loadMigrationsSync(...))
```

## Migrations

Migrations are **SQL files** executed in order and tracked in a version
table. Sqlo never diffs schemas automatically — SQLite's `ALTER TABLE`
support is limited, and auto-diff risks data loss.

```sql
-- migrations/001_create_users.sql
CREATE TABLE users (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  age   INTEGER
);

-- migrations/002_add_posts.sql
CREATE TABLE posts (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title  TEXT NOT NULL
);
```

```ts
import { Sqlo, loadMigrationsSync } from '@chaeco/sqlo';

const db = new Sqlo({ path: './app.db' });
const applied = db.migrate(loadMigrationsSync('./migrations'));
// → [ { name: '001_create_users', ... }, ... ] — the ones just applied

db.migrationStatus(loadMigrationsSync('./migrations'));
// → [ { name: '001_create_users', appliedAt: '...' }, ... ]
```

Migration behavior:

- Each migration runs inside its own transaction. A failure rolls back that
  migration and throws — earlier ones stay applied.
- The runner tracks applied migrations by name in the internal
  `_sqlo_migrations` table, so re-running `migrate()` is a no-op.
- SQL files are treated as up‑only. For `up`/`down` pairs, use a `.js`/`.cjs`
  file that default-exports a `MigrationDef`, or pass definitions inline:

```ts
db.migrate([
  {
    name: '001_init',
    up: (db) => { db.exec('CREATE TABLE t (id INTEGER)'); },
    down: (db) => { db.exec('DROP TABLE t'); },
  },
]);
```

`loadMigrationsSync(dir)` sorts files alphabetically and supports `.sql`,
`.js`, and `.cjs` (synchronous loading). For `.mjs` migrations, use the async
`loadMigrations(dir)`.

## Async wrapper (optional)

Sqlo is synchronous by default — that is the honest, simple API. If you need
to keep the event loop unblocked (e.g. in a web server), the optional
`AsyncSqlo` wrapper moves the connection to a worker thread. The design is
"brain on the main thread, hands in the worker": all types and query
construction stay on the main thread (pure functions, zero blocking) and only
the final SQL is shipped to the worker for execution:

```ts
import { AsyncSqlo } from '@chaeco/sqlo';

const db = new AsyncSqlo('./app.db');
await db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
await db.run('INSERT INTO t (id, name) VALUES (?, ?)', 1, 'alice');
const rows = await db.all('SELECT * FROM t');
await db.close();
```

The full typed ORM surface is mirrored as async classes — every terminal call
is a single round-trip to the worker, and fluent query chaining stays
synchronous and free:

```ts
const users = db.define({
  name: 'users',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    email: { type: 'TEXT', notNull: true },
  },
});

await db.syncAll();                    // explicit DDL, same rule as sync

const row = await users.insert({ email: 'a@example.com' });
const byId = await users.findById(row.id);
const adults = await users
  .query()
  .where({ age: { gte: 18 } })
  .orderBy('email')
  .limit(10)
  .all();        // chain synchronously, execute once

await users.update({ name: 'bob' }, { id: 1 });
await users.delete({ id: 1 });
```

The async transaction/migration surfaces keep the same semantics as the
synchronous ones, including per-migration transactions and busy retry:

```ts
await db.transaction(async (tx) => {
  const u = tx.model(users);   // copy bound to the transaction
  const p = tx.model(posts);
  await u.insert({ email: 'c@example.com' });
  await p.insert({ userId: 1, title: 'Hi' });
}, { retry: 5 });   // survives transient write contention (true async backoff)

await db.migrate(migrations, { schema: 'main' });
```

The callback receives an explicit `tx` handle: every operation through it
runs inside the transaction and cannot be interleaved with other work. Use
`tx.model(...)` for a type-safe copy of a model bound to the transaction —
the `db`-bound model is serialized behind the running transaction and would
dequeue only after it finishes. Nested transactions use
`tx.transaction(async (inner) => { ... })` (SAVEPOINTs).

> **Honest disclaimer:** SQLite underneath is still synchronous and
> single-writer. `AsyncSqlo` only avoids event‑loop blocking — it does **not**
> make SQLite concurrent, and multi‑process writes still surface as lock
> timeout errors.

## Raw access

The full `node:sqlite` `DatabaseSync` instance is always available as an
escape hatch:

```ts
const raw = db.raw();          // DatabaseSync
raw.exec('PRAGMA journal_mode = WAL;');
```

Lower‑level bound helpers are also on the `Sqlo` instance directly:

```ts
db.exec('CREATE TABLE t (id INTEGER)');          // void
db.run('INSERT INTO t (id) VALUES (?)', 1);      // { changes, lastInsertRowid }
db.get('SELECT * FROM t WHERE id = ?', 1);       // row | undefined
db.all('SELECT * FROM t');                       // row[]
db.transaction(() => { /* BEGIN / COMMIT, nested = savepoints */ });
```

## Production considerations

SQLite is single‑writer: concurrent writers can hit `SQLITE_BUSY`. Sqlo
exposes these errors honestly (it never simulates locks) but gives you the
tools to handle them:

```ts
import { Sqlo, isBusyError, isConstraintError } from '@chaeco/sqlo';

try {
  db.exec('INSERT ...');
} catch (err) {
  if (isBusyError(err)) {
    // Another connection holds the write lock. Back off and retry,
    // or degrade. (node:sqlite errors carry errcode/errstr.)
  } else if (isConstraintError(err)) {
    // UNIQUE / NOT NULL / CHECK / FK violation.
  }
}
```

### Automatic retry on lock contention

`db.transaction(fn, { retry: n })` re‑runs the whole transaction from a fresh
`BEGIN` with exponential backoff (50ms, 100ms, 200ms, …) when the database is
locked. Non‑busy errors propagate immediately. Nested (SAVEPOINT)
transactions are never retried — they belong to the outer transaction:

```ts
db.transaction(() => {
  orders.insert({ id: 1, amount: 99 });
  orders.insert({ id: 2, amount: 10 });
}, { retry: 5 });   // survives transient write contention
```

### Batching large inserts

`insertMany(rows, { chunkSize })` inserts in chunks, each chunk in its own
transaction (when not already inside an outer transaction) — keeping
write‑lock hold time and memory bounded for very large batches:

```ts
model.insertMany(bigRows, { chunkSize: 1000 });
// Chunk 1 commits; if chunk 2 fails, chunk 1 stays and the error propagates.
```

### Behaviour logging

Every operation is observable through an opt-in logging window — queries
(with bound parameters, exposed verbatim), transactions, schema operations,
migrations and connection lifecycle. Sanitizing sensitive data is the
caller's responsibility:

```ts
const db = new Sqlo({
  path: './app.db',
  onLog: (entry) => {
    // entry: { level, event, message, sql?, params?, durationMs?, detail?, timestamp }
    myLogger.log(entry.level, `[${entry.event}] ${entry.message}`, entry);
  },
  logLevel: 'info',        // 'debug' | 'info' | 'warn'(default) | 'error'
});

db.all('SELECT * FROM users WHERE email = ?', 'a@b.c');
// onLog receives { event: 'query', sql: 'SELECT ...', params: ['a@b.c'], durationMs: 0.3, ... }
```

Events: `query` (exec/all/get/run), `transaction` (BEGIN/COMMIT/ROLLBACK/
SAVEPOINT/retry), `schema` (define), `connection` (open/close/attach/detach/
backup), `migrate` (applied/pending/failed). The default `logLevel` is `warn`
(only warnings and errors); set `'debug'` to observe every query. A throwing
`onLog` never breaks the database operation.

### Connection introspection

```ts
db.isOpen;                 // boolean — connection still open
db.version;                // SQLite library version, e.g. '3.46.0'
db.databaseList();         // [{ name, file }, ...] — main + attached DBs
db.tableExists('users');   // boolean — also 'schema.table' for attached DBs
```

### Online backups

`db.backup(targetPath)` takes a consistent snapshot using SQLite's
`VACUUM INTO` (works while the database is in use; also persists an in‑memory
database to disk):

```ts
db.backup('/backups/app-2026-08-14.db');
```

`model.deleteAll()` is the explicit full‑table clear (unlike `delete()`, no
WHERE required) — for test resets and bulk cleanup.

## Multiple databases

Attach additional SQLite database files to the same connection with
`db.attach(path, name)`. Their tables are then addressable with a
`schema.table` name — define models, run CRUD, join across schemas, and
introspect just like a local table:

```ts
db.attach('./data/audit.db', 'audit');

const logs = db.define({
  name: 'audit.logs',
  columns: {
    id:  { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    msg: { type: 'TEXT', notNull: true },
  },
});
logs.sync();
logs.insert({ msg: 'user created' });

// Cross-database raw query from the same connection.
db.all('SELECT msg FROM audit.logs WHERE id = ?', 1);

// Introspection works across schemas too.
const actual = reflectTableSchema(db, 'audit.logs');

db.detach('audit');   // schema becomes unavailable
```

The file path passed to `attach` is always a bound parameter (never
concatenated); the schema name is validated and quoted as an identifier.
Detaching makes the schema unavailable for further queries.

### Migrating an attached database

Each attached database keeps its own migration history. Pass `{ schema }` to
`migrate()` / `migrationStatus()` to manage it independently of the main
database:

```ts
db.attach('./data/audit.db', 'audit');

db.migrate([
  { name: '001_events', up: 'CREATE TABLE audit.events (id INTEGER PRIMARY KEY, msg TEXT NOT NULL)' },
  { name: '002_index',  up: 'CREATE INDEX audit.idx_events_msg ON events (msg)' },
], { schema: 'audit' });

db.migrationStatus(auditMigrations, { schema: 'audit' });
```

The version table (`_sqlo_migrations`) is created inside the target schema,
so the main and attached databases never interfere with each other.

> **SQLite gotcha:** when writing cross-schema DDL, the schema prefix goes on
> the *index* name, not the table name: `CREATE INDEX audit.idx ON events (msg)`
> (SQLite rejects `ON audit.events`).

### Multi-database boundaries

SQLite's `ATTACH` has hard limits that shape how multi-database setups can
be used:

- **No cross-database foreign keys.** `REFERENCES` cannot point at a table
  in another attached database (SQLite rejects the syntax). Declare
  references only between tables in the same database.
- **Cross-database commits are not atomic.** If the process crashes mid-commit,
  SQLite only guarantees atomicity per database file. Use ATTACH for
  read-heavy / reference-data scenarios; for writes that must be strongly
  consistent across databases, keep them in separate connections or a single
  database.
- **At most 10 attached databases** (SQLite limit).
- **Not a tenant-isolation mechanism.** Attached databases share one
  connection. For strict multi-tenant isolation, use a separate `Sqlo`
  instance per tenant.

## Per-user databases (multi-tenant)

When each user (tenant) needs their **own** database file with fully isolated
data, use `MultiSqlo`. It routes users to dedicated `Sqlo` instances, caches
them, and runs your baseline migrations automatically the first time a user's
database is created:

```ts
import { MultiSqlo } from '@chaeco/sqlo';

const pool = new MultiSqlo({
  dir: './data',                       // one file per user: ./data/alice.db
  options: { enableForeignKeyConstraints: true },
  migrations: [                        // baseline schema for every new user
    { name: '001_users', up: 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)' },
    { name: '002_posts', up: 'CREATE TABLE posts (...)' },
  ],
});

// First access: creates the database file and applies baseline migrations.
const aliceDb = pool.for('alice');
const posts = aliceDb.define({ name: 'posts', columns: { ... } });
posts.insert({ userId: 1, title: 'alice post' });

// Another user gets their own isolated database — none of alice's rows.
const bobDb = pool.for('bob');

// Lifecycle management.
pool.close('alice');   // close one user's connection
pool.closeAll();       // close every open user database
```

Security: `userId` is validated against `^[A-Za-z0-9][A-Za-z0-9._-]*$` to
prevent path traversal, and the file name must never contain path
separators. You can customize the file naming with a `fileName` option.

## API reference

### Classes

| Class | Description |
|-------|-------------|
| `Sqlo` | The core ORM — a thin synchronous wrapper over `node:sqlite`'s `DatabaseSync`. |
| `Model<Row, Insert, Patch>` | Typed CRUD bound to one table schema, returned by `db.define()`. |
| `QueryBuilder<Row>` | Fluent SELECT builder, returned by `model.query()`. |
| `MultiSqlo` | Per-user database manager for multi-tenant isolation. |
| `AsyncSqlo` | Optional worker-thread wrapper that avoids event-loop blocking (full ORM surface mirrored as async classes). |
| `AsyncModel<Row, Insert, Patch>` | Async CRUD mirror of `Model`, created via `AsyncSqlo#define()`. |
| `AsyncQueryBuilder<Row>` | Fluent async SELECT builder, returned by `AsyncModel#query()` — chaining is sync, terminal calls are one RPC each. |

### Functions

| Function | Description |
|----------|-------------|
| `sql\`...\`` | Tagged template building a `SqlFragment` with bound params. |
| `sql.ident(name)` | Safely quote an identifier for interpolation. |
| `raw(text, params?)` | Manually build a `SqlFragment` (caller owns safety). |
| `quoteIdent(name)` / `quoteTable(ref)` | Quote a SQL identifier / table reference. |
| `isFragment(v)` / `isIdent(v)` | Type guards for fragments and identifiers. |
| `tableDDL(schema)` / `columnDDL(col)` / `indexDDLs(schema)` | Generate CREATE TABLE / column / index DDL strings. |
| `schemaDiff(from, to)` | Diff two table definitions into statements + warnings. |
| `generateMigrationSql(from, to)` | Generate a reviewable migration SQL file from a diff. |
| `reflectTableSchema(db, table)` | Read a table's actual structure from the database. |
| `loadTableDefSync(path)` | Load a table definition from a JSON file, validated at load time. |
| `loadMigrationsSync(dir)` / `loadMigrations(dir)` | Load SQL/JS migrations from a directory. |

### Types

`SqloOptions`, `MigrateOptions`, `MultiSqloOptions`, `SchemaDiff`, `TableDef`,
`ColumnDef`, `IndexDef`, `RefAction`, `SqliteType`, `RowOf`, `InsertOf`,
`PatchOf`, `WhereExpr`, `WhereValue`, `WhereOps`, `OrderDir`, `SqlFragment`, `Ident`, `MigrationDef`, `MigrationStatus`, `SqlOptions`, `AsyncExecutor`.

## Design principles

1. **Synchronous and honest.** The sync API is the default and is never
   hidden. The async wrapper only avoids event‑loop blocking.
2. **Explicit DDL.** Tables are created only through `sync()` / `migrate()` —
   never automatically, never via schema diffing.
3. **Parameter binding by default.** Every generated query binds its
   parameters; SQL injection via the ORM is not a code path.
4. **SQLite‑only.** No cross‑database abstraction, no simulated features.
5. **Small scope.** Schema, model, query builder, type mapping, migrations.
   That's it.

### Explicit non‑goals

- ❌ Other databases (Postgres, MySQL, ...)
- ❌ Connection pooling
- ❌ Simulated cross‑process locks
- ❌ Forced asynchrony
- ❌ Third‑party native packages as a default

## License

MIT
