/**
 * Scenario / robustness tests beyond the unit suite:
 *  - multi-process migration races (sync and async)
 *  - async worker bootstrap failure fail-fast
 *  - migration-loader ESM handling
 *  - connection reopen PRAGMA replay
 *  - failure injection (corrupt / read-only database)
 *  - a seeded fuzz over the security-sensitive identifier, column-type and
 *    WHERE-value paths
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Sqlo,
  AsyncSqlo,
  columnDDL,
  quoteIdent,
  loadMigrations,
  loadMigrationsSync,
} from '../src/index.ts';

// Absolute path to the built bundle. Tests execute from dist/test/, so
// '../index.js' resolves to the dist bundle the spawned children import.
const BUNDLE = fileURLToPath(new URL('../index.js', import.meta.url));

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RaceResult {
  applied: string[];
  rechecked: boolean;
}

/**
 * Build a child program that races another copy to migrate the same file.
 * The first migration holds the write lock for 800ms, so the loser is
 * guaranteed to be waiting on the lock when it re-checks the version table.
 * `sleep` parks the thread (Atomics.wait) instead of spinning, so it does
 * not CPU-starve the sibling process on a 1-2 core CI runner.
 */
function writeRaceChild(dir: string, mode: 'sync' | 'async'): string {
  const file = join(dir, 'race-' + mode + '.mjs');
  const importName = mode === 'sync' ? 'Sqlo' : 'AsyncSqlo';
  const asyncKeyword = mode === 'sync' ? '' : 'async ';
  const awaitKeyword = mode === 'sync' ? '' : 'await ';
  const closeLine = mode === 'sync' ? 'db.close();' : 'await db.close();';
  const lines = [
    "import { writeFileSync } from 'node:fs';",
    'import { ' + importName + ' } from ' + JSON.stringify(pathToFileURL(BUNDLE).href) + ';',
    'const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };',
    'const startAt = Number(process.argv[3]);',
    'const resultPath = process.argv[4];',
    'let rechecked = false;',
  ];
  if (mode === 'sync') {
    lines.push('const db = new Sqlo({');
    lines.push('  path: process.argv[2],');
    lines.push('  onLog: (e) => { if (String(e.message).includes("already applied by another process")) rechecked = true; },');
    lines.push('});');
  } else {
    lines.push('const db = new AsyncSqlo(process.argv[2]);');
  }
  lines.push(
    'sleep(startAt - Date.now());',
    'const migrations = [',
    '  { name: "race_slow", up: ' + asyncKeyword + '(e) => { ' + awaitKeyword + 'e.exec("CREATE TABLE race_slow(id INTEGER PRIMARY KEY)"); sleep(800); } },',
    '  { name: "race_1", up: ' + asyncKeyword + '(e) => { ' + awaitKeyword + 'e.exec("CREATE TABLE race_1(id INTEGER PRIMARY KEY)"); } },',
    '];',
    'const applied = ' + awaitKeyword + 'db.migrate(migrations);',
    'writeFileSync(resultPath, JSON.stringify({ applied: applied.map((m) => m.name), rechecked }));',
    closeLine,
  );
  writeFileSync(file, lines.join('\n'));
  return file;
}

