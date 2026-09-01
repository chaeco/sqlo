# sqlo

> **[English](./README.md) · 中文文档 · [更新日志](./CHANGELOG.md)**

一个轻量、类型优先、仅支持 SQLite 的 Node.js ORM——完全基于 Node.js 内置的
[`node:sqlite`](https://nodejs.org/api/sqlite.html) 模块构建。

- **零第三方原生依赖。** 不需要 `better-sqlite3`，不需要 `sqlite-wasm`，没有
  postinstall，没有编译步骤。只需要 Node.js。
- **类型优先。** 一个普通对象 schema 驱动 TypeScript 推导实体（entity）、插入
  （insert）、补丁（patch）和查询返回类型——不需要装饰器，不需要类。
- **仅支持 SQLite。** 没有跨数据库抽象层，不会模拟 SQLite 不具备的能力。
- **设计上保持最小。** Schema、模型、流式查询构造器、类型映射和 SQL 文件迁移。
  没有缓存、没有连接池、没有钩子。

> 要求 **Node.js ≥ 22.5.0**（`node:sqlite` 发布的版本）。

---

## 为什么选择 Sqlo？

大多数 Node.js 的 SQLite 库要么引入原生依赖（`better-sqlite3`），要么携带 WASM
构建（`sqlite-wasm`）。`node:sqlite` 让我们以零安装成本获得真正的 SQLite。Sqlo
是一个薄而诚实的封装：它直接暴露 SQLite 的同步 API，所有生成的查询都使用参数
绑定，并且从不假装 SQLite 是别的东西。

## 安装

```sh
npm install @chaeco/sqlo
```

没有 postinstall 步骤，没有原生二进制，不需要编译任何东西。

## 快速开始

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

// 连接选项（均可选）：
//   path                            : 数据库文件路径或 ':memory:'（默认）
//   enableForeignKeyConstraints     : 是否强制外键约束（默认 true）
//   busyTimeout                     : 忙等待超时毫秒数（默认 5000）
//   journalMode                     : 'DELETE'|'TRUNCATE'|'PERSIST'|'MEMORY'|'WAL'|'OFF'
//                                     例如 journalMode: 'WAL'——持久化在数据库文件中
//   readBigInts                     : 将 INTEGER 列读为 bigint（默认 false）
//   enableDoubleQuotedStringLiterals: 透传给 node:sqlite
//   allowExtension                  : 透传给 node:sqlite
users.sync();

// insert 返回完整的、完全类型化的行。
const alice = users.insert({ name: 'alice', email: 'a@x.io', age: 30 });
//            ^? { id: number; name: string; email: string; age: number | null }

// 类型化的读取。
const found = users.findById(alice.id);
const adult = users.findOne({ age: { gte: 18 } });
const all = users.findAll();

db.close();
```

## 定义 schema

Schema 是一个普通对象。TypeScript 从它推导出行、插入和补丁类型——无需编写单独
的模型类。

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

### 通过 JSON 生成表结构

`check` / `checks` / 部分索引的 `where` 也接受纯 SQL 字符串，因此 schema 可以
放在 JSON 文件里（适合配置驱动或多租户场景），并用 `loadTableDefSync` 加载：

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

加载后的定义与对象字面量走相同的 `db.define()` 校验，且 `loadTableDefSync`
会在**加载时**即完成校验——JSON 里的结构性错误（列缺 `type`、索引指向未知列等）
会带文件路径立即抛出，而不是延迟到 `define()`。注意 JSON 无法表达带绑定
参数的片段——CHECK / WHERE 约束在 JSON 里必须是纯 SQL 字符串。

支持的列类型包括 `INTEGER`、`REAL`、`TEXT`、`BLOB`、`NUMERIC`、`BOOLEAN`、
`DATE`、`DATETIME`、`TIMESTAMP` 等。映射的 JavaScript 类型会自动推导：

| SQLite 类型 | JS 类型   |
|-------------|-----------|
| `INTEGER`   | `number`  |
| `REAL`      | `number`  |
| `TEXT`      | `string`  |
| `BLOB`      | `Uint8Array` |
| `NUMERIC`   | `number`  |

可空性规则：

- **没有** `notNull` 的列，在行中是 `T | null`，插入时可选，且可以显式传 `null`。
- `autoIncrement`/`primaryKey` 列被视为非空，插入时可选。

```ts
type User = RowOf<typeof usersSchema>;    // { id: number; name: string; ... }
type NewUser = InsertOf<typeof usersSchema>;
type UserPatch = PatchOf<typeof usersSchema>;
```

### 注释仅供文档参考

每个表（`comment`）与每一列（`comment: string`）都接受一段自由文本注释，它们只
存在于你的 schema 定义中：

```ts
db.define({
  name: 'users',
  comment: '用户账号与资料',
  columns: { score: { type: 'INTEGER', comment: '0–100，每月重置' } },
});
```

SQLite 没有注释语法，因此 `comment` 从不进入 DDL，会被 `schemaDiff()` 忽略，无
法由 `reflectTableSchema()` 回读，并通过 `loadTableDefSync()` 原样往返——加载时
还会顺带校验整份 schema，JSON 里的结构性错误（列缺 `type`、索引指向未知列等）
会立即抛出。

### 外键约束默认开启

外键强制（`PRAGMA foreign_keys`）**默认开启**，因此你在 `references` 中声明的
`ON DELETE` / `ON UPDATE` 动作会真正生效。如果你显式关闭
（`enableForeignKeyConstraints: false`）后又定义了带 `references` 的表，Sqlo
会发出一次性警告，避免静默失效带来意外。

## Model CRUD

```ts
// insert —— 返回插入后的行。
const u = users.insert({ name: 'bob', email: 'b@x.io', age: null });

// 读取。
users.findById(u.id);          // Row | undefined
users.findOne({ email: 'b@x.io' });  // Row | undefined
users.findAll({ age: { gte: 18 } }); // Row[]
users.all();                   // findAll() 的别名
users.count({ age: { gte: 18 } });
users.exists({ name: 'bob' }); // boolean

// update —— 必须提供 WHERE 条件。
const changed = users.update({ age: 31 }, { id: u.id }); // → 受影响行数

// delete —— 必须提供 WHERE 条件。
const deleted = users.delete({ id: u.id }); // → 受影响行数
```

### update/delete 的迁移安全

`update()` 和 `delete()` **必须**带 WHERE 条件——它们会抛出异常，而不是让你
意外清空或覆盖整张表。对于有意的批量操作，使用 `db.exec('UPDATE ...')` 配合
`sql\`...\`` 片段。

## 查询构造器

每个模型都有一个流式查询构造器。**所有生成的 SQL 都是参数绑定的**——值永远
不会通过字符串拼接。

```ts
const rows = users
  .query()
  .where({ age: { gte: 18 } })
  .orWhere({ name: { like: 'a%' } })
  .orderBy('age', 'DESC')
  .limit(10)
  .all();
```

### WHERE 表达式

```ts
// 相等（以及 null → IS NULL）
users.query().where({ email: 'a@x.io' });
users.query().where({ deletedAt: null });   // deletedAt IS NULL

// 操作符
users.query().where({ age: { gt: 18 } });
users.query().where({ age: { gte: 18, lt: 65 } });   // 用 AND 连接
users.query().where({ age: { ne: 30 } });
users.query().where({ age: { between: [18, 30] } });

// 数组 → IN
users.query().where({ id: [1, 2, 3] });

// LIKE / GLOB / NULL
users.query().where({ name: { like: 'a%' } });
users.query().where({ email: { notLike: '%@spam.io' } });
users.query().where({ age: { isNull: true } });
users.query().where({ age: { notNull: true } });

// 多个字段用 AND 连接；orWhere 切换为 OR。
users.query().where({ age: { gte: 18 } }).orWhere({ name: { like: 'a%' } });
```

### 联表查询

```ts
import { sql } from '@chaeco/sqlo';

const rows = posts
  .query()
  .join('users', sql`users.id = posts.userId`)
  .where({ status: 'published' })
  .select('posts.id', 'posts.title', 'users.name')
  .all();
```

联表支持 `join`（INNER）、`leftJoin`、`rightJoin` 和 `fullJoin`。`ON` 子句是
`sql\`...\`` 片段——标识符保持原样，值变成绑定参数。

### 聚合、分页、投影

```ts
users.query().count();                          // number
posts.query().where({ userId: 1 }).pluck('title'); // string[]

users.query().groupBy('age').having({ age: { gte: 30 } }).all();
users.query().orderBy('age', 'DESC').limit(10).offset(20).all();
users.query().distinct().select('age').all();

// 查看编译后的 SQL 和参数，便于调试。
const { sql, params } = users.query().where({ age: { gte: 18 } }).toSql();
```

## 安全的 SQL 组合

`sql` 标签模板构建片段并自动进行参数绑定。插入的值变成 `?` 占位符；标识符必须
用 `sql.ident(...)` 包裹（自动加引号）以保证安全。

```ts
import { sql, raw } from '@chaeco/sqlo';

// 值会被绑定。
const frag = sql`SELECT * FROM users WHERE email = ${email} AND age > ${18}`;
// → text: 'SELECT * FROM users WHERE email = ? AND age > ?', params: [email, 18]

// 标识符通过 sql.ident 加引号。
sql`SELECT ${sql.ident('name')} FROM users`;

// 手动片段 —— 调用方负责安全性。
raw('1 = 1', []);
```

`quoteIdent` / `quoteTable` / `isFragment` / `isIdent` 也作为底层工具导出。

## Schema 演进与表字段更新

Sqlo 永远不会自动应用 schema 变更——迁移只能是 SQL 文件。但当表定义发生变化时，
`schemaDiff(from, to)` 会告诉你需要哪些 SQL，分为**安全语句**（SQLite 可以原地
应用的）和**警告**（需要手写重建表迁移的变更）。

真实工作流：数据库文件已存在（旧版本创建），代码里是最新 schema。
`reflectTableSchema` 从数据库读取**实际**结构，再与代码 schema 对比——无需保留
一份旧 schema 副本：

```ts
import { Sqlo, reflectTableSchema, schemaDiff, type TableDef } from '@chaeco/sqlo';

const db = new Sqlo({ path: './app.db' });

// 代码期望的 schema。
const desired: TableDef = {
  name: 'users',
  columns: { id: { type: 'INTEGER', primaryKey: true }, age: { type: 'INTEGER' } },
};

// 数据库当前实际结构。
const actual = reflectTableSchema(db, 'users');

const diff = schemaDiff(actual, desired);
// diff.addedColumns  → ['email']
// diff.statements    → ['ALTER TABLE "users" ADD COLUMN "email" TEXT;']
```

或直接对比两个 schema 对象：

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
    email: { type: 'TEXT' },              // → ADD COLUMN（安全）
  },
};

