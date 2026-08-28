# Changelog

本项目所有值得记录的变更都会汇总在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-08-28

### Added

- **Schema 注释（纯文档元数据）** — `TableDef.comment`（表级）与 `ColumnDef.comment`（列级）接受自由文本注释，只存在于 schema 定义中，适合配置驱动 / 多租户场景的自我文档化与数据字典生成。SQLite 无注释语法，故三个边界明确：不进入 DDL、`schemaDiff()` / `generateMigrationSql()` 忽略（仅改注释不会触发 changedColumns / 表重建）、`reflectTableSchema()` 无法回读；JSON 表定义天然透传。

### Changed

- **`loadTableDefSync()` 加载时即校验 schema** — 校验层 `validateSchema` / `schemaHasReferences` 从 `core/sqlo.ts` 迁移至 `src/schema/validate.ts`，与 `db.define()` 共用同一校验器。JSON 表定义的结构性错误（列缺 `type`、索引指向未知列、重复索引名等）在加载瞬间带文件路径抛出，而非延迟到 `define()`；非标准类型名仍保持 warning 不抛（SQLite 类型亲和语义不变）。

### Fixed

- **根 `tsconfig.json` 孤儿 NodeNext 配置修复** — 根配置曾是无人消费的 `moduleResolution: node16` 配置，IDE 默认加载后对无扩展名相对导入报 TS2835，并级联产生 TS18046「`'x'` is of type `'unknown'`」幽灵错误；现对齐真实构建链（`moduleResolution: bundler` + `allowImportingTsExtensions`），严格选项全部保留。

### Tests

- **206 个单元测试**，新增覆盖：列级 / 表级 comment 不进 DDL、diff 忽略 comment 变更、JSON 透传、Row 类型不含 comment、名为 `comment` 的合法列、JSON 加载即校验与 warning 语义、表级 comment 编译期 string 强制。

## [0.3.2] - 2026-08-19

### Changed

- **构建系统 → Rollup** — 源码入口改为单一 ESM bundle（`dist/index.js` + `dist/index.d.ts`），异步 worker 独立产出 `dist/async-worker.js`；测试改用独立 `tsc` 编译到 `dist/test`。源码相对导入不再需要 `.ts` 后缀，`moduleResolution` 为 `bundler`。发布产物从 `dist/src/*` 变为 `dist/index.js`（`exports` 已同步更新）。

## [0.3.1] - 2026-08-14

### Fixed

- **`Model.update()` / `Model.delete()` 不再字符串截取** — 两个方法此前通过 `sql.indexOf(' WHERE ')` 从完整 SELECT 中切片提取 WHERE 子句；`QueryBuilder` 现暴露公开的 `buildWhere()` 返回 `{ clause, params }`，Model 直接复用，彻底消除条件中包含 `" WHERE "` 子串时的截取风险。
- **`#ensureOpen()` 与 `raw()` 逃生舱一致** — 现在同时检查底层 `DatabaseSync.isOpen`。若用户通过 `db.raw().close()` 在外部关闭连接，后续调用会抛出清晰的 "Database connection is not open." 而非 node:sqlite 的原生晦涩错误。

### Changed

- **网站对齐统一模板** — `website/` 落地页同步为 Chaeco 统一深色终端模板，终端演示改为 JSON 配置驱动（`#terminalSteps`），风格与其余项目完全一致。

## [0.3.0] - 2026-08-14

### Added

