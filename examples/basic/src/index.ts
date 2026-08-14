/**
 * @chaeco/sqlo — 基础用法示例
 *
 * 运行前先在仓库根目录执行 `npm install` 和 `npm run build`，
 * 然后在本目录执行：
 *
 *   npm install
 *   npm start
 *
 * 示例覆盖：SQL 文件迁移、schema 定义、类型推导、CRUD、
 * 流式查询构造器、联表查询、事务、raw 逃生舱。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  Sqlo,
  MultiSqlo,
  loadMigrationsSync,
  loadTableDefSync,
  reflectTableSchema,
  schemaDiff,
  sql,
  type RowOf,
  type InsertOf,
} from '@chaeco/sqlo';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. 打开数据库（:memory: 或文件）
// ---------------------------------------------------------------------------

const db = new Sqlo({ path: ':memory:' });

// ---------------------------------------------------------------------------
// 2. SQL 文件迁移 — 显式执行，ORM 不会自动建表
// ---------------------------------------------------------------------------

const migrations = loadMigrationsSync(join(__dirname, '..', 'migrations'));
console.log('迁移文件:', migrations.map((m) => m.name));
const applied = db.migrate(migrations);
console.log('本次应用:', applied.map((m) => m.name));

// ---------------------------------------------------------------------------
// 3. Schema 定义 — 普通对象驱动 TypeScript 类型推导
// ---------------------------------------------------------------------------

const userSchema = {
  name: 'users',
  columns: {
    id:    { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name:  { type: 'TEXT', notNull: true },
    email: { type: 'TEXT', notNull: true, unique: true },
    age:   { type: 'INTEGER' },
  },
} as const;

const postSchema = {
  name: 'posts',
  columns: {
    id:     { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    userId: {
      type: 'INTEGER',
      notNull: true,
      references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
    },
    title:  { type: 'TEXT', notNull: true },
    body:   { type: 'TEXT' },
    status: { type: 'TEXT', notNull: true, default: 'draft' },
  },
  checks: [sql`length(title) > 0`],
  strict: true,
} as const;

type User = RowOf<typeof userSchema>;
type NewUser = InsertOf<typeof userSchema>;

const users = db.define(userSchema);
const posts = db.define(postSchema);

// 表已由迁移创建，sync() 是幂等的（IF NOT EXISTS）
users.sync();
posts.sync();

// ---------------------------------------------------------------------------
// 4. CRUD — insert / findById / findOne / update / delete
// ---------------------------------------------------------------------------

const alice: NewUser = { name: 'alice', email: 'alice@example.com', age: 30 };
const u = users.insert(alice);
console.log('\n插入用户:', u); // 返回完整行

users.insertMany([
  { name: 'bob', email: 'bob@example.com', age: 25 },
  { name: 'carol', email: 'carol@example.com', age: 35 },
]);

console.log('findById(1):', users.findById(1));
console.log('findOne({ email }):', users.findOne({ email: 'bob@example.com' }));

const updated = users.update({ age: 31 }, { id: u.id });
console.log(`更新 ${updated} 行`);

console.log('count():', users.count());
console.log('exists({ name: "bob" }):', users.exists({ name: 'bob' }));

// ---------------------------------------------------------------------------
// 5. 流式查询构造器 — where 操作符 / 排序 / 分页 / 投影
// ---------------------------------------------------------------------------

const adults = users
  .query()
  .where({ age: { gte: 30 } })
  .orderBy('age', 'DESC')
  .all();
console.log('\n成年用户 (age >= 30):', adults.map((x) => x.name));

const byIn = users.query().where({ id: { in: [1, 2] } }).all();
console.log('IN 查询:', byIn.map((x) => x.name));

const names = users.query().orderBy('age', 'ASC').pluck('name');
console.log('pluck name:', names);

// 查看编译后的 SQL 与绑定参数
const { sql: sqlText, params } = users
  .query()
  .where({ age: { between: [20, 40] } })
  .toSql();
console.log('编译 SQL:', sqlText, 'params:', params);

// ---------------------------------------------------------------------------
// 6. 联表查询
// ---------------------------------------------------------------------------

const post = posts.insert({ userId: u.id, title: 'Hello Sqlo' });
posts.insert({ userId: u.id, title: 'Second post', status: 'published' });

const joined = posts
  .query()
  .join('users', sql`users.id = posts.userId`)
  .where({ status: 'published' })
  .select('posts.title', 'users.name')
  .all();
console.log('\n已发布文章（联表）:', joined);

// ---------------------------------------------------------------------------
// 7. 事务 — 失败自动回滚，嵌套自动用 SAVEPOINT
// ---------------------------------------------------------------------------

try {
  db.transaction(() => {
    posts.insert({ userId: u.id, title: 'tx post' });
    throw new Error('回滚！');
  });
} catch {
  console.log('\n事务已回滚，posts 总数:', posts.count());
}

// ---------------------------------------------------------------------------
// 7b. JSON 表结构 — 从 JSON 文件加载 schema
// ---------------------------------------------------------------------------

// 运行时代码位于 dist/，JSON 定义文件保留在 src/ 下。
const tagsSchemaPath = join(__dirname, '..', 'src', 'tags.json');

const tags = db.define(loadTableDefSync(tagsSchemaPath));
tags.sync();
tags.insertMany([
  { label: 'sqlite', color: 'blue' },
  { label: 'node', color: 'green' },
]);
console.log('\nJSON schema 定义的 tags:', tags.query().pluck('label'));

// ---------------------------------------------------------------------------
// 7c. Schema 演进 — 字段更新差异分析（不自动应用）
// ---------------------------------------------------------------------------

const tagsV2 = structuredClone(loadTableDefSync(tagsSchemaPath));
(tagsV2.columns as Record<string, { type: string }>).weight = { type: 'INTEGER' }; // 新增列
const diff = schemaDiff(loadTableDefSync(tagsSchemaPath), tagsV2);
console.log('\nschemaDiff 新增列:', diff.addedColumns);
console.log('安全语句:', diff.statements);

// ---------------------------------------------------------------------------
// 7d. Schema 内省 — 从数据库读实际结构，与代码 schema 对比（真实工作流）
// ---------------------------------------------------------------------------

// tags 表是刚由 tags.json 建的；内省数据库实际结构。
const actualTags = reflectTableSchema(db, 'tags');
const realDiff = schemaDiff(actualTags, loadTableDefSync(tagsSchemaPath));
console.log('\n内省 tags 实际 vs 代码 schema，差异:', JSON.stringify({
  added: realDiff.addedColumns,
  removed: realDiff.removedColumns,
  changed: realDiff.changedColumns,
  warnings: realDiff.warnings.length,
}));

// ---------------------------------------------------------------------------
// 7e. 多数据库 — ATTACH 附加库 + 跨库模型
// ---------------------------------------------------------------------------

const auditPath = join(mkdtempSync(join(tmpdir(), 'sqlo-ex-')), 'audit.db');

// journalMode: 文件库可设为 WAL（读写并发更优，持久化到库文件）
const auditDb = new Sqlo({ path: auditPath, journalMode: 'WAL' });
console.log('\njournal_mode:', auditDb.raw().prepare('PRAGMA journal_mode').get()!.journal_mode);
db.attach(auditPath, 'audit');
auditDb.close();
const auditLogs = db.define({
  name: 'audit.logs',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    msg: { type: 'TEXT', notNull: true },
  },
});
auditLogs.sync();
auditLogs.insertMany([{ msg: 'user created' }, { msg: 'user deleted' }]);
console.log('\n跨库表 audit.logs:', auditLogs.all().map((r) => r.msg).join(' / '));

// attach 库的独立迁移历史
db.migrate([
  { name: '001_audit_marker', up: 'CREATE TABLE audit.marker (id INTEGER PRIMARY KEY, note TEXT)' },
], { schema: 'audit' });
const auditStatus = db.migrationStatus(
  [{ name: '001_audit_marker', up: '' }],
  { schema: 'audit' },
);
console.log('audit 库迁移状态:', auditStatus.map((s) => `${s.name}:${s.appliedAt !== null ? '已应用' : '未应用'}`).join(' / '));
db.detach('audit');

// ---------------------------------------------------------------------------
// 7f. 多用户数据库 — 每用户独立库 + 自动基线迁移（MultiSqlo）
// ---------------------------------------------------------------------------

const tenantDir = mkdtempSync(join(tmpdir(), 'sqlo-ten-'));
const pool = new MultiSqlo({
  dir: tenantDir,
  migrations: [
    { name: '001_notes', up: 'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)' },
  ],
});
const aliceDb = pool.for('alice');
const aliceNotes = aliceDb.define({
  name: 'notes',
  columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, text: { type: 'TEXT', notNull: true } },
});
aliceNotes.insert({ text: 'alice 的笔记' });
const bobNotes = pool.for('bob').define({
  name: 'notes',
  columns: { id: { type: 'INTEGER', primaryKey: true, autoIncrement: true }, text: { type: 'TEXT', notNull: true } },
});
console.log('\nMultiSqlo: alice 笔记数', aliceNotes.count(), '| bob 笔记数(隔离,应为0)', bobNotes.count());
pool.closeAll();

// ---------------------------------------------------------------------------
// 7g. 生产能力 — 错误分类 / 事务重试 / 内省 / 在线备份
// ---------------------------------------------------------------------------

const prodDb = new Sqlo({ path: join(mkdtempSync(join(tmpdir(), 'sqlo-ex-')), 'prod.db') });
prodDb.exec('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, msg TEXT)');
console.log('\nisOpen:', prodDb.isOpen, '| version:', prodDb.version, '| tableExists(logs):', prodDb.tableExists('logs'));
console.log('databaseList:', JSON.stringify(prodDb.databaseList()));

// 在线备份（VACUUM INTO）
const backupPath = join(mkdtempSync(join(tmpdir(), 'sqlo-ex-')), 'backup.db');
prodDb.backup(backupPath);
const bk = new Sqlo({ path: backupPath });
console.log('backup 可独立打开:', bk.tableExists('logs'));
bk.close();

// 错误分类 + 事务重试（持锁时自动重试）
const prodHolder = new Sqlo({ path: prodDb.databaseList()[0]!.file });
prodHolder.raw().exec('BEGIN IMMEDIATE');
prodHolder.close(); // 关闭会 ROLLBACK，释放锁
prodDb.transaction(() => {
  prodDb.exec('INSERT INTO logs (msg) VALUES (\'tx\')');
}, { retry: 3 });
console.log('transaction(retry) 提交成功, 行数:', prodDb.all('SELECT COUNT(*) c FROM logs')[0]!.c);
prodDb.close();

// ---------------------------------------------------------------------------
// 8. raw 逃生舱 — 直接访问 node:sqlite DatabaseSync
// ---------------------------------------------------------------------------

const rawDb = db.raw();
const ver = rawDb.prepare('SELECT sqlite_version() AS v').get() as { v: string };
console.log('\nSQLite 版本:', ver.v);

db.close();
console.log('\n✅ 示例运行完成');