const diff = schemaDiff(oldSchema, newSchema);
// diff.addedColumns  → ['email']
// diff.statements    → ['ALTER TABLE "users" ADD COLUMN "email" TEXT;']
// diff.warnings      → []（或 NOT NULL / 类型变更 / 删列的提示）
```

安全语句正是 `ALTER TABLE ADD COLUMN` 和 `CREATE INDEX IF NOT EXISTS` 能原地
完成的：

- **新增列**且无 `NOT NULL` 要求（或带 `DEFAULT`）→ `ALTER TABLE ... ADD COLUMN`
- **新增 / 变更索引** → `CREATE INDEX IF NOT EXISTS` / drop 后重建
- **新增表级 CHECK** → 属于重建路径

警告标出 SQLite 无法原地修改的变更，必须手写重建表迁移：

- 列类型变更或约束收紧（如 `INTEGER` → `TEXT`、无默认值加 `NOT NULL`）
- 删除列（SQLite ≥ 3.35 支持，但带索引/约束的列可能失败）
- 新增 `PRIMARY KEY` / `UNIQUE` 列（无法通过 `ADD COLUMN` 添加）

生成可直接保存的迁移文件：

```ts
const migrationSql = generateMigrationSql(oldSchema, newSchema);
// 人工审查后保存为 migrations/003_*.sql，再通过 db.migrate(loadMigrationsSync(...)) 执行
```

## 迁移

迁移是**按顺序执行的 SQL 文件**，并通过版本表跟踪。Sqlo 永远不会自动 diff
schema——SQLite 的 `ALTER TABLE` 支持有限，自动 diff 有数据丢失风险。

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
// → [ { name: '001_create_users', ... }, ... ] —— 刚刚应用的迁移

db.migrationStatus(loadMigrationsSync('./migrations'));
// → [ { name: '001_create_users', appliedAt: '...' }, ... ]
```