- **生产能力：错误分类、事务重试、分块插入、连接内省、在线备份**（生产场景深度思考落地）
  - **错误分类**（`src/core/error.ts`）：`isBusyError(e)` / `isConstraintError(e)` 类型守卫 + `SQLITE` 结果码常量。node:sqlite 所有错误 `code` 都是 `ERR_SQLITE_ERROR`，但 `errcode` 携带 SQLite 扩展结果码（busy=5、constraint=19，含扩展位 `& 0xff` 处理）；Sqlo 不包装错误（保持薄封装），提供识别工具
  - **`db.transaction(fn, { retry })`**：SQLITE_BUSY 时指数退避（50/100/200ms…）重跑整个事务；嵌套事务永不重试；非 busy 错误立即抛出
  - **`model.insertMany(rows, { chunkSize })`**：分块插入，每块独立事务，写锁持有时间和内存有界
  - **连接内省**：`db.isOpen`（DatabaseSync 透传）、`db.version`（`sqlite_version()`）、`db.databaseList()`（main + 附加库的 name/file，归一化 PRAGMA database_list 行）、`db.tableExists(name)`（支持 `schema.table`，查对应 schema 的 sqlite_master）
  - **`db.backup(targetPath)`**：`VACUUM INTO` 在线一致性备份（参数绑定路径），内存库也可持久化到磁盘
  - **`model.deleteAll()`**：显式全表清空（delete() 强制 WHERE 的逃生舱）
  - **行为日志窗口**（`SqloOptions.onLog` + `logLevel`）：所有操作可观察——`query`（exec/all/get/run，含**完整暴露**的绑定参数，脱敏由调用方负责）、`transaction`（BEGIN/COMMIT/ROLLBACK/SAVEPOINT/重试）、`schema`（define）、`connection`（open/close/attach/detach/backup）、`migrate`（applied/pending/failed）。默认 `logLevel: 'warn'`，`'debug'` 观察每条查询；`onLog` 抛异常不会破坏数据库操作。`LogEntry`/`LogEvent`/`LogLevel` 类型公开导出
  - **196 个单元测试**（`node --test`），覆盖行 **97.72%** / 分支 **91.76%** / 函数 **94.09%**；`sqlo.js`、`sql.js`、`ddl.js`、`error.js`、`logging.js`、`multi-sqlo.js` 等 100% 行覆盖。测试审计补齐：`rightJoin`/`fullJoin`/`join(INNER)`/`leftJoin`、空 `IN []`、count 分组子查询、where 字符串参数、`quoteTable` 别名、`sql\`\`` 非 tag 调用抛错、`busyTimeout`、表名校验、DEFAULT 含参数抛错、`.cjs` 单对象迁移加载

### Changed

- 包名从 `sqlo` 改为 scoped 包名 **`@chaeco/sqlo`**（package.json / package-lock.json / 两份 README 同步更新）
- README 完整重写：对齐实际 API，覆盖 Quick start / schema / CRUD / 查询构造器 / 迁移 / 异步封装 / 原始访问 / 设计原则 / 生产场景

### Fixed

- 修复 `node:sqlite` 返回 null-prototype 行对象导致的 `deepEqual` 断言失败与 DX 问题（ORM 层归一化为普通对象）
- 修复 LIMIT / OFFSET 未参数化的问题（改为绑定参数）
- 修复可空列无法显式插入 `null` 的类型缺陷（`InsertOf` 类型联合包含 `null`）
- 修复 Node 24 下 `node --test` 不接受目录路径的问题（改用 glob）
- 修复 `run()` 结果 `changes` / `lastInsertRowid` 为 `number | bigint` 的强制转换
- **修复 `having()` 生成 `WHERE` 而非 `HAVING` 的问题**（`#buildWhereClauses` 现支持关键字参数）
- 修复示例项目 `examples/basic` 的 `node:*` 类型解析（本地安装 `@types/node` + tsconfig 显式 `types: ["node"]`）
- **`insertMany()` 改为原子事务**（`Executor` 新增可选 `transaction`，Sqlo 实现；支持在外层事务中通过 SAVEPOINT 嵌套）——修复批量插入半写入问题
- **`migrate()` 支持在外层 `transaction()` 内运行**（复用 `#txDepth` 走 SAVEPOINT，不再裸 `BEGIN` 冲突）
- **`schemaDiff()` 检测表级选项变更**（`strict` / `withoutRowId` / 表级 `checks` 变化加入 warnings）
- **`first()` / `pluck()` 不再污染 builder 状态**（终结操作在状态副本上进行，builder 可复用）
- `AsyncSqlo.run()` 返回类型与同步版统一（`changes: number | bigint`）
- `Model.exists()` 改用 `LIMIT 1` 查询，大表性能更优
- **日志回调重入保护**：`onLog` 执行期间触发的嵌套日志事件被丢弃，杜绝回调内执行数据库操作导致的无限递归（实测深度从 2296 降到有界）——日志只允许观察，不允许触发超出框架权限的事件

## [0.2.0] - 2026-08-14

### Added

- **`journalMode` 连接选项**（`SqloOptions`）：`'WAL'` / `'DELETE'` / `'TRUNCATE'` / `'PERSIST'` / `'MEMORY'` / `'OFF'`，构造器自动执行 `PRAGMA journal_mode`（WAL 持久化到库文件），与 `busyTimeout` 同为常用连接设置的一等公民
- **`SqliteType` 类型约束**（`src/schema/types.ts`）：`ColumnDef` 默认约束为已知 SQLite 类型名（拼错编译期提示），同时 `TableDef` 允许自定义类型名（SQLite 类型亲和，如 `UUID` / `JSON` / `VARCHAR(255)`），运行时对非标准类型名发一次性 `SQLO_SCHEMA_WARNING` 警告而非报错

