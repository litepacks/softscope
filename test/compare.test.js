import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../src/config.js';
import {
  computeDelta,
  renderCompareTerminalReport,
  renderCompareMarkdownReport,
  renderCompareAiReport,
  renderCompareJsonReport
} from '../src/report/compare.js';

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

  return execFileAsync(process.execPath, [SOFTSCOPE_BIN, ...args], {
    env: cleanEnv,
    ...opts
  });
}

test('Compare Config: parses --save-baseline, --compare, --baseline, and --fail-on-regression', () => {
  const opts = parseCliArgs([
    'app.js',
    '--save-baseline',
    'base.json',
    '--compare',
    'prev.json',
    '--fail-on-regression',
    '15'
  ]);
  assert.ok(opts.saveBaseline.endsWith('base.json'));
  assert.ok(opts.compare.endsWith('prev.json'));
  assert.equal(opts.failOnRegression, 15);

  const opts2 = parseCliArgs([
    '--baseline=old.json',
    '--fail-on-regression=20',
    'app.js'
  ]);
  assert.ok(opts2.compare.endsWith('old.json'));
  assert.equal(opts2.failOnRegression, 20);
});

test('Compare Delta: accurately computes improvements, regressions, and reach shift', () => {
  const baseline = {
    version: 1,
    runtime: {
      durationMs: 100,
      filesObserved: 1,
      functionsDiscovered: 4,
      functionsExecuted: 3,
      functionCalls: 500,
      runtimeReach: { executedPercent: 75, notExecutedPercent: 25 }
    },
    functions: [
      {
        file: 'src/math.js',
        name: 'fastAdd',
        line: 10,
        column: 1,
        calls: 200,
        selfDurationMs: 40,
        totalDurationMs: 40
      },
      {
        file: 'src/math.js',
        name: 'slowMultiply',
        line: 20,
        column: 1,
        calls: 100,
        selfDurationMs: 30,
        totalDurationMs: 50
      },
      {
        file: 'src/math.js',
        name: 'oldHelper',
        line: 30,
        column: 1,
        calls: 50,
        selfDurationMs: 10,
        totalDurationMs: 10
      }
    ]
  };

  const current = {
    version: 1,
    runtime: {
      durationMs: 80,
      filesObserved: 1,
      functionsDiscovered: 4,
      functionsExecuted: 3,
      functionCalls: 450,
      runtimeReach: { executedPercent: 75, notExecutedPercent: 25 }
    },
    functions: [
      // fastAdd improved (40ms -> 20ms: -50%)
      {
        file: 'src/math.js',
        name: 'fastAdd',
        line: 10,
        column: 1,
        calls: 200,
        selfDurationMs: 20,
        totalDurationMs: 20
      },
      // slowMultiply regressed (30ms -> 45ms: +50%)
      {
        file: 'src/math.js',
        name: 'slowMultiply',
        line: 25, // Note: line moved from 20 to 25!
        column: 1,
        calls: 100,
        selfDurationMs: 45,
        totalDurationMs: 65
      },
      // newHelper added
      {
        file: 'src/math.js',
        name: 'newHelper',
        line: 40,
        column: 1,
        calls: 50,
        selfDurationMs: 5,
        totalDurationMs: 5
      }
    ]
  };

  const delta = computeDelta(baseline, current, { projectRoot: process.cwd(), threshold: 10 });

  assert.equal(delta.overview.durationDiffMs, -20);
  assert.equal(delta.overview.durationPercent, -20);
  assert.equal(delta.overview.callsDiff, -50);

  // Check regressions
  assert.equal(delta.regressions.length, 1);
  assert.equal(delta.regressions[0].name, 'slowMultiply');
  assert.equal(delta.regressions[0].diff.selfMs, 15);
  assert.equal(delta.regressions[0].diff.selfPercent, 50);

  // Check improvements
  assert.equal(delta.improvements.length, 1);
  assert.equal(delta.improvements[0].name, 'fastAdd');
  assert.equal(delta.improvements[0].diff.selfMs, -20);
  assert.equal(delta.improvements[0].diff.selfPercent, -50);

  // Check added & removed
  assert.equal(delta.added.length, 1);
  assert.equal(delta.added[0].name, 'newHelper');
  assert.equal(delta.removed.length, 1);
  assert.equal(delta.removed[0].name, 'oldHelper');

  // Check threshold breached
  assert.equal(delta.thresholdBreached, true);
});