迁移行为：

- 每个迁移在自己的事务中运行。失败会回滚该迁移并抛出异常——之前的迁移保持
  已应用状态。
- 运行器通过内部 `_sqlo_migrations` 表按名称跟踪已应用的迁移，因此重复调用
  `migrate()` 是空操作。
- SQL 文件只处理 `up`。对于 `up`/`down` 成对迁移，使用默认导出 `MigrationDef`
  的 `.js`/`.cjs` 文件，或直接内联传入定义：

```ts
db.migrate([
  {
    name: '001_init',
    up: (db) => { db.exec('CREATE TABLE t (id INTEGER)'); },
    down: (db) => { db.exec('DROP TABLE t'); },
  },
]);
```

`loadMigrationsSync(dir)` 按字母顺序排序文件，支持 `.sql`、`.js` 和 `.cjs`
（同步加载）。对于 `.mjs` 迁移，请使用异步的 `loadMigrations(dir)`。

## 异步封装（可选）

Sqlo 默认是同步的——这是诚实而简单的 API。如果需要在服务器中保持事件循环不被
阻塞，可选的 `AsyncSqlo` 封装会把连接移到 worker 线程。设计思路是「大脑在主线
程、双手在 worker」：所有类型与查询构造都留在主线程（纯函数、零阻塞），只有
最终的 SQL 被送到 worker 执行：

