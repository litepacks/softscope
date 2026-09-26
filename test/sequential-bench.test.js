import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseCliArgs } from '../src/config.js';
import { createProgressReporter, formatCompactOps } from '../src/autobench/progress.js';

test('Progress Reporter: formatCompactOps formats numbers clearly', () => {
  assert.equal(formatCompactOps(0), '0 ops/s');
  assert.equal(formatCompactOps(450), '450 ops/s');
  assert.equal(formatCompactOps(1500), '1.5K ops/s');
  assert.equal(formatCompactOps(21500000), '21.5M ops/s');
  assert.equal(formatCompactOps(3200000000), '3.2B ops/s');
});

test('Progress Reporter: createProgressReporter handles lifecycle and events gracefully', () => {
  const reporter = createProgressReporter({
    total: 3,
    isTTY: false,
    enabled: true,
    sequential: true
  });

  // Test sequential events in non-TTY mode
  reporter.onStart(1, 'firstFn');
  reporter.onDone(1, 'firstFn', {
    opsPerSec: 1500000,
    bytesPerOp: 0,
    status: 'ok',
    cliffs: 0,
    crashes: 0
  });

  reporter.onStart(2, 'hangingFn');
  reporter.onDone(2, 'hangingFn', {
    status: 'timeout',
    timedOut: true
  });

  reporter.onStart(3, 'errorFn');
  reporter.onDone(3, 'errorFn', {
    status: 'error',
    error: 'test error'
  });

  reporter.clear();
  reporter.finish();
});

test('Sequential Auto-Bench Config: parses --sequential, -s, --timeout, and --no-progress flags', () => {
  const parsed1 = parseCliArgs(['auto-bench', 'src/math.js', '--sequential', '--timeout', '2500']);
  assert.equal(parsed1.sequential, true);
  assert.equal(parsed1.timeout, 2500);
  assert.equal(parsed1.progress, true);

  const parsed2 = parseCliArgs(['auto-bench', 'src/math.js', '-s', '--timeout=1200', '--no-progress']);
  assert.equal(parsed2.sequential, true);
  assert.equal(parsed2.timeout, 1200);
  assert.equal(parsed2.progress, false);
});

test('CLI: auto-bench sequential mode isolates functions and terminates infinite loops via timeout watchdog', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-seq-test-'));
  const targetFile = path.join(tmpDir, 'target.mjs');

  // Create a file with 1 fast function, 1 infinite loop function, and 1 fast function
  const code = `
export function fastOne(x = 10) {
  return x * 2;
}

export function infiniteLoop(x = 10) {
  // Infinite loop that would normally freeze the benchmark indefinitely
  const start = Date.now();
  while (true) {
    if (Date.now() - start > 100000) break;
  }
  return 0;
}

export function fastTwo(x = 10) {
  return x + 5;
}
`;
  fs.writeFileSync(targetFile, code, 'utf-8');

  try {
    const cliBin = path.resolve('bin/softscope.js');
    // Run with --sequential, iterations 500 and timeout of 2500ms
    const res = spawnSync(process.execPath, [
      cliBin,
      'auto-bench',
      targetFile,
      '--sequential',
      '--iterations',
      '500',
      '--timeout',
      '2500',
      '--json'
    ], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH }
    });

    assert.equal(res.status, 0, `Expected exit 0 but got ${res.status}: ${res.stderr}`);

    const payload = JSON.parse(res.stdout);
    assert.equal(payload.functions.length, 3);

    const f1 = payload.functions.find(f => f.name === 'fastOne');
    const fHang = payload.functions.find(f => f.name === 'infiniteLoop');
    const f2 = payload.functions.find(f => f.name === 'fastTwo');

    assert.ok(f1);
    assert.equal(f1.status, 'ok');
    assert.ok(f1.opsPerSec > 10000);

    assert.ok(fHang);
    assert.equal(fHang.status, 'timeout');
    assert.match(fHang.error, /timed out/i);

    assert.ok(f2);
    assert.equal(f2.status, 'ok');
    assert.ok(f2.opsPerSec > 10000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: auto-bench sequential mode displays progress and handles terminal output', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-seq-term-'));
  const targetFile = path.join(tmpDir, 'target.mjs');

  const code = `
export function add(a = 1, b = 2) {
  return a + b;
}

export function multiply(a = 2, b = 3) {
  return a * b;
}
`;
  fs.writeFileSync(targetFile, code, 'utf-8');

  try {
    const cliBin = path.resolve('bin/softscope.js');
    const res = spawnSync(process.execPath, [
      cliBin,
      'auto-bench',
      targetFile,
      '-s'
    ], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: { ...process.env, PATH: process.env.PATH }
    });

    assert.equal(res.status, 0);
    // Terminal report should contain table with both functions
    assert.match(res.stdout, /Throughput & Latency/);
    assert.match(res.stdout, /add/);
    assert.match(res.stdout, /multiply/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
