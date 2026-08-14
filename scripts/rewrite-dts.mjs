// Post-build fix for declaration files.
// rewriteRelativeImportExtensions rewrites .ts -> .js in emitted .js files
// but does NOT touch .d.ts files. Consumers resolve types from the published
// dist/ folder (source .ts files are not shipped), so declaration imports
// must point at the compiled .js files.
// This walks dist/ for .d.ts files and rewrites relative specifiers ending
// in .ts to .js.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full);
    } else if (entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
}
collect(DIST);

let changed = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Relative specifiers: from './x.ts' / from "../y.ts" / from '/a.ts' (unused)
  const next = src.replace(/from\s+(['"])(\.{1,2}\/[^'"]*?\.)ts\1/g, (m, q, p) => `from ${q}${p}js${q}`);
  if (next !== src) {
    writeFileSync(file, next);
    changed++;
  }
}
console.log(`rewrite-dts: fixed ${changed} declaration file(s)`);