```ts
import { AsyncSqlo } from '@chaeco/sqlo';

const db = new AsyncSqlo('./app.db');
await db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
await db.run('INSERT INTO t (id, name) VALUES (?, ?)', 1, 'alice');
const rows = await db.all('SELECT * FROM t');
await db.close();
```

完整的类型化 ORM 面被镜像为异步类——每个终结调用都是一次到 worker 的往返，
流式查询链始终保持同步且零阻塞：

```ts
const users = db.define({
  name: 'users',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    email: { type: 'TEXT', notNull: true },
  },
});

await db.syncAll();                    // 显式 DDL，与同步侧同一规则

const row = await users.insert({ email: 'a@example.com' });
const byId = await users.findById(row.id);
const adults = await users
  .query()
  .where({ age: { gte: 18 } })
  .orderBy('email')
  .limit(10)
  .all();        // 同步链式，一次执行

await users.update({ name: 'bob' }, { id: 1 });
await users.delete({ id: 1 });
```

异步事务 / 迁移面与同步侧保持相同语义，包括每个迁移独立事务与 busy 重试：

```ts
await db.transaction(async (tx) => {
  const u = tx.model(users);   // 绑定到该事务的模型副本
  const p = tx.model(posts);
  await u.insert({ email: 'c@example.com' });
  await p.insert({ userId: 1, title: 'Hi' });
}, { retry: 5 });   // 扛得住瞬时写竞争（真正的异步退避）

await db.migrate(migrations, { schema: 'main' });
```

回调收到显式的 `tx` 句柄：通过它执行的每个操作都在事务内部运行，不会被其他工
作交错。用 `tx.model(...)` 获取绑定到该事务的模型类型安全副本——绑定在 `db`
上的模型会被串行排在运行中的事务之后，只有等它结束才会出队。嵌套事务使用
`tx.transaction(async (inner) => { ... })`（SAVEPOINT）。

