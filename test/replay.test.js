import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  loadCrashes,
  saveCrashes,
  recordDiscoveredCrashes,
  generateRegressionTestSuite,
  runReplay
} from '../src/autobench/replay.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function runCli(args, opts = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.SOFTSCOPE_SESSION_DIR;
  delete cleanEnv.SOFTSCOPE_CONFIG;
  delete cleanEnv.SOFTSCOPE_IPC_SOCKET;
  delete cleanEnv.SOFTSCOPE_LIVE;
  delete cleanEnv.SOFTSCOPE_CAPTURE_SEEDS;

  return execFileAsync(process.execPath, [SOFTSCOPE_BIN, ...args], {
    env: cleanEnv,
    ...opts
  });
}

test('Replay Unit: loadCrashes returns empty when file does not exist or is corrupt', () => {
  const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}.json`);
  const res = loadCrashes(nonExistent);
  assert.deepEqual(res.crashes, []);
  assert.equal(res.filePath, path.resolve(process.cwd(), nonExistent));

  const corruptFile = path.join(os.tmpdir(), `corrupt-${Date.now()}.json`);
  fs.writeFileSync(corruptFile, 'not-json', 'utf-8');
  try {
    const corruptRes = loadCrashes(corruptFile);
    assert.deepEqual(corruptRes.crashes, []);
  } finally {
    fs.unlinkSync(corruptFile);
  }
});

test('Replay Unit: saveCrashes and loadCrashes roundtrip preserves structure', () => {
  const tmpFile = path.join(os.tmpdir(), `test-crashes-${Date.now()}.json`);
  const mockCrashes = [
    {
      id: 'src/calc.js:divide:[10, 0]',
      targetFile: '/project/src/calc.js',
      relativePath: 'src/calc.js',
      functionName: 'divide',
      exportName: 'divide',
      args: [10, 0],
      error: 'Division by zero',
      line: 12,
      column: 5,
      status: 'unresolved'
    }
  ];

  try {
    saveCrashes(mockCrashes, tmpFile);
    assert.ok(fs.existsSync(tmpFile));

    const loaded = loadCrashes(tmpFile);
    assert.equal(loaded.crashes.length, 1);
    assert.equal(loaded.crashes[0].functionName, 'divide');
    assert.deepEqual(loaded.crashes[0].args, [10, 0]);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('Replay Unit: recordDiscoveredCrashes merges and deduplicates crashes', () => {
  const tmpFile = path.join(os.tmpdir(), `record-crashes-${Date.now()}.json`);
  const targetFile = '/project/src/parser.js';

  const mockFnResults = [
    {
      name: 'parseInput',
      exportName: 'parseInput',
      crashes: [
        {
          label: 'empty object',
          args: [{}],
          error: 'Unexpected empty object',
          line: 25,
          column: 10
        },
        {
          label: 'empty object duplicate',
          args: [{}],
          error: 'Unexpected empty object',
          line: 25,
          column: 10
        }
      ]
    }
  ];

  try {
    const count = recordDiscoveredCrashes(targetFile, mockFnResults, {
      projectRoot: '/project',
      crashes: tmpFile
    });

    assert.equal(count, 2);
    const { crashes } = loadCrashes(tmpFile, '/project');
    // Deduplicated because exportName + args are identical
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0].functionName, 'parseInput');
    assert.deepEqual(crashes[0].args, [{}]);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('Replay Unit: generateRegressionTestSuite produces executable node:test syntax', () => {
  const crashes = [
    {
      targetFile: '/app/src/math.js',
      functionName: 'add',
      exportName: 'add',
      args: [1, 2]
    },
    {
      targetFile: '/app/src/user.js',
      functionName: 'getUser',
      exportName: 'default',
      args: [null]
    }
  ];

  const code = generateRegressionTestSuite(crashes, '/app');
  assert.ok(code.includes("import test from 'node:test';"));
  assert.ok(code.includes("import assert from 'node:assert/strict';"));
  assert.ok(code.includes('import { add } from "./src/math.js";'));
  assert.ok(code.includes('import defaultExport1 from "./src/user.js";'));
  assert.ok(code.includes('Regression: add(1, 2) handles input without throwing'));
  assert.ok(code.includes('Regression: getUser(null) handles input without throwing'));
  assert.ok(code.includes('assert.doesNotThrow'));
});

test('Replay CLI: softscope replay with no recorded crashes exits 0 with tip', async () => {
  const tmpFile = path.join(os.tmpdir(), `empty-crashes-${Date.now()}.json`);
  const { stdout } = await runCli(['replay', '--crashes', tmpFile]);

  assert.ok(stdout.includes('No recorded crashes found'));
  assert.ok(stdout.includes('softscope auto-bench'));
});

test('Replay CLI: softscope replay --clear unlinks crashes file', async () => {
  const tmpFile = path.join(os.tmpdir(), `clear-crashes-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ version: 1, crashes: [] }), 'utf-8');
  assert.ok(fs.existsSync(tmpFile));

  const { stdout } = await runCli(['replay', '--crashes', tmpFile, '--clear']);
  assert.ok(stdout.includes('Cleared recorded crashes'));
  assert.equal(fs.existsSync(tmpFile), false);
});

