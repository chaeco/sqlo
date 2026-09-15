#!/usr/bin/env node
// Cross-platform recursive delete: `rm -rf` is not available on Windows,
// so the build pipeline calls this instead.
import { rmSync } from 'node:fs';

for (const target of process.argv.slice(2)) {
  rmSync(target, { recursive: true, force: true });
}
