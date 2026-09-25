import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../src/config.js';
import { isWatchIgnored, createFileWatcher } from '../src/watch.js';
import { promptFunctionPicker } from '../src/picker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');

test('Watch & Pick Config: parses --watch, -w, --pick, -i flags correctly', () => {
  const opt1 = parseCliArgs(['auto-bench', 'src/math.js', '--watch']);
  assert.equal(opt1.watch, true);

  const opt2 = parseCliArgs(['auto-bench', 'src/math.js', '-w']);
  assert.equal(opt2.watch, true);

  const opt3 = parseCliArgs(['auto-bench', 'src/math.js', '--pick']);
  assert.equal(opt3.pick, true);

  const opt4 = parseCliArgs(['auto-bench', 'src/math.js', '-i']);
  assert.equal(opt4.pick, true);

  const opt5 = parseCliArgs(['auto-bench', 'src/math.js', '--interactive']);
  assert.equal(opt5.pick, true);
});

test('Watch: isWatchIgnored filters node_modules, git, and temporary runner files', () => {
  assert.equal(isWatchIgnored('/project/node_modules/pkg/index.js'), true);
  assert.equal(isWatchIgnored('/project/.git/HEAD'), true);
  assert.equal(isWatchIgnored('/project/.softscope/seeds.json'), true);
  assert.equal(isWatchIgnored('/tmp/softscope-autobench-runner-1234.mjs'), true);
  assert.equal(isWatchIgnored('/tmp/softscope-autobench-results-1234.json'), true);
  assert.equal(isWatchIgnored('/project/dist/bundle.js'), true);

  assert.equal(isWatchIgnored('/project/src/index.ts'), false);
  assert.equal(isWatchIgnored('/project/packages/core/src/tokenizer.js'), false);
});

test('Watch: createFileWatcher triggers debounced callback on file changes', async () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-watch-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const testFile = path.join(tmpDir, 'test.js');
  fs.writeFileSync(testFile, 'export function hello() {}', 'utf-8');

  try {
    let changed = null;
    const watcher = createFileWatcher({
      watchPaths: [testFile, tmpDir],
      debounceMs: 50,
      onChange: (fullPath) => {
        changed = fullPath;
      }
    });

    // Modify file
    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(testFile, 'export function hello2() {}', 'utf-8');

    // Wait for debounce
    await new Promise(r => setTimeout(r, 200));

    assert.ok(changed, 'Watcher should have triggered onChange');
    assert.equal(path.resolve(changed), path.resolve(testFile));

    watcher.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test('Picker: promptFunctionPicker returns all functions gracefully in non-TTY mode', async () => {
  const fns = [
    { name: 'add', exportName: 'add', params: [] },
    { name: 'multiply', exportName: 'multiply', params: [] }
  ];

  // In non-TTY testing environment
  const result = await promptFunctionPicker(fns);
  assert.deepEqual(result, fns);
});

test('CLI: auto-bench --watch detects file change and re-runs', async () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-cli-watch-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const targetFile = path.join(tmpDir, 'sample.js');
  fs.writeFileSync(targetFile, `
    export function compute(x = 10) {
      return x * 2;
    }
  `, 'utf-8');

  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;

  const child = spawn(process.execPath, [SOFTSCOPE_BIN, 'auto-bench', targetFile, '--watch', '--iterations', '50'], {
    env: cleanEnv,
    cwd: tmpDir,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', d => {
    output += d.toString('utf-8');
  });

  try {
    // 1. Wait for initial run to complete
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (output.includes('compute') && output.includes('Watching for changes')) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(`Timeout waiting for initial watch run. Output so far: ${output}`));
      }, 8000);
    });

    assert.ok(output.includes('compute'));

    // 2. Modify targetFile
    output = '';
    await new Promise(r => setTimeout(r, 100));
    fs.appendFileSync(targetFile, '\n// Trigger watch change\n');

    // 3. Wait for re-run
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (output.includes('File changed') || output.includes('compute')) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        reject(new Error(`Timeout waiting for watch re-run. Output so far: ${output}`));
      }, 8000);
    });

    assert.ok(output.includes('File changed') || output.includes('compute'));

  } finally {
    try {
      child.stdin.write('q');
      child.kill('SIGINT');
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

