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

function runCli(args, opts = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.SOFTSCOPE_SESSION_DIR;
  delete cleanEnv.SOFTSCOPE_CONFIG;
  delete cleanEnv.SOFTSCOPE_IPC_SOCKET;
  delete cleanEnv.SOFTSCOPE_LIVE;
  delete cleanEnv.SOFTSCOPE_CAPTURE_SEEDS;

  return execFileAsync(process.execPath, [CLI_PATH, ...args], {
    env: cleanEnv,
    ...opts
  });
}

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
    const res = await runCli(['test', '--seeds', seedsFile], { cwd: tmpDir });

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

test('Test Bridge: resolves Yarn, Bun, Jest, and native test runners correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-bridge-runners-'));

  try {
    // 1. Yarn runner
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
    const cmdYarn = resolveTestCommand(tmpDir, ['--watch']);
    assert.deepEqual(cmdYarn, ['yarn', 'test', '--watch']);
    fs.unlinkSync(path.join(tmpDir, 'yarn.lock'));

    // 2. Bun runner
    fs.writeFileSync(path.join(tmpDir, 'bun.lockb'), '');
    const cmdBun = resolveTestCommand(tmpDir, ['test/unit.test.js']);
    assert.deepEqual(cmdBun, ['bun', 'test', 'test/unit.test.js']);
    fs.unlinkSync(path.join(tmpDir, 'bun.lockb'));

    // 3. Jest fallback
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29.0.0' } }));
    const cmdJest = resolveTestCommand(tmpDir, ['--runInBand']);
    assert.deepEqual(cmdJest, ['npx', 'jest', '--runInBand']);

    // 4. Native node --test fallback when test directory exists
    fs.unlinkSync(path.join(tmpDir, 'package.json'));
    fs.mkdirSync(path.join(tmpDir, 'test'));
    const cmdNative = resolveTestCommand(tmpDir);
    assert.deepEqual(cmdNative, ['node', '--test', 'test/**/*.test.js']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: softscope test respects --no-capture and does not write seeds file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-nocapture-'));
  const seedsFile = path.join(tmpDir, 'should-not-exist.json');

  const srcFile = path.join(tmpDir, 'index.js');
  fs.writeFileSync(srcFile, 'function foo() { return 42; }\nfoo();\n', 'utf-8');

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'nocapture-project',
    scripts: { test: 'node index.js' }
  }), 'utf-8');

  try {
    await runCli(['test', '--no-capture', '--seeds', seedsFile], { cwd: tmpDir });

    assert.equal(fs.existsSync(seedsFile), false, 'Seeds file should NOT be written when --no-capture is passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
