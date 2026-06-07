import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(process.cwd(), 'dist', 'main');

function collectTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...collectTests(path));
    } else if (entry.endsWith('.test.js')) {
      out.push(path);
    }
  }
  return out;
}

const tests = collectTests(root).sort();
if (tests.length === 0) {
  console.error(`No test files found under ${root}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