- **Sqlo 核心类**（`src/core/sqlo.ts`）
  - 基于 Node.js 内置 `node:sqlite` 的 `DatabaseSync` 薄封装，零第三方原生依赖
  - 同步优先 API：`exec` / `all` / `get` / `run`
  - `raw()` 逃生舱，直接暴露底层 `DatabaseSync` 实例
  - 事务支持：`transaction(fn)`，嵌套事务自动使用 SAVEPOINT / RELEASE
  - 行归一化：`all` / `get` / `prepare` 返回普通对象（node:sqlite 的行是 null-prototype）
  - `migrate()` / `migrationStatus()`：迁移执行与状态查询

- **Schema 驱动的类型系统**（`src/schema/types.ts`）
  - 纯对象 schema 驱动 TypeScript 类型推导：`RowOf` / `InsertOf` / `PatchOf`
  - JS ↔ SQLite 类型映射覆盖全部存储类别（INTEGER / REAL / TEXT / BLOB / NUMERIC 等）
  - 可空性推导：未标 `notNull` 的列在插入参数类型中显式包含 `null`
  - `WhereExpr` / `WhereOps` 操作符类型（`eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `like` / `in` / `between` / `isNull` 等）

- **DDL 生成**（`src/schema/ddl.ts`）
  - `tableDDL`：CREATE TABLE 生成，支持主键、自增、外键引用、列级/表级 CHECK
  - `indexDDLs`：CREATE INDEX 生成，支持唯一索引、部分索引、升降序列
  - DDL 中拒绝绑定参数（DEFERRED、CHECK、部分索引 WHERE 不能含占位符）

- **JSON 表结构**（`src/schema/json.ts`）
  - `loadTableDefSync(path)`：从 JSON 文件加载表定义，走与对象字面量相同的 `define()` 校验
  - `check` / `checks` / 部分索引 `where` 现接受 `SqlFragment | string`（纯 SQL 字符串），JSON 可表达

- **Schema 演进分析**（`src/schema/diff.ts`）
  - `schemaDiff(from, to)`：对比两张表定义，产出 `addedColumns` / `removedColumns` / `changedColumns` / `addedIndexes` / `removedIndexes`
  - 安全语句：`ALTER TABLE ADD COLUMN`、`CREATE INDEX IF NOT EXISTS`、`DROP INDEX`
  - 警告项：列类型/约束变更、删列、新增 PRIMARY KEY/UNIQUE 列、无默认值 NOT NULL 列（需手写重建表迁移）
  - `generateMigrationSql(from, to)`：生成可保存为 `.sql` 迁移文件的文本（含人工审查提示）
  - 保持 #30 原则：只做差异分析辅助，永不自动应用 schema 变更

- **Schema 内省**（`src/schema/reflect.ts`）
  - `reflectTableSchema(db, table)`：从数据库读取**实际**表结构（列/类型/可空/默认值/主键/自增/UNIQUE/索引/strict/withoutRowId）
  - 与 `schemaDiff` 组合成真实工作流：数据库旧结构 vs 代码新 schema → 生成迁移 SQL（无需手动维护旧 schema 副本）

- **外键约束默认开启**
  - `enableForeignKeyConstraints` 默认值改为 `true`，声明的 `ON DELETE` / `ON UPDATE` 动作真正生效
  - 显式关闭且 schema 含 `references` 时发出一次性警告（`SQLO_FOREIGN_KEYS_DISABLED`）

- **`findById` 支持字符串主键**
  - 类型签名放宽为 `number | bigint | string`，TEXT/UUID 主键可直接使用（运行时本已支持）

- **多数据库支持**（ATTACH / DETACH）
  - `Sqlo.attach(path, name)`：把额外 SQLite 库挂载到同一连接，文件路径参数绑定、schema 名标识符校验后内联
  - `Sqlo.detach(name)`：卸载已附加库
  - `db.define({ name: 'schema.table' })`：跨库模型定义（表名校验支持可选 schema 前缀）
  - `reflectTableSchema` 跨库适配（`PRAGMA schema.table_info` / 按 schema 查 `sqlite_master`）
  - 跨库 CRUD / 联表 / 内省 / 迁移均可用
  - **`db.migrate(migrations, { schema })`**：每个附加库独立的版本化迁移历史（版本表建在目标 schema 内）
  - 文档明确边界：不支持跨库外键、跨库提交非原子、最多 10 个附加库、非租户隔离

- **多用户数据库（多租户隔离）**（`src/core/multi-sqlo.ts`）
  - `MultiSqlo`：按 `userId` 路由到独立的 `Sqlo` 实例，每用户一个数据库文件，数据完全隔离
  - 首次访问自动创建库文件 + 应用基线迁移（已存在库不重复迁移）
  - 实例缓存复用；`close(userId)` / `closeAll()` 管理连接生命周期
  - 安全：`userId` 按 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 校验防路径穿越；`fileName` 自定义命名策略

- **安全 SQL 组合**（`src/query/sql.ts`）
  - `sql\`...\`` 标签模板：插值自动变 `?` 占位符并收集参数
  - `sql.ident()` / `quoteIdent` / `quoteTable`：标识符自动加引号并校验
  - `raw()` / `isFragment` / `isIdent`：手动片段与类型守卫