function runChild(script: string, dbPath: string, startAt: number, resultPath: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, dbPath, String(startAt), resultPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('robustness: multi-process migration race', () => {
  for (const mode of ['sync', 'async'] as const) {
    it(mode + ' migrate: exactly one process applies, the loser re-checks', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlo-race-' + mode + '-'));
      try {
        const dbPath = join(dir, 'race.db');
        const script = writeRaceChild(dir, mode);
        const startAt = Date.now() + 1200;
        const resultA = join(dir, 'result-a.json');
        const resultB = join(dir, 'result-b.json');
        const [a, b] = await Promise.all([
          runChild(script, dbPath, startAt, resultA),
          runChild(script, dbPath, startAt, resultB),
        ]);
        for (const [i, r] of [a, b].entries()) {
          assert.equal(r.code, 0, 'child ' + i + ' exited ' + r.code + ': ' + r.stderr);
        }
        const results = [resultA, resultB].map(
          (p) => JSON.parse(readFileSync(p, 'utf-8')) as RaceResult,
        );
        const appliers = results.filter((r) => r.applied.includes('race_slow'));
        assert.equal(appliers.length, 1, 'expected exactly one applier, got ' + JSON.stringify(results));
        assert.deepEqual(
          appliers[0]?.applied.slice().sort(),
          ['race_1', 'race_slow'],
          'the winner must apply every migration: ' + JSON.stringify(results),
        );
        // Whether the loser skipped via an empty pending list or via the
        // in-transaction re-check is timing-dependent, so the branch itself is
        // asserted deterministically by the 'concurrent migrator re-check' tests
        // below; here we only pin the end-to-end invariant.
        const db = new Sqlo({ path: dbPath });
        try {
          const rows = db.all<{ name: string }>('SELECT name FROM _sqlo_migrations');
          assert.equal(rows.length, 2);
          assert.equal(db.tableExists('race_slow'), true);
          assert.equal(db.tableExists('race_1'), true);
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('robustness: async worker bootstrap failure', () => {
  it('fails fast and stays dead when the worker cannot open the database', async () => {
    const missing = join(
      tmpdir(),
      'sqlo-missing-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      'db.sqlite',
    );
    const db = new AsyncSqlo(missing);
    try {
      await assert.rejects(() => db.exec('SELECT 1'), /unable to open|SQLITE_CANTOPEN|cannot open/i);
      // The dead instance must reject later calls instead of hanging.
      await assert.rejects(() => db.all('SELECT 1'), /unable to open|SQLITE_CANTOPEN|cannot open/i);
    } finally {
      db.terminate();
    }
  });
});

describe('robustness: migration loader ESM handling', () => {
  it('loadMigrationsSync rejects .mjs with a clear message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-mjs-'));
    try {
      writeFileSync(join(dir, '001_init.mjs'), 'export default { name: "x", up: "SELECT 1" };\n');
      assert.throws(() => loadMigrationsSync(dir), /Cannot load .mjs migration synchronously/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadMigrationsSync maps require()-of-ESM errors; loadMigrations handles the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-esm-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(join(dir, '001_tla.js'), 'await null;\nexport default { name: "tla", up: "CREATE TABLE tla(id)" };\n');
      assert.throws(() => loadMigrationsSync(dir), /Cannot load ESM migration "001_tla.js" synchronously/);
      const loaded = await loadMigrations(dir);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.name, 'tla');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadMigrationsSync propagates a non-ESM require error unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-boom-'));
    try {
      writeFileSync(join(dir, '001_boom.cjs'), 'throw new Error("boom-from-migration");\n');
      assert.throws(() => loadMigrationsSync(dir), /boom-from-migration/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('robustness: connection reopen reapplies PRAGMAs', () => {
  it('open() re-applies a non-default journalMode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-open-'));
    try {
      const db = new Sqlo({ path: join(dir, 'reopen.db'), journalMode: 'WAL', open: false });
      try {
        db.open();
        assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
        db.exec('CREATE TABLE t(id INTEGER)');
        db.close();
        db.open();
        assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('robustness: failure injection', () => {
  it('surfaces a corrupt database file as a clear error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-corrupt-'));
    try {
      const path = join(dir, 'corrupt.db');
      writeFileSync(path, Buffer.from('this is definitely not a sqlite database file'));
      const db = new Sqlo({ path });
      try {
        assert.throws(
          () => db.all('SELECT * FROM sqlite_master'),
          (err: unknown) => /not a database|NOTADB/i.test((err as Error).message),
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces a write to a read-only database', { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlo-readonly-'));
    try {
      const path = join(dir, 'ro.db');
      const seed = new Sqlo({ path });
      seed.exec('CREATE TABLE t(id INTEGER)');
      seed.close();
      chmodSync(path, 0o444);
      try {
        const db = new Sqlo({ path });
        try {
          assert.throws(() => db.run('INSERT INTO t VALUES (?)', 1), /readonly|read-only|READONLY/i);
        } finally {
          db.close();
        }
      } finally {
        chmodSync(path, 0o644);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Deterministic PRNG so any fuzz failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TICK = String.fromCharCode(96);
const FRAGMENTS = [';', '--', '/*', '*/', '"', "'", BACKSLASH, NUL, LF, CR, '(', ')', '[', ']', TICK, '%', '_', '$', '.', ',', ' ', 'DROP', 'TABLE', 'OR 1=1'];
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomToken(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += rand() < 0.5 ? CHARS[Math.floor(rand() * CHARS.length)] : FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
  }
  return out;
}

describe('robustness: security fuzz', () => {
  it('columnDDL never lets a fuzzed column type inject SQL', () => {
    const rand = mulberry32(0x5eed);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const type = randomToken(rand, 12);
      let ddl: string;
      try {
        ddl = columnDDL({ name: 'c', type } as never);
      } catch {
        continue;
      }
      accepted++;
      assert.ok(!ddl.includes(';'), 'statement terminator injected by type ' + JSON.stringify(type) + ': ' + ddl);
      assert.ok(!ddl.includes('--') && !ddl.includes('/*'), 'comment injected by type ' + JSON.stringify(type) + ': ' + ddl);
    }
    assert.ok(accepted > 0, 'fuzz produced no accepted type - the path was not exercised');
  });

  it('quoteIdent round-trips every accepted identifier (no breakout)', () => {
    const rand = mulberry32(0xc0de);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const name = randomToken(rand, 10);
      let quoted: string;
      try {
        quoted = quoteIdent(name);
      } catch {
        continue;
      }
      accepted++;
      const parts = quoted.split('.').map((p) => p.slice(1, -1).replace(/""/g, '"'));
      assert.equal(parts.join('.'), name);
    }
    assert.ok(accepted > 0, 'fuzz produced no accepted identifier - the path was not exercised');
  });

  it('the query builder never embeds a fuzzed WHERE value', () => {
    const db = new Sqlo({ path: ':memory:' });
    try {
      const t = db.define({
        name: 'fuzz',
        columns: {
          id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
          v: { type: 'TEXT' },
        },
      });
      t.sync();
      const rand = mulberry32(0xbeef);
      const NASTY = ["'; DROP TABLE fuzz;--", '1) OR 1=1 --', '/* comment */', 'a"b', "O'Brien", 'x;y', NUL];
      for (let i = 0; i < 4000; i++) {
        const pick = rand();
        let value: unknown;
        if (pick < 0.6) value = NASTY[Math.floor(rand() * NASTY.length)];
        else if (pick < 0.75) value = Math.floor((rand() - 0.5) * 1e9);
        else if (pick < 0.85) value = { gte: Math.floor(rand() * 100) };
        else value = null;
        let built: { sql: string; params: unknown[] };
        try {
          built = t.query().where({ v: value } as never).toSql();
        } catch {
          continue;
        }
        if (typeof value === 'string') {
          assert.ok(built.sql.includes('?'), 'scalar string was not parameterized: ' + built.sql);
          assert.ok(!built.sql.includes(value), 'raw WHERE value was embedded: ' + built.sql);
        }
      }
    } finally {
      db.close();
    }
  });
});

/**
 * Deterministically exercise the in-transaction re-check: a separate
 * connection holds BEGIN IMMEDIATE and commits a version row for the pending
 * migration while the migrator is blocked on the write lock. Unlike the
 * multi-process test, the losing migrate() runs in this process, so the
 * re-check branch is counted by coverage.
 */
function writeLockHolder(dir: string): string {
  const file = join(dir, 'holder.mjs');
  const sql = 'INSERT INTO _sqlo_migrations(name, applied_at) VALUES (?, ?)';
  writeFileSync(file, [
    "import { writeFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const db = new DatabaseSync(process.argv[2]);',
    'db.exec("PRAGMA busy_timeout = 5000");',
    'db.exec("BEGIN IMMEDIATE");',
    'db.prepare(' + JSON.stringify(sql) + ').run(...JSON.parse(process.argv[4]));',
    'writeFileSync(process.argv[3], "ready");',
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);',
    'db.exec("COMMIT");',
    'db.close();',
  ].join('\n'));
  return file;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      readFileSync(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error('timed out waiting for ' + path);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('robustness: concurrent migrator re-check', () => {
  for (const mode of ['sync', 'async'] as const) {
    it(mode + ' migrate: skips a migration another connection applied mid-flight', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlo-recheck-' + mode + '-'));
      try {
        const dbPath = join(dir, 'recheck.db');
        const seed = new Sqlo({ path: dbPath });
        seed.migrate([]);
        seed.close();

        const readyPath = join(dir, 'ready');
        const holder = spawn(
          process.execPath,
          [writeLockHolder(dir), dbPath, readyPath, JSON.stringify(['race_1', '2020-01-01T00:00:00.000Z'])],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let holderErr = '';
        holder.stderr.on('data', (d) => { holderErr += String(d); });
        const holderDone = new Promise<void>((resolve) => { holder.on('close', () => resolve()); });
        try {
          await waitForFile(readyPath, 10_000);
          const migrations = [{ name: 'race_1', up: 'CREATE TABLE race_1(id INTEGER PRIMARY KEY)' }];
          if (mode === 'sync') {
            let rechecked = false;
            const db = new Sqlo({
              path: dbPath,
              onLog: (e) => { if (String(e.message).includes('already applied by another process')) rechecked = true; },
            });
            try {
              assert.deepEqual(db.migrate(migrations), []);
              assert.equal(rechecked, true, 'the in-transaction re-check must have run');
              assert.equal(db.tableExists('race_1'), false);
            } finally {
              db.close();
            }
          } else {
            const db = new AsyncSqlo(dbPath);
            try {
              assert.deepEqual(await db.migrate(migrations), []);
              const found = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'race_1'");
              assert.equal(found?.n, 0);
            } finally {
              await db.close();
            }
          }
        } finally {
          await holderDone;
        }
        assert.equal(holderErr.includes('SQLITE_BUSY'), false, holderErr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('robustness: WHERE value diagnostics', () => {
  it('names unsupported object values in the error', () => {
    const db = new Sqlo({ path: ':memory:' });
    try {
      const t = db.define({
        name: 'diag',
        columns: { id: { type: 'INTEGER', primaryKey: true }, v: { type: 'TEXT' } },
      });
      t.sync();
      assert.throws(() => t.query().where({ v: new Date() } as never).toSql(), /a Date/);
      assert.throws(() => t.query().where({ v: new Map() } as never).toSql(), /a Map/);
      assert.throws(() => t.query().where({ v: new Set() } as never).toSql(), /a Set/);
    } finally {
      db.close();
    }
  });
});