> **诚实声明：** 底层 SQLite 仍然是同步且单写者的。`AsyncSqlo` 只是避免事件
> 循环阻塞——它**不会**让 SQLite 并发，多进程写入仍会表现为锁超时错误。

## 原始访问

完整的 `node:sqlite` `DatabaseSync` 实例始终可以作为逃生舱使用：

```ts
const raw = db.raw();          // DatabaseSync
raw.exec('PRAGMA journal_mode = WAL;');
```

`Sqlo` 实例上也直接提供更底层的绑定辅助方法：

```ts
db.exec('CREATE TABLE t (id INTEGER)');          // void
db.run('INSERT INTO t (id) VALUES (?)', 1);      // { changes, lastInsertRowid }
db.get('SELECT * FROM t WHERE id = ?', 1);       // row | undefined
db.all('SELECT * FROM t');                       // row[]
db.transaction(() => { /* BEGIN / COMMIT，嵌套 = savepoint */ });
```

## 生产场景

SQLite 是**单写者**的：并发写入可能触发 `SQLITE_BUSY`。Sqlo 诚实暴露这些
错误（绝不模拟锁），但提供处理它们的工具：

```ts
import { Sqlo, isBusyError, isConstraintError } from '@chaeco/sqlo';

try {
  db.exec('INSERT ...');
} catch (err) {
  if (isBusyError(err)) {
    // 另一个连接持有写锁。退避后重试，或降级处理。
    // （node:sqlite 错误携带 errcode/errstr。）
  } else if (isConstraintError(err)) {
    // UNIQUE / NOT NULL / CHECK / 外键 约束违反。
  }
}
```

### 锁竞争时自动重试

`db.transaction(fn, { retry: n })` 在数据库被锁定时，从全新的 `BEGIN` 以
指数退避（50ms、100ms、200ms……）重新执行整个事务。非 busy 错误立即抛出。
嵌套（SAVEPOINT）事务**永不重试**——它们从属于外层事务：

```ts
db.transaction(() => {
  orders.insert({ id: 1, amount: 99 });
  orders.insert({ id: 2, amount: 10 });
}, { retry: 5 });   // 承受短暂的写竞争
```

### 大批量插入分块

`insertMany(rows, { chunkSize })` 分块插入，每块独立事务（当不在外层事务
中时）——让写锁持有时间和内存占用对超大批次保持有界：

```ts
model.insertMany(bigRows, { chunkSize: 1000 });
// 块 1 提交；若块 2 失败，块 1 保留，错误向上传播。
```

### 行为日志

所有操作都可通过可选的日志窗口观察——查询（含绑定参数，**完整暴露**）、
事务、schema 操作、迁移、连接生命周期。敏感数据的脱敏由**调用方**负责：

```ts
const db = new Sqlo({
  path: './app.db',
  onLog: (entry) => {
    // entry: { level, event, message, sql?, params?, durationMs?, detail?, timestamp }
    myLogger.log(entry.level, `[${entry.event}] ${entry.message}`, entry);
  },
  logLevel: 'info',        // 'debug' | 'info' | 'warn'(默认) | 'error'
});

db.all('SELECT * FROM users WHERE email = ?', 'a@b.c');
// onLog 收到 { event: 'query', sql: 'SELECT ...', params: ['a@b.c'], durationMs: 0.3, ... }
```

事件：`query`（exec/all/get/run）、`transaction`（BEGIN/COMMIT/ROLLBACK/
SAVEPOINT/重试）、`schema`（define）、`connection`（open/close/attach/detach/
backup）、`migrate`（applied/pending/failed）。默认 `logLevel` 为 `warn`
（只发警告和错误）；设为 `'debug'` 可观察每条查询。抛异常的 `onLog`
绝不会破坏数据库操作。

### 连接内省