test('Replay CLI: auto-bench records crashes and softscope replay reports failures with codeframe', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-test-crash-'));
  const tmpCrashes = path.join(tmpDir, 'crashes.json');
  const mathFixture = path.join(FIXTURES_DIR, 'autobench', 'math.js');

  try {
    // 1. Run auto-bench with custom crashes file
    const { stdout: benchStdout } = await runCli([
      'auto-bench',
      mathFixture,
      '--iterations', '50',
      '--crashes', tmpCrashes
    ]);

    assert.ok(benchStdout.includes('Recorded') && benchStdout.includes('crash(es)'));
    assert.ok(fs.existsSync(tmpCrashes));

    const { crashes } = loadCrashes(tmpCrashes);
    assert.ok(crashes.length >= 1);

    // 2. Run softscope replay expecting exit code 1
    let replayErr = null;
    let replayStdout = '';
    try {
      await runCli(['replay', '--crashes', tmpCrashes]);
    } catch (err) {
      replayErr = err;
      replayStdout = err.stdout || '';
    }

    assert.ok(replayErr, 'Replay should exit with non-zero code on unresolved crashes');
    assert.equal(replayErr.code, 1);
    assert.ok(replayStdout.includes('STILL FAILING:'));
    assert.ok(replayStdout.includes('formatName'));

    // 3. Test --generate-test / --test flag
    const { stdout: testCode } = await runCli(['replay', '--crashes', tmpCrashes, '--test']);
    assert.ok(testCode.includes('import test from \'node:test\';'));
    assert.ok(testCode.includes('assert.doesNotThrow'));
    assert.ok(testCode.includes('formatName'));

    // 4. Test --test with -o / --output
    const suiteOutput = path.join(tmpDir, 'regression.test.mjs');
    await runCli(['replay', '--crashes', tmpCrashes, '--test', '-o', suiteOutput]);
    assert.ok(fs.existsSync(suiteOutput));
    const generatedContent = fs.readFileSync(suiteOutput, 'utf-8');
    assert.ok(generatedContent.includes('Regression: formatName'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Replay CLI: full lifecycle — crash recording, replay failure, bug fix, replay resolution', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-lifecycle-'));
  const tmpTarget = path.join(tmpDir, 'service.js');
  const tmpCrashes = path.join(tmpDir, 'crashes.json');

  // Buggy service: throws on empty object or null
  const buggyCode = `
export function processUser(user = { name: 'admin' }) {
  if (!user || !user.name) {
    throw new Error('Invalid user payload');
  }
  return user.name;
}
`;

  // Fixed service: handles empty or null safely
  const fixedCode = `
export function processUser(user = { name: 'admin' }) {
  if (!user || !user.name) {
    return 'anonymous';
  }
  return user.name;
}
`;

  try {
    fs.writeFileSync(tmpTarget, buggyCode, 'utf-8');

    // 1. Discover crashes via auto-bench
    await runCli([
      'auto-bench',
      tmpTarget,
      '--iterations', '50',
      '--crashes', tmpCrashes
    ]);

    assert.ok(fs.existsSync(tmpCrashes));
    const initialCrashes = loadCrashes(tmpCrashes).crashes;
    assert.ok(initialCrashes.length >= 1);

    // 2. Replay fails on buggy code
    try {
      await runCli(['replay', tmpTarget, '--crashes', tmpCrashes]);
      assert.fail('Should have thrown exit code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.ok((err.stdout || '').includes('STILL FAILING'));
    }

    // 3. Fix the bug
    fs.writeFileSync(tmpTarget, fixedCode, 'utf-8');

    // 4. Replay succeeds on fixed code
    const { stdout: resolveStdout } = await runCli(['replay', tmpTarget, '--crashes', tmpCrashes]);
    assert.ok(resolveStdout.includes('RESOLVED 🎉'));
    assert.ok(resolveStdout.includes('All replayed crashes have been resolved'));

    // 5. Verify crashes.json was pruned of resolved cases
    const updatedCrashes = loadCrashes(tmpCrashes).crashes;
    assert.equal(updatedCrashes.length, 0);

    // 6. Next replay run reports 0 crashes
    const { stdout: subsequentStdout } = await runCli(['replay', tmpTarget, '--crashes', tmpCrashes]);
    assert.ok(subsequentStdout.includes('No recorded crashes found'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