test('Compare Reporters: renders Terminal, Markdown, AI, and JSON outputs', () => {
  const baseline = {
    runtime: { durationMs: 100, functionCalls: 100, runtimeReach: { executedPercent: 80 } },
    functions: [
      { file: 'app.js', name: 'processData', line: 10, column: 1, calls: 50, selfDurationMs: 30, totalDurationMs: 30 }
    ]
  };
  const current = {
    runtime: { durationMs: 70, functionCalls: 100, runtimeReach: { executedPercent: 80 } },
    functions: [
      { file: 'app.js', name: 'processData', line: 10, column: 1, calls: 50, selfDurationMs: 15, totalDurationMs: 15 }
    ]
  };

  const delta = computeDelta(baseline, current, { threshold: 10 });

  const terminalStr = renderCompareTerminalReport(delta);
  assert.ok(terminalStr.includes('Performance Comparison Overview'));
  assert.ok(terminalStr.includes('Improvements (Self-Time Faster)'));
  assert.ok(terminalStr.includes('processData'));

  const mdStr = renderCompareMarkdownReport(delta);
  assert.ok(mdStr.includes('# Softscope Performance Comparison'));
  assert.ok(mdStr.includes('Executive Summary'));
  assert.ok(mdStr.includes('Improvements (1)'));

  const aiStr = renderCompareAiReport(delta);
  assert.ok(aiStr.includes('# Softscope AI Performance Delta Profile'));
  assert.ok(aiStr.includes('Improvements (>5% Self-Time Speedup)'));

  const jsonStr = renderCompareJsonReport(delta);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.type, 'softscope-compare');
  assert.equal(parsed.improvements.length, 1);
});

test('CLI: --save-baseline saves valid baseline JSON and --compare compares against it', async () => {
  const tmpBase = path.join(os.tmpdir(), `softscope-test-base-${Date.now()}.json`);
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');

  try {
    // 1. Run and save baseline
    const { stdout: stdoutSave } = await runCli([file, '--save-baseline', tmpBase]);
    assert.ok(fs.existsSync(tmpBase), 'Baseline JSON file should be created');
    const baseContent = JSON.parse(fs.readFileSync(tmpBase, 'utf-8'));
    assert.equal(baseContent.version, 1);
    assert.ok(baseContent.functions.length > 0);

    // 2. Run and compare against saved baseline
    const { stdout: stdoutCompare } = await runCli([file, '--compare', tmpBase]);
    assert.ok(stdoutCompare.includes('Performance Comparison Overview'));
    assert.ok(stdoutCompare.includes('Baseline'));
    assert.ok(stdoutCompare.includes('Current'));

    // 3. Run and compare with --md flag
    const { stdout: stdoutMd } = await runCli([file, '--compare', tmpBase, '--md']);
    assert.ok(stdoutMd.includes('# Softscope Performance Comparison'));
    assert.ok(stdoutMd.includes('Executive Summary'));

    // 4. Run and compare with --ai flag
    const { stdout: stdoutAi } = await runCli([file, '--compare', tmpBase, '--ai']);
    assert.ok(stdoutAi.includes('# Softscope AI Performance Delta Profile'));

    // 5. Standalone compare command
    const { stdout: stdoutStandalone } = await runCli(['compare', tmpBase, tmpBase]);
    assert.ok(stdoutStandalone.includes('Performance Comparison Overview'));

  } finally {
    try {
      if (fs.existsSync(tmpBase)) {
        fs.unlinkSync(tmpBase);
      }
    } catch {
      // Ignore
    }
  }
});

test('CLI: --fail-on-regression triggers non-zero exit code when threshold is breached', async () => {
  const tmpBase = path.join(os.tmpdir(), `softscope-reg-base-${Date.now()}.json`);
  const tmpCurr = path.join(os.tmpdir(), `softscope-reg-curr-${Date.now()}.json`);

  try {
    // Baseline with fast execution
    const base = {
      version: 1,
      runtime: { durationMs: 10, functionCalls: 10, runtimeReach: { executedPercent: 100 } },
      functions: [
        { file: 'test.js', name: 'compute', line: 1, column: 1, calls: 10, selfDurationMs: 5, totalDurationMs: 5 }
      ]
    };
    // Current with severe regression (+300%)
    const curr = {
      version: 1,
      runtime: { durationMs: 40, functionCalls: 10, runtimeReach: { executedPercent: 100 } },
      functions: [
        { file: 'test.js', name: 'compute', line: 1, column: 1, calls: 10, selfDurationMs: 20, totalDurationMs: 20 }
      ]
    };

    fs.writeFileSync(tmpBase, JSON.stringify(base));
    fs.writeFileSync(tmpCurr, JSON.stringify(curr));

    // Standalone compare with threshold 10% should exit with code 1
    let failed = false;
    try {
      await runCli(['compare', tmpBase, tmpCurr, '--fail-on-regression', '10']);
    } catch (err) {
      failed = true;
      assert.equal(err.code, 1);
    }
    assert.equal(failed, true, 'Should exit with code 1 on regression breach');

  } finally {
    try {
      if (fs.existsSync(tmpBase)) fs.unlinkSync(tmpBase);
      if (fs.existsSync(tmpCurr)) fs.unlinkSync(tmpCurr);
    } catch {
      // Ignore
    }
  }
});
