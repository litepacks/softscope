import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  isGitRepository,
  getGitRoot,
  getGitChangedFiles,
  getGitChangedLines,
  filterFunctionsByChangedLines
} from '../src/git.js';
import { parseCliArgs } from '../src/config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');

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

test('Git Config: parses --changed, -c, --staged, --since flags correctly', () => {
  const opts1 = parseCliArgs(['auto-bench', 'src/math.js', '--changed']);
  assert.equal(opts1.changed, true);
  assert.equal(opts1.staged, false);
  assert.equal(opts1.since, null);

  const opts2 = parseCliArgs(['auto-bench', 'src/math.js', '-c']);
  assert.equal(opts2.changed, true);

  const opts3 = parseCliArgs(['auto-bench', 'src/math.js', '--staged']);
  assert.equal(opts3.changed, true);
  assert.equal(opts3.staged, true);

  const opts4 = parseCliArgs(['auto-bench', 'src/math.js', '--since', 'origin/main']);
  assert.equal(opts4.changed, true);
  assert.equal(opts4.since, 'origin/main');

  const opts5 = parseCliArgs(['auto-bench', 'src/math.js', '--since=HEAD~2']);
  assert.equal(opts5.changed, true);
  assert.equal(opts5.since, 'HEAD~2');
});

test('Git Unit: isGitRepository and getGitRoot recognize repository', () => {
  assert.equal(isGitRepository(process.cwd()), true);
  const root = getGitRoot(process.cwd());
  assert.ok(root && fs.existsSync(root));

  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-nongit-'));
  try {
    assert.equal(isGitRepository(nonGitDir), false);
    assert.equal(getGitRoot(nonGitDir), null);
    assert.deepEqual(getGitChangedFiles({ projectRoot: nonGitDir }), []);
    assert.equal(getGitChangedLines('foo.js', { projectRoot: nonGitDir }), null);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test('Git Unit: filterFunctionsByChangedLines accurately filters functions', () => {
  const mockFunctions = [
    { name: 'fn1', line: 10, endLine: 20 },
    { name: 'fn2', line: 30, endLine: 40 },
    { name: 'fn3', line: 50, endLine: 60 }
  ];

  // Untracked file (changedLines === null) -> returns all functions
  const all = filterFunctionsByChangedLines(mockFunctions, null);
  assert.equal(all.length, 3);

  // Line 35 is inside fn2
  const set1 = new Set([35]);
  const res1 = filterFunctionsByChangedLines(mockFunctions, set1);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].name, 'fn2');

  // Line 10 (exact start) of fn1 and line 60 (exact end) of fn3
  const set2 = new Set([10, 60]);
  const res2 = filterFunctionsByChangedLines(mockFunctions, set2);
  assert.equal(res2.length, 2);
  assert.equal(res2[0].name, 'fn1');
  assert.equal(res2[1].name, 'fn3');

  // Line 25 is outside any function
  const set3 = new Set([25]);
  const res3 = filterFunctionsByChangedLines(mockFunctions, set3);
  assert.equal(res3.length, 0);
});

test('Git CLI: end-to-end Git-aware auto-bench filtering in temporary Git repo', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-git-test-'));

  try {
    // 1. Initialize temporary Git repository
    execFileSync('git', ['init'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.name', 'Softscope Tester'], { cwd: tmpRepo });
    execFileSync('git', ['config', 'user.email', 'test@softscope.dev'], { cwd: tmpRepo });

    const targetFile = path.join(tmpRepo, 'calc.js');
    const initialCode = `
export function add(a = 1, b = 2) {
  return a + b;
}

export function subtract(a = 10, b = 5) {
  return a - b;
}

export function multiply(a = 3, b = 4) {
  return a * b;
}
`;
    fs.writeFileSync(targetFile, initialCode, 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpRepo });

    // 2. Run --changed with no changes -> should report no changes and exit 0
    const { stdout: noChangeOut } = await runCli(['auto-bench', targetFile, '--changed'], {
      cwd: tmpRepo
    });
    assert.ok(noChangeOut.includes('No changes detected'));

    // 3. Modify only the subtract function
    const modifiedCode = `
export function add(a = 1, b = 2) {
  return a + b;
}

export function subtract(a = 10, b = 5) {
  // Modified logic
  const diff = a - b;
  return diff;
}

export function multiply(a = 3, b = 4) {
  return a * b;
}
`;
    fs.writeFileSync(targetFile, modifiedCode, 'utf-8');

    // 4. Run --changed -> should benchmark ONLY subtract
    const { stdout: changedOut } = await runCli(['auto-bench', targetFile, '--changed', '--iterations', '50'], {
      cwd: tmpRepo
    });
    assert.ok(changedOut.includes('Git-aware filter: Selected 1 of 3 function(s)'));
    assert.ok(changedOut.includes('subtract'));
    assert.equal(changedOut.includes('add           '), false, 'Should not benchmark add');
    assert.equal(changedOut.includes('multiply      '), false, 'Should not benchmark multiply');

    // 5. Test --staged flag
    execFileSync('git', ['add', 'calc.js'], { cwd: tmpRepo });

    const { stdout: stagedOut } = await runCli(['auto-bench', targetFile, '--staged', '--iterations', '50'], {
      cwd: tmpRepo
    });
    assert.ok(stagedOut.includes('Git-aware filter: Selected 1 of 3 function(s)'));
    assert.ok(stagedOut.includes('subtract'));

    // 6. Test softscope auto-bench --changed (without specifying file)
    const { stdout: autoFileOut } = await runCli(['auto-bench', '--changed', '--iterations', '50'], {
      cwd: tmpRepo
    });
    assert.ok(autoFileOut.includes('Git-aware: auto-targeting changed file calc.js'));
    assert.ok(autoFileOut.includes('subtract'));

    // 7. Commit changes and test --since HEAD~1
    execFileSync('git', ['commit', '-m', 'Update subtract'], { cwd: tmpRepo });

    const { stdout: sinceOut } = await runCli(['auto-bench', targetFile, '--changed', '--since', 'HEAD~1', '--iterations', '50'], {
      cwd: tmpRepo
    });
    assert.ok(sinceOut.includes('Git-aware filter: Selected 1 of 3 function(s)'));
    assert.ok(sinceOut.includes('subtract'));

    // 8. Modify only non-function comments at top of file
    const commentOnlyCode = `// Top header comment modified
` + modifiedCode;
    fs.writeFileSync(targetFile, commentOnlyCode, 'utf-8');

    const { stdout: commentOut } = await runCli(['auto-bench', targetFile, '--changed'], {
      cwd: tmpRepo
    });
    assert.ok(commentOut.includes('Git changes affected non-function lines'));

  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('Git CLI: fails gracefully when running --changed outside of a git repository', async () => {
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-nongit-cli-'));
  const testFile = path.join(nonGitDir, 'app.js');
  fs.writeFileSync(testFile, 'export function test() { return 1; }');

  try {
    let errRes = null;
    try {
      await runCli(['auto-bench', testFile, '--changed'], { cwd: nonGitDir });
    } catch (err) {
      errRes = err;
    }

    assert.ok(errRes);
    assert.equal(errRes.code, 1);
    assert.ok((errRes.stderr || errRes.stdout).includes('not inside a Git repository'));
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