```ts
db.isOpen;                 // boolean——连接是否仍然打开
db.version;                // SQLite 库版本，如 '3.46.0'
db.databaseList();         // [{ name, file }, ...]——main + 附加库
db.tableExists('users');   // boolean——也支持 'schema.table'（附加库）
```

### 在线备份

`db.backup(targetPath)` 使用 SQLite 的 `VACUUM INTO` 生成一致性快照
（数据库使用中也可用；也能把内存库持久化到磁盘）：

```ts
db.backup('/backups/app-2026-08-14.db');
```

`model.deleteAll()` 是显式的全表清空（与 `delete()` 不同，无需 WHERE）——
用于测试重置和批量清理。

## 多数据库

用 `db.attach(path, name)` 把额外的 SQLite 数据库文件挂载到同一个连接上。挂载后
其表可通过 `schema.table` 名称访问——可以定义模型、执行 CRUD、跨库联表查询、
内省，与本地表完全一致：

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

// 同一连接上的跨库原始查询。
db.all('SELECT msg FROM audit.logs WHERE id = ?', 1);

// 内省同样支持跨库。
const actual = reflectTableSchema(db, 'audit.logs');

db.detach('audit');   // 该 schema 立即不可用
```

传给 `attach` 的文件路径始终作为绑定参数（绝不拼接）；schema 名经过校验并以
标识符形式加引号。`detach` 后该 schema 无法再查询。

### 附加库的迁移

每个附加库拥有独立的迁移历史。给 `migrate()` / `migrationStatus()` 传
`{ schema }` 即可独立管理，与主库互不干扰：

```ts
db.attach('./data/audit.db', 'audit');

db.migrate([
  { name: '001_events', up: 'CREATE TABLE audit.events (id INTEGER PRIMARY KEY, msg TEXT NOT NULL)' },
  { name: '002_index',  up: 'CREATE INDEX audit.idx_events_msg ON events (msg)' },
], { schema: 'audit' });

db.migrationStatus(auditMigrations, { schema: 'audit' });
```

版本表（`_sqlo_migrations`）建在目标 schema 内，主库与附加库互不干扰。

> **SQLite 语法陷阱：** 跨库 DDL 时 schema 前缀加在**索引名**上而非表名上：
> `CREATE INDEX audit.idx ON events (msg)`（SQLite 会拒绝 `ON audit.events`）。

### 多数据库边界

SQLite 的 `ATTACH` 有硬限制，决定了多库的使用形态：

- **不支持跨库外键。** `REFERENCES` 不能指向其他附加库中的表（SQLite 直接
  拒绝语法）。`references` 只能声明在同一库内的表之间。
- **跨库提交不保证原子性。** 若进程在提交中途崩溃，SQLite 只保证每个库文件
  各自原子。ATTACH 适合读密集 / 参考数据场景；需要在多个库之间强一致写入时，
  请拆到独立连接或单一数据库。
- **最多 10 个附加库**（SQLite 限制）。
- **不是租户隔离机制。** 附加库共享同一连接。严格的多租户隔离请为每个租户
  创建独立的 `Sqlo` 实例。

## 多用户数据库（多租户）

当每个用户（租户）需要**自己的**数据库文件、数据完全隔离时，使用
`MultiSqlo`。它把用户路由到独立的 `Sqlo` 实例、缓存复用，并在用户库首次创建
时自动应用基线迁移：

```ts
import { MultiSqlo } from '@chaeco/sqlo';

const pool = new MultiSqlo({
  dir: './data',                       // 每用户一个文件：./data/alice.db
  options: { enableForeignKeyConstraints: true },
  migrations: [                        // 每个新用户的基线 schema
    { name: '001_users', up: 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)' },
    { name: '002_posts', up: 'CREATE TABLE posts (...)' },
  ],
});

// 首次访问：创建数据库文件并应用基线迁移。
const aliceDb = pool.for('alice');
const posts = aliceDb.define({ name: 'posts', columns: { ... } });
posts.insert({ userId: 1, title: 'alice post' });

