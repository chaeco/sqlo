#!/usr/bin/env node
// Rewrites compiled test imports: tests import '../src/index.ts' (NodeNext),
// but the published source bundle lives at dist/index.js. Rewrite relative
// specifiers in dist/test/*.js to point at the bundled entry.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = new URL('../dist/test/', import.meta.url)
const rewrite = (text) =>
  text
    .replace(/from "\.\.\/src\/index\.js"/g, 'from "../index.js"')
    .replace(/from '\.\.\/src\/index\.js'/g, "from '../index.js'")

let changed = 0
for (const entry of readdirSync(TEST_DIR)) {
  if (!entry.endsWith('.js')) continue
  const file = join(TEST_DIR.pathname, entry)
  const src = readFileSync(file, 'utf8')
  const next = rewrite(src)
  if (next !== src) {
    writeFileSync(file, next, 'utf8')
    changed++
  }
}
console.log(`rewrite-tests: rewrote imports in ${changed} test file(s)`)
