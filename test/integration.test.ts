/**
 * Real-world integration scenario: a blog platform running on a real on-disk
 * database file.
 *
 * This suite walks a realistic application lifecycle end-to-end and exercises
 * the library the way a production project actually uses it:
 *
 *   - SQL-file migrations from a real migrations directory, idempotent re-run,
 *     and migration state persisting across reopen
 *   - schema definition, sync, and the full author → post → comment lifecycle
 *   - content listing queries (join, where operators, ordering, paging)
 *   - aggregation (count + groupBy), transactions (commit / rollback / retry),
 *     cascading deletes, cross-database ATTACH, multi-tenant isolation
 *   - online backup, behaviour logging, and error classification
 *   - the same real workflow served through the async worker wrapper
 *
 * Unlike the unit suites (which use `:memory:`), everything here uses a real
 * file so that persistence across close/reopen is verified too.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  Sqlo,
  MultiSqlo,
  AsyncSqlo,
  loadMigrationsSync,
  sql,
  isBusyError,
  isConstraintError,
} from '../src/index.ts';
import type { LogEntry } from '../src/core/logging.ts';
import type { RowOf, InsertOf, PatchOf, Model } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Shared schema for the blog platform
// ---------------------------------------------------------------------------

const userSchema = {
  name: 'users',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'TEXT', notNull: true, unique: true },
    email: { type: 'TEXT', notNull: true, unique: true },
    age: { type: 'INTEGER' },
    active: { type: 'INTEGER', notNull: true, default: 1 },
  },
} as const;

const postSchema = {
  name: 'posts',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    userId: {
      type: 'INTEGER',
      notNull: true,
      references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    },
    title: { type: 'TEXT', notNull: true },
    body: { type: 'TEXT' },
    published: { type: 'INTEGER', notNull: true, default: 0 },
    views: { type: 'INTEGER', notNull: true, default: 0 },
  },
} as const;

const commentSchema = {
  name: 'comments',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    postId: {
      type: 'INTEGER',
      notNull: true,
      references: { table: 'posts', column: 'id', onDelete: 'CASCADE' },
    },
    authorId: {
      type: 'INTEGER',
      references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    },
    body: { type: 'TEXT', notNull: true },
  },
} as const;

type User = RowOf<typeof userSchema>;
type NewUser = InsertOf<typeof userSchema>;
type Post = RowOf<typeof postSchema>;
type Comment = RowOf<typeof commentSchema>;
type UsersModel = Model<RowOf<typeof userSchema>, InsertOf<typeof userSchema>, PatchOf<typeof userSchema>>;
type PostsModel = Model<RowOf<typeof postSchema>, InsertOf<typeof postSchema>, PatchOf<typeof postSchema>>;
type CommentsModel = Model<RowOf<typeof commentSchema>, InsertOf<typeof commentSchema>, PatchOf<typeof commentSchema>>;

// SQL files written to a real migrations directory.
const SQL_FILES: Record<string, string> = {
  '001_create_users.sql': `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      age INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    );
  `,
  '002_create_posts.sql': `
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0
    );
  `,
  '003_create_comments.sql': `
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      postId INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      authorId INTEGER REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
  `,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
let file: string;
const openDbs: Sqlo[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlo-integ-'));
  file = join(dir, 'app.db');
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Sqlo {
  const db = new Sqlo({ path: file });
  openDbs.push(db);
  return db;
}

function writeMigrations(): void {
  for (const [name, sqlText] of Object.entries(SQL_FILES)) {
    writeFileSync(join(dir, name), sqlText);
  }
}

// ---------------------------------------------------------------------------
// 1. Boot: SQL-file migrations on a real file database
// ---------------------------------------------------------------------------

describe('real-world: blog platform on a file database', () => {
  it('boots the schema from SQL-file migrations and re-running is idempotent', () => {
    writeMigrations();
    const db = openDb();
    const migrations = loadMigrationsSync(dir);

    const applied = db.migrate(migrations);
    assert.deepEqual(applied.map((m) => m.name), [
      '001_create_users',
      '002_create_posts',
      '003_create_comments',
    ]);

    // All tables exist.
    assert.equal(db.tableExists('users'), true);
    assert.equal(db.tableExists('posts'), true);
    assert.equal(db.tableExists('comments'), true);

    // status shows everything applied
    const status = db.migrationStatus(migrations);
    assert.ok(status.every((s) => s.appliedAt !== null));

    // Re-running applies nothing.
    assert.equal(db.migrate(migrations).length, 0);
  });

  it('persists data and migration state across close/reopen', () => {
    writeMigrations();
    const db = openDb();
    db.migrate(loadMigrationsSync(dir));
    db.define(userSchema).sync();
    db.define(postSchema).sync();
    db.define(commentSchema).sync();

    const users = db.define(userSchema);
    users.insert({ name: 'alice', email: 'alice@example.com', age: 30 } satisfies NewUser);
    db.close();

    // Reopen the same file — catalog data must survive.
    const reopened = new Sqlo({ path: file });
    openDbs.push(reopened);
    assert.equal(reopened.tableExists('users'), true);
    const alice = reopened.define(userSchema).findOne({ email: 'alice@example.com' });
    assert.equal(alice?.name, 'alice');
    // Migration state survived too — nothing re-applied.
    assert.equal(reopened.migrate(loadMigrationsSync(dir)).length, 0);
  });

  // -------------------------------------------------------------------------
  // 2. Owner + content writing lifecycle
  // -------------------------------------------------------------------------

  describe('content lifecycle', () => {
    let db: Sqlo;
    let u: UsersModel;
    let posts: PostsModel;
    let comments: CommentsModel;

    beforeEach(() => {
      writeMigrations();
      db = openDb();
      db.migrate(loadMigrationsSync(dir));
      u = db.define(userSchema);
      posts = db.define(postSchema);
      comments = db.define(commentSchema);
      db.syncAll();
    });

    it('registers owners, publishes posts and leaves comments', () => {
      const inserted: User[] = u.insertMany([
        { name: 'alice', email: 'alice@example.com', age: 30 },
        { name: 'bob', email: 'bob@example.com', age: 25 },
        { name: 'carol', email: 'carol@example.com', age: 35 },
      ] satisfies NewUser[]);
      assert.equal(inserted.length, 3);
      const alice = u.findById(inserted[0]!.id);
      assert.equal(alice?.name, 'alice');

      // alice publishes two posts
      const p1: Post = posts.insert({ userId: inserted[0]!.id, title: 'Hello Sqlo', published: 1 });
      posts.insert({ userId: inserted[0]!.id, title: 'Draft post', published: 0 });
      assert.equal(posts.count(), 2);

      // a comment on the published post
      const c1: Comment = comments.insert({
        postId: p1.id,
        authorId: inserted[1]!.id,
        body: 'nice post!',
      });
      assert.equal(comments.findById(c1.id)?.body, 'nice post!');

      // update + existence checks
      assert.equal(posts.update({ published: 1 }, { id: p1.id }), 1);
      assert.equal(posts.exists({ title: 'Hello Sqlo' }), true);
      assert.equal(u.exists({ name: 'nobody' }), false);
      assert.equal(u.count(), 3);
    });

    it('enforces unique constraints as SQLITE_CONSTRAINT errors', () => {
      u.insert({ name: 'alice', email: 'alice@example.com' });
      assert.throws(
        () => u.insert({ name: 'alice2', email: 'alice@example.com' }),
        (err: unknown) => {
          assert.equal(isConstraintError(err), true);
          return true;
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Content listing queries
  // -------------------------------------------------------------------------

  describe('content queries', () => {
    let db: Sqlo;
    let u: UsersModel;
    let posts: PostsModel;

    beforeEach(() => {
      writeMigrations();
      db = openDb();
      db.migrate(loadMigrationsSync(dir));
      u = db.define(userSchema);
      posts = db.define(postSchema);
      db.syncAll();

      const authors: User[] = u.insertMany([
        { name: 'alice', email: 'alice@example.com', age: 30 },
        { name: 'bob', email: 'bob@example.com', age: 25 },
        { name: 'carol', email: 'carol@example.com', age: 35 },
      ] satisfies NewUser[]);
      posts.insertMany([
        { userId: authors[0]!.id, title: 'Alpha post', published: 1, views: 100 },
        { userId: authors[0]!.id, title: 'Beta post', published: 1, views: 50 },
        { userId: authors[1]!.id, title: 'Gamma post', published: 0, views: 10 },
        { userId: authors[2]!.id, title: 'Delta post', published: 1, views: 200 },
      ]);
    });

    it('lists published posts joined with the author name', () => {
      const listing = posts
        .query()
        .join('users', sql`"users"."id" = "posts"."userId"`)
        .where({ published: 1 })
        .orderBy(sql`"posts"."views"`, 'DESC')
        .all();
      const titles = listing.map((r) => r.title as string);
      assert.deepEqual(titles, ['Delta post', 'Alpha post', 'Beta post']);

      // left-join flavour: SELECT * surfaces both tables' columns (title from
      // posts, name from users) — note the query builder's select() only takes
      // plain identifiers (no AS aliases); column renaming goes through raw SQL.
      const withAuthor = posts
        .query()
        .leftJoin('users', sql`"users"."id" = "posts"."userId"`)
        .orderBy(sql`"posts"."id"`, 'ASC')
        .limit(1)
        .all() as unknown as Array<{ title: string; name: string }>;
      assert.equal(withAuthor[0]?.title, 'Alpha post');
      assert.equal(withAuthor[0]?.name, 'alice');
    });

    it('filters with where operators and pages with limit/offset', () => {
      // adult authors only, alphabetical, page 1 (2 per page)
      const page = u
        .query()
        .where({ age: { gte: 30 } })
        .orderBy('name', 'ASC')
        .limit(2)
        .offset(0)
        .all();
      assert.deepEqual(page.map((r) => r.name as string), ['alice', 'carol']);

      // page 2 has no more adults
      const page2 = u
        .query()
        .where({ age: { gte: 30 } })
        .orderBy('name', 'ASC')
        .limit(2)
        .offset(2)
        .all();
      assert.equal(page2.length, 0);

      // IN + LIKE + OR combination
      const search = u
        .query()
        .where({ name: { like: 'a%' } })
        .orWhere({ age: { in: [25, 35] } })
        .orderBy('name', 'ASC')
        .all();
      assert.deepEqual(search.map((r) => r.name as string), ['alice', 'bob', 'carol']);
    });

    it('aggregates posts per author with count + groupBy', () => {
      // count() with groupBy wraps in a subquery → number of author groups
      const authorGroups = posts.query().groupBy('userId').count();
      assert.equal(authorGroups, 3);

      // total published posts
      assert.equal(posts.query().where({ published: 1 }).count(), 3);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Transactions
  // -------------------------------------------------------------------------

  describe('transactions', () => {
    let db: Sqlo;
    let u: UsersModel;
    let posts: PostsModel;

    beforeEach(() => {
      writeMigrations();
      db = openDb();
      db.migrate(loadMigrationsSync(dir));
      u = db.define(userSchema);
      posts = db.define(postSchema);
      db.syncAll();
    });

    it('commits a multi-table write and rolls back on failure', () => {
      const alice = u.insert({ name: 'alice', email: 'alice@example.com' });

      // commit path
      const txResult = db.transaction(() => {
        const p = posts.insert({ userId: alice.id, title: 'In tx', published: 1 });
        u.update({ age: 31 }, { id: alice.id });
        return p.id;
      });
      assert.equal(typeof txResult, 'number');
      assert.equal(posts.count(), 1);
      assert.equal(u.findById(alice.id)?.age, 31);

      // rollback path — a late failure undoes everything inside the tx
      assert.throws(() =>
        db.transaction(() => {
          posts.insert({ userId: alice.id, title: 'Will roll back' });
          throw new Error('publishing failed');
        }),
      );
      assert.equal(posts.count(), 1, 'rollback removed the in-tx insert');
    });

    it('reports busy errors and retries a contended transaction', () => {
      const raw2 = new DatabaseSync(file);

      // no retry: the BUSY error propagates immediately
      raw2.exec('BEGIN IMMEDIATE');
      assert.throws(
        () =>
          db.transaction(
            () => {
              u.insert({ name: 'contended', email: 'c@example.com' });
            },
            { retry: 0 },
          ),
        (err: unknown) => isBusyError(err) === true,
      );
      raw2.exec('ROLLBACK');

      // with retry, the write lands once the competing lock is released. The
      // lock handover must happen synchronously inside the callback (attempts)
      // — a setTimeout release would never fire, because the sync transaction
      // blocks the event loop for the whole backoff window.
      let attempts = 0;
      db.transaction(
        () => {
          attempts++;
          if (attempts === 1) {
            raw2.exec('BEGIN IMMEDIATE'); // competing write lock
            u.insert({ name: 'retried', email: 'r@example.com' }); // SQLITE_BUSY
          } else {
            raw2.exec('ROLLBACK'); // release so this attempt succeeds
          }
          u.insert({ name: 'landed', email: 'l@example.com' });
        },
        { retry: 5 },
      );
      assert.ok(attempts >= 2, `expected a retry, got ${attempts}`);
      assert.equal(u.exists({ name: 'landed' }), true);
      raw2.close();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Cascading deletes + cross-database + multi-tenant + ops
  // -------------------------------------------------------------------------

  describe('data integrity and operations', () => {
    it('cascades deletes from owner to posts', () => {
      writeMigrations();
      const db = openDb();
      db.migrate(loadMigrationsSync(dir));
      const u = db.define(userSchema);
      const posts = db.define(postSchema);
      db.syncAll();

      const alice = u.insert({ name: 'alice', email: 'alice@example.com' });
      posts.insertMany([
        { userId: alice.id, title: 'one' },
        { userId: alice.id, title: 'two' },
      ]);
      assert.equal(posts.count(), 2);

      u.delete({ email: 'alice@example.com' });
      assert.equal(posts.count(), 0, 'posts cascade-deleted with the owner');
    });

    it('writes cross-database audit logs via ATTACH', () => {
      writeMigrations();
      const db = openDb();
      db.migrate(loadMigrationsSync(dir));
      const auditFile = join(dir, 'audit.db');
      // create the attached db by opening/closing a file handle
      new Sqlo({ path: auditFile }).close();
      db.attach(auditFile, 'audit');

      const auditLogs = db.define({
        name: 'audit.logs',
        columns: {
          id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
          msg: { type: 'TEXT', notNull: true },
        },
      });
      auditLogs.sync();
      auditLogs.insertMany([{ msg: 'user created' }, { msg: 'post published' }]);

      assert.deepEqual(auditLogs.query().pluck('msg'), ['user created', 'post published']);
      assert.equal(db.databaseList().some((d) => d.name === 'audit'), true);
      db.detach('audit');
      assert.equal(db.databaseList().some((d) => d.name === 'audit'), false);
    });

    it('isolates tenants per user with MultiSqlo', () => {
      const pool = new MultiSqlo({
        dir,
        migrations: [
          { name: '001_notes', up: 'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)' },
        ],
      });
      try {
        const aliceDb = pool.for('alice');
        const bobDb = pool.for('bob');
        const notesSchema = {
          name: 'notes',
          columns: {
            id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
            text: { type: 'TEXT', notNull: true },
          },
        } as const;
        aliceDb.define(notesSchema).insert({ text: 'alice note' });
        assert.equal(aliceDb.define(notesSchema).count(), 1);
        assert.equal(bobDb.define(notesSchema).count(), 0, 'bob sees no alice data');
      } finally {
        pool.closeAll();
      }
    });

    it('takes an online backup that can be opened independently', () => {
      writeMigrations();
      const db = openDb();
      db.migrate(loadMigrationsSync(dir));
      const u = db.define(userSchema);
      db.syncAll();
      u.insertMany([
        { name: 'alice', email: 'alice@example.com' },
        { name: 'bob', email: 'bob@example.com' },
      ] satisfies NewUser[]);

      const backupPath = join(dir, 'backup.db');
      db.backup(backupPath);

      const backup = new Sqlo({ path: backupPath });
      try {
        assert.equal(backup.tableExists('users'), true);
        assert.equal(backup.define(userSchema).count(), 2);
      } finally {
        backup.close();
      }
    });

    it('emits behaviour logs through onLog', () => {
      writeMigrations();
      const entries: LogEntry[] = [];
      const db = new Sqlo({ path: file, onLog: (e) => entries.push(e), logLevel: 'debug' });
      openDbs.push(db);
      db.migrate(loadMigrationsSync(dir));
      const u = db.define(userSchema);
      db.syncAll();
      u.insert({ name: 'alice', email: 'alice@example.com' });

      const queries = entries.filter((e) => e.event === 'query');
      assert.ok(queries.length >= 1, 'query events emitted');
      const insert = queries.find((e) => e.sql?.startsWith('INSERT'));
      assert.ok(insert, 'INSERT logged');
      assert.deepEqual(insert!.params, ['alice', 'alice@example.com']);
      assert.equal(typeof insert!.durationMs, 'number');
    });
  });

  // -------------------------------------------------------------------------
  // 6. The same real workflow through the async wrapper
  // -------------------------------------------------------------------------

  describe('async worker scenario', () => {
    let adb: AsyncSqlo;
    afterEach(async () => {
      if (adb) await adb.close();
    });

    it('serves the full workflow on a file database without blocking the event loop', async () => {
      writeMigrations();
      adb = new AsyncSqlo(file);
      const applied = await adb.migrate(loadMigrationsSync(dir));
      assert.equal(applied.length, 3);

      const au = adb.define(userSchema);
      const aposts = adb.define(postSchema);
      await adb.syncAll();

      const authors = await au.insertMany([
        { name: 'alice', email: 'alice@example.com', age: 30 },
        { name: 'bob', email: 'bob@example.com', age: 25 },
      ]);
      await aposts.insertMany([
        { userId: authors[0]!.id, title: 'async one', published: 1 },
        { userId: authors[1]!.id, title: 'async two', published: 0 },
      ]);

      // join + filter executes in the worker
      const listing = await aposts
        .query()
        .join('users', sql`"users"."id" = "posts"."userId"`)
        .where({ published: 1 })
        .all();
      assert.equal(listing.length, 1);
      assert.equal(listing[0]!.title, 'async one');

      // transaction commits across the worker boundary
      await adb
        .transaction(async (tx) => {
          const tu = tx.model(au);
          await tu.update({ age: 31 }, { id: authors[0]!.id });
          throw new Error('undo');
        })
        .catch(() => {});
      assert.equal((await au.findById(authors[0]!.id))?.age, 30, 'tx rolled back');

      await adb.transaction(async (tx) => {
        const tu = tx.model(au);
        await tu.update({ age: 31 }, { id: authors[0]!.id });
      });
      assert.equal((await au.findById(authors[0]!.id))?.age, 31, 'tx committed');

      // persistence after close
      await adb.close();
      adb = new AsyncSqlo(file);
      assert.equal((await adb.define(userSchema).count()), 2);
    });
  });
});