// 另一个用户得到完全隔离的库——看不到 alice 的任何数据。
const bobDb = pool.for('bob');

// 生命周期管理。
pool.close('alice');   // 关闭单个用户的连接
pool.closeAll();       // 关闭所有已打开的用户库
```

安全：`userId` 会按 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 校验以防止路径穿越，且文件名
绝不允许包含路径分隔符。可通过 `fileName` 选项自定义文件命名。

## API 参考

### 类

| 类 | 说明 |
|-------|-------------|
| `Sqlo` | 核心 ORM——`node:sqlite` `DatabaseSync` 的同步薄封装。 |
| `Model<Row, Insert, Patch>` | 绑定到单表 schema 的类型化 CRUD，由 `db.define()` 返回。 |
| `QueryBuilder<Row>` | 流式 SELECT 构造器，由 `model.query()` 返回。 |
| `MultiSqlo` | 按用户管理独立库实例，实现多租户隔离。 |
| `AsyncSqlo` | 可选的 worker 线程封装，避免事件循环阻塞（完整 ORM 面镜像为异步类）。 |
| `AsyncModel<Row, Insert, Patch>` | `Model` 的异步 CRUD 镜像，由 `AsyncSqlo#define()` 创建。 |
| `AsyncQueryBuilder<Row>` | 流式异步 SELECT 构造器，由 `AsyncModel#query()` 返回——链式同步，终结调用各一次 RPC。 |

### 函数

| 函数 | 说明 |
|----------|-------------|
| `sql\`...\`` | 标签模板，构建带绑定参数的 `SqlFragment`。 |
| `sql.ident(name)` | 安全地给标识符加引号，用于插值。 |
| `raw(text, params?)` | 手动构建 `SqlFragment`（调用方负责安全）。 |
| `quoteIdent(name)` / `quoteTable(ref)` | 给 SQL 标识符 / 表引用加引号。 |
| `isFragment(v)` / `isIdent(v)` | 片段与标识符的类型守卫。 |
| `tableDDL(schema)` / `columnDDL(col)` / `indexDDLs(schema)` | 生成 CREATE TABLE / 列 / 索引 DDL 字符串。 |
| `schemaDiff(from, to)` | 对比两张表定义，产出语句与警告。 |
| `generateMigrationSql(from, to)` | 从 diff 生成可审查的迁移 SQL 文本。 |
| `reflectTableSchema(db, table)` | 从数据库读取表的实际结构。 |
| `loadTableDefSync(path)` | 从 JSON 文件加载表定义（加载时即校验）。 |
| `loadMigrationsSync(dir)` / `loadMigrations(dir)` | 从目录加载 SQL/JS 迁移。 |

### 类型

`SqloOptions`、`MigrateOptions`、`MultiSqloOptions`、`SchemaDiff`、`TableDef`、
`ColumnDef`、`IndexDef`、`RefAction`、`SqliteType`、`RowOf`、`InsertOf`、
`PatchOf`、`WhereExpr`、`WhereValue`、`WhereOps`、`OrderDir`、`SqlFragment`、
`Ident`、`MigrationDef`、`MigrationStatus`、`SqlOptions`、`AsyncExecutor`、
`AsyncTransaction`。

## 设计原则

1. **同步且诚实。** 同步 API 是默认且从不隐藏的。异步封装只是避免事件循环
   阻塞。
2. **显式 DDL。** 表只通过 `sync()` / `migrate()` 创建——从不自动创建，从不
   通过 schema diff。
3. **默认参数绑定。** 每条生成的查询都绑定参数；通过 ORM 进行 SQL 注入不是
   一条可行路径。
4. **仅支持 SQLite。** 没有跨数据库抽象，没有模拟能力。
5. **范围小。** Schema、模型、查询构造器、类型映射、迁移。就这些。

### 明确的非目标

- ❌ 其他数据库（Postgres、MySQL、……）
- ❌ 连接池
- ❌ 模拟跨进程锁
- ❌ 强制异步
- ❌ 默认引入第三方原生包

## 许可证

MIT
