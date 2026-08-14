# @chaeco/sqlo 基础示例

演示 `@chaeco/sqlo` 的完整用法：SQL 文件迁移、schema 定义与类型推导、CRUD、
流式查询构造器、联表查询、事务、raw 逃生舱、JSON 表结构、schema 差异分析与
内省、多数据库（ATTACH）以及多用户隔离（`MultiSqlo`）。

## 运行

```sh
# 1. 先在仓库根目录构建库本体
cd ../..
npm install
npm run build

# 2. 回到示例目录安装依赖并运行
cd examples/basic
npm install
npm start
```

## 目录结构

```
examples/basic/
├── src/index.ts            # 主示例程序
│   └── tags.json           # JSON 表结构定义（loadTableDefSync 演示）
├── migrations/             # SQL 迁移文件（按文件名排序执行）
│   ├── 001_create_users.sql
│   └── 002_create_posts.sql
├── package.json            # 通过 file:../.. 引用本地 @chaeco/sqlo
└── tsconfig.json
```

## 示例演示的内容

| 章节 | 内容 |
|------|------|
| 1-2 | 打开数据库、SQL 文件迁移 |
| 3-4 | Schema 定义、类型推导、CRUD |
| 5-6 | 流式查询构造器（where 操作符 / 排序 / 分页 / pluck / 联表）|
| 7   | 事务（失败自动回滚）|
| 7b  | JSON 表结构（`loadTableDefSync`）|
| 7c-7d | Schema 演进与内省（`schemaDiff` / `reflectTableSchema`）|
| 7e  | 多数据库 ATTACH + 附加库迁移 + `journalMode: 'WAL'` |
| 7f  | 多用户隔离（`MultiSqlo`，每用户独立库）|
| 8   | raw 逃生舱 |

> 示例程序以内存数据库（`:memory:`）为主运行，运行结束即销毁；附加库与
> `MultiSqlo` 使用临时目录文件。
