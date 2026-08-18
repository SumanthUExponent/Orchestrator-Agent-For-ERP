/**
 * Test runner.
 *
 * `node --test tests/` scans a directory on Node 18 and 20, but Node 22 treats the
 * argument as a path to load and fails with "Cannot find module .../tests". Glob
 * patterns are not available before Node 21, and a bare `tests/*.test.mjs` in an npm
 * script depends on the shell expanding it — which cmd.exe does not do.
 *
 * So the file list is built here, where none of that matters, and passed explicitly.
 * Enumerating rather than hardcoding means a new suite is picked up by existing it,
 * which is the only way a test file cannot be silently left out of CI.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tests');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(dir, f));

if (!files.length) {
  console.error('no test files found in tests/');
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(r.status === null ? 1 : r.status);
