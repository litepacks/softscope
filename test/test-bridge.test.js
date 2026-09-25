import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTestCommand } from '../src/test-bridge.js';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve('bin/softscope.js');

test('Test Bridge: resolveTestCommand discovers test scripts and runners', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-bridge-'));

  try {
    // 1. package.json with npm test script
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { test: 'node --test' }
    }), 'utf-8');

    const cmdNpm = resolveTestCommand(tmpDir, ['--grep', 'math']);
    assert.deepEqual(cmdNpm, ['npm', 'test', '--', '--grep', 'math']);

    // 2. pnpm project
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '', 'utf-8');
    const cmdPnpm = resolveTestCommand(tmpDir, ['--grep', 'math']);
    assert.deepEqual(cmdPnpm, ['pnpm', 'test', '--', '--grep', 'math']);
    fs.unlinkSync(path.join(tmpDir, 'pnpm-lock.yaml'));

    // 3. Fallback when test script is "no test specified"
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      devDependencies: { vitest: '^1.0.0' }
    }), 'utf-8');

    const cmdVitest = resolveTestCommand(tmpDir, ['src/math.test.ts']);
    assert.deepEqual(cmdVitest, ['npx', 'vitest', 'run', 'src/math.test.ts']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: softscope test executes tests and captures seeds automatically', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-test-e2e-'));
  const seedsFile = path.join(tmpDir, 'captured-seeds.json');

  // Create a minimal project with a source file inside tmpDir
  const srcFile = path.join(tmpDir, 'index.js');
  fs.writeFileSync(srcFile, `
function compute(x, y) {
  return x * 2 + y;
}
compute(10, 5);
compute(20, 15);
`, 'utf-8');

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'sample-project',
    scripts: {
      test: 'node index.js'
    }
  }), 'utf-8');

  try {
    const res = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'test', '--seeds', seedsFile],
      { cwd: tmpDir }
    );

    assert.ok(res.stdout.includes('Running test suite') || res.stdout.includes('Softscope report'));
    assert.ok(fs.existsSync(seedsFile), 'seeds file should be captured');

    const seedsData = JSON.parse(fs.readFileSync(seedsFile, 'utf-8'));
    assert.equal(seedsData.type, 'softscope-seeds');
    assert.ok(Array.isArray(seedsData.seeds));
    assert.ok(seedsData.seeds.length > 0, 'should contain captured function seeds');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