- **流式查询构造器**（`src/query/query-builder.ts`）
  - `where` / `orWhere` / `having` / `groupBy` / `orderBy` / `limit` / `offset`
  - `join` / `leftJoin` / `rightJoin` / `fullJoin`
  - `select` / `distinct` / `count` / `first` / `all` / `pluck`
  - `toSql()`：查看编译后的 SQL 与参数
  - **全部生成的查询使用参数绑定，从不字符串拼接 SQL**

- **Model 层**（`src/model/model.ts`）
  - `insert` / `findById` / `findOne` / `findAll` / `all`
  - `update(patch, where)` / `delete(where)`：**强制要求 WHERE 条件**，防止误操作全表
  - `count` / `exists` / `query`
  - `sync()`：显式建表，永不自动建表

- **SQL 文件迁移**（`src/migration/migration.ts`）
  - `loadMigrationsSync(dir)`：同步加载 `.sql` / `.js` / `.cjs`
  - `loadMigrations(dir)`：异步加载，支持 `.mjs`
  - 迁移按名称记录到内部 `_sqlo_migrations` 版本表，重复执行是空操作
  - 每个迁移独立事务，失败自动回滚

- **可选异步封装**（`src/async/`）
  - `AsyncSqlo`：基于 `worker_threads`，数据库操作移出主线程，避免事件循环阻塞
  - 诚实声明：底层 SQLite 仍同步、单写者；不模拟并发

- **工程基础设施**
  - TypeScript 严格模式（`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` 等）
  - 源码按职责分组：`core` / `schema` / `query` / `model` / `migration` / `async`
  - 源码相对导入使用 `.ts` 后缀 + `rewriteRelativeImportExtensions`，产物自动改写回 `.js`
  - `scripts/rewrite-dts.mjs`：修复 `.d.ts` 声明文件中的导入后缀
  - tsconfig 显式声明 `types: ["node"]`，消除编辑器对 `node:*` 模块的解析歧义
  - `node:*` 内置模块一律静态导入，禁止 `await import('node:fs/promises')` 动态导入（`loadMigrations` 已改为顶层静态导入）
  - **`dist/src` 构建产物提交到仓库**：JS 项目可直接 `npm install github:chaeco/sqlo` 或 clone 后使用，无需构建步骤（`dist/test` 为测试编译产物，不入库）
  - **GitHub Actions 三套 workflow**：`ci.yml`（测试矩阵）、`pages.yml`（website 变更自动部署 GitHub Pages）、`publish.yml`（`v*` tag 触发 npm 发布）
  - **示例项目**（`examples/basic/`）：独立可运行的 TS 项目，演示 SQL 迁移 / schema / CRUD / 查询构造器 / 联表 / 事务 / raw / JSON 表结构 / schema 演进与内省 / 多数据库（含 `journalMode: 'WAL'`）/ 多用户隔离
  - 英文 README + 中文 README（`README.zh-CN.md`）+ CHANGELOG 文档体系，含完整 API 参考
  - **`journalMode` 连接选项**（`SqloOptions`）：`'WAL'` / `'DELETE'` / `'TRUNCATE'` / `'PERSIST'` / `'MEMORY'` / `'OFF'`，构造器自动执行 `PRAGMA journal_mode`（WAL 持久化到库文件），与 `busyTimeout` 同为常用连接设置的一等公民
  - **`SqliteType` 类型约束**（`src/schema/types.ts`）：`ColumnDef` 默认约束为已知 SQLite 类型名（拼错编译期提示），同时 `TableDef` 允许自定义类型名（SQLite 类型亲和，如 `UUID` / `JSON` / `VARCHAR(255)`），运行时对非标准类型名发一次性 `SQLO_SCHEMA_WARNING` 警告而非报错
  - **150 个单元测试**（`node --test`）覆盖全部核心模块，包括 `AsyncSqlo` worker 封装、JSON 表结构、schema 差异分析/内省、多数据库与附加库迁移、多用户隔离、`journalMode` 与类型约束
