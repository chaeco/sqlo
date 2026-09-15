#!/usr/bin/env node
// Micro-benchmarks for @chaeco/sqlo.
//
//   npm run build && npm run bench
//
// Not part of CI: numbers are machine-dependent and only useful as a local
// baseline. Override the iteration count with BENCH_N=... .
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sqlo } from '../dist/index.js';

const N = Number(process.env.BENCH_N ?? 20000);

function bench(label, iterations, fn) {
  const started = performance.now();
  fn();
  const ms = performance.now() - started;
  const ops = Math.round(iterations / (ms / 1000));
  console.log(
    label.padEnd(30) +
      ms.toFixed(1).padStart(9) + ' ms' +
      String(ops).padStart(12) + ' ops/s',
  );
}

const dir = mkdtempSync(join(tmpdir(), 'sqlo-bench-'));
const db = new Sqlo({ path: join(dir, 'bench.db'), journalMode: 'WAL' });
const m = db.define({
  name: 'bench',
  columns: {
    id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
    name: { type: 'TEXT' },
    score: { type: 'INTEGER' },
  },
});
m.sync();

console.log('@chaeco/sqlo benchmark (' + N.toLocaleString() + ' iterations)');

bench('build SELECT toSql()', N, () => {
  for (let i = 0; i < N; i++) {
    m.query().where({ score: { gte: i } }).orderBy('id', 'ASC').limit(10).toSql();
  }
});

bench('insert (one transaction)', N, () => {
  db.transaction(() => {
    for (let i = 0; i < N; i++) m.insert({ name: 'user-' + i, score: i });
  });
});

bench('insertMany', N, () => {
  const rows = Array.from({ length: N }, (_, i) => ({ name: 'batch-' + i, score: i }));
  m.insertMany(rows);
});

bench('SELECT 200 rows', 200, () => {
  for (let i = 0; i < 200; i++) m.query().where({ score: { gte: 0 } }).limit(200).all();
});

console.log('rows in table: ' + m.count());
db.close();
rmSync(dir, { recursive: true, force: true });
