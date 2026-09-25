import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { parseCliArgs } from '../src/config.js';
import { isWatchIgnored, createFileWatcher, setupWatchKeyboard, runWatchLoop } from '../src/watch.js';
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

test('Watch Keyboard: setupWatchKeyboard correctly triggers callbacks for r, p, f, d, c, a, q and ctrl+c', () => {
  const mockStdin = new EventEmitter();
  mockStdin.isTTY = true;
  mockStdin.setRawMode = () => {};
  mockStdin.resume = () => {};
  mockStdin.pause = () => {};

  const events = [];

  const cleanup = setupWatchKeyboard({
    onRerun: () => events.push('rerun'),
    onQuit: () => events.push('quit'),
    onPick: () => events.push('pick'),
    onToggleFuzz: () => events.push('fuzz'),
    onToggleDiff: () => events.push('diff'),
    onToggleChanged: () => events.push('changed'),
    onToggleAll: () => events.push('all'),
    stdin: mockStdin
  });

  mockStdin.emit('keypress', 'r', { name: 'r' });
  mockStdin.emit('keypress', 'p', { name: 'p' });
  mockStdin.emit('keypress', 'f', { name: 'f' });
  mockStdin.emit('keypress', 'd', { name: 'd' });
  mockStdin.emit('keypress', 'c', { name: 'c' });
  mockStdin.emit('keypress', 'a', { name: 'a' });
  mockStdin.emit('keypress', 'q', { name: 'q' });

  assert.deepEqual(events, ['rerun', 'pick', 'fuzz', 'diff', 'changed', 'all', 'quit']);

  // Test Ctrl+C triggers onQuit
  const mockStdinCtrl = new EventEmitter();
  mockStdinCtrl.isTTY = true;
  mockStdinCtrl.setRawMode = () => {};
  mockStdinCtrl.resume = () => {};
  mockStdinCtrl.pause = () => {};

  let ctrlQuit = false;
  setupWatchKeyboard({
    onQuit: () => { ctrlQuit = true; },
    stdin: mockStdinCtrl
  });
  mockStdinCtrl.emit('keypress', '\x03', { name: 'c', ctrl: true });
  assert.equal(ctrlQuit, true);

  // After cleanup, events should not fire
  cleanup();
  mockStdin.emit('keypress', 'r', { name: 'r' });
  assert.equal(events.length, 7);
});

test('Watch Loop: interactive hotkeys toggle state, trigger re-runs, and render live shortcut bar', async () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-hotkey-loop-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, 'test.js');
  fs.writeFileSync(testFile, 'export function sample() {}');
  await new Promise(r => setTimeout(r, 200));

  const mockStdin = new EventEmitter();
  mockStdin.isTTY = true;
  mockStdin.setRawMode = () => {};
  mockStdin.resume = () => {};
  mockStdin.pause = () => {};

  let output = '';
  const mockStdout = {
    isTTY: true,
    write: (chunk) => {
      output += String(chunk);
    }
  };

  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

  const state = {
    fuzz: true,
    diff: false,
    changed: false,
    all: false
  };

  let runCount = 0;

  try {
    const loopPromise = runWatchLoop({
      title: 'auto-bench',
      targetPath: testFile,
      watchPaths: [testFile],
      runTask: async () => {
        runCount++;
      },
      getState: () => state,
      onToggleFuzz: () => {
        state.fuzz = !state.fuzz;
        return `Toggled fuzzing: ${state.fuzz ? 'ON' : 'OFF'}`;
      },
      onToggleDiff: () => {
        state.diff = !state.diff;
        return `Toggled diff: ${state.diff ? 'ON' : 'OFF'}`;
      },
      onToggleChanged: () => {
        state.changed = !state.changed;
        return `Toggled changed: ${state.changed ? 'ON' : 'OFF'}`;
      },
      onToggleAll: () => {
        state.all = !state.all;
        return `Toggled all: ${state.all ? 'ON' : 'OFF'}`;
      },
      onPick: async () => {},
      stdin: mockStdin,
      stdout: mockStdout
    });

    // Wait for initial run
    await new Promise(r => setTimeout(r, 100));
    assert.equal(runCount, 1);
    assert.ok(strip(output).includes('Shortcuts:'));
    assert.ok(strip(output).includes('fuzz (ON)'));
    assert.ok(strip(output).includes('diff (OFF)'));

    // Press 'f' -> toggles fuzzing to OFF
    output = '';
    mockStdin.emit('keypress', 'f', { name: 'f' });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(runCount, 2);
    assert.equal(state.fuzz, false);
    assert.ok(strip(output).includes('fuzz (OFF)'));

    // Press 'd' -> toggles diff to ON
    output = '';
    mockStdin.emit('keypress', 'd', { name: 'd' });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(runCount, 3);
    assert.equal(state.diff, true);
    assert.ok(strip(output).includes('diff (ON)'));

    // Press 'c' -> toggles changed to ON
    output = '';
    mockStdin.emit('keypress', 'c', { name: 'c' });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(runCount, 4);
    assert.equal(state.changed, true);
    assert.ok(strip(output).includes('changed (ON)'));

    // Press 'q' -> quits cleanly
    mockStdin.emit('keypress', 'q', { name: 'q' });
    const exitCode = await loopPromise;
    assert.equal(exitCode, 0);
    assert.ok(output.includes('Watch mode stopped'));
  } finally {
    try {
      mockStdin.emit('keypress', 'q', { name: 'q' });
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


