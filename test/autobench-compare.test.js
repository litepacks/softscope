import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAutoBenchDelta,
  renderAutoBenchCompareTerminalReport,
  renderAutoBenchCompareMarkdownReport,
  renderAutoBenchCompareAiReport,
  renderAutoBenchCompareJsonReport
} from '../src/autobench/compare.js';

test('Auto-Bench Compare: computeAutoBenchDelta accurately computes deltas and status', () => {
  const baseline = {
    type: 'softscope-autobench',
    targetFile: 'src/math.js',
    iterations: 1000,
    totalCrashes: 1,
    totalCliffs: 1,
    functions: [
      {
        name: 'add',
        status: 'ok',
        opsPerSec: 1000000,
        avgMs: 0.001,
        minMs: 0.0005,
        maxMs: 0.01,
        crashes: [],
        cliffs: []
      },
      {
        name: 'formatName',
        status: 'ok',
        opsPerSec: 500000,
        avgMs: 0.002,
        minMs: 0.001,
        maxMs: 0.5,
        crashes: [{ seed: [null], error: 'Cannot read properties of null' }],
        cliffs: []
      },
      {
        name: 'processTokens',
        status: 'ok',
        opsPerSec: 200000,
        avgMs: 0.005,
        minMs: 0.001,
        maxMs: 10.0,
        crashes: [],
        cliffs: [{ seed: ['abc'], avgMs: 0.005, durationMs: 0.8, factor: 160 }]
      }
    ]
  };

  const current = {
    type: 'softscope-autobench',
    targetFile: 'src/math.js',
    iterations: 1000,
    totalCrashes: 0,
    totalCliffs: 0,
    functions: [
      {
        name: 'add',
        status: 'ok',
        opsPerSec: 1500000, // +50%
        avgMs: 0.00067,
        minMs: 0.0004,
        maxMs: 0.008,
        crashes: [],
        cliffs: []
      },
      {
        name: 'formatName',
        status: 'ok',
        opsPerSec: 520000,
        avgMs: 0.0019,
        minMs: 0.001,
        maxMs: 0.02,
        crashes: [], // Crash fixed!
        cliffs: []
      },
      {
        name: 'processTokens',
        status: 'ok',
        opsPerSec: 120000, // -40% (regression)
        avgMs: 0.0083,
        minMs: 0.002,
        maxMs: 0.05,
        crashes: [],
        cliffs: [] // Cliff fixed!
      }
    ]
  };

  const delta = computeAutoBenchDelta(baseline, current, { threshold: 10 });

  assert.equal(delta.overview.totalCrashesBase, 1);
  assert.equal(delta.overview.totalCrashesCurr, 0);
  assert.equal(delta.overview.totalCrashesDiff, -1);

  assert.equal(delta.overview.totalCliffsBase, 1);
  assert.equal(delta.overview.totalCliffsCurr, 0);
  assert.equal(delta.overview.totalCliffsDiff, -1);

  // 'add' should be improved (+50% ops)
  const addComp = delta.comparisons.find(c => c.name === 'add');
  assert.ok(addComp);
  assert.equal(addComp.status, 'improved');
  assert.equal(addComp.diff.opsPercent, 50);

  // 'formatName' should be improved (crash fixed)
  const formatComp = delta.comparisons.find(c => c.name === 'formatName');
  assert.ok(formatComp);
  assert.equal(formatComp.status, 'improved');
  assert.equal(formatComp.diff.crashes, -1);

  // 'processTokens' should be regressed (ops dropped 40%)
  const tokensComp = delta.comparisons.find(c => c.name === 'processTokens');
  assert.ok(tokensComp);
  assert.equal(tokensComp.status, 'regressed');
  assert.ok(tokensComp.diff.opsPercent < -10);

  assert.equal(delta.thresholdBreached, true);
});

test('Auto-Bench Compare: renders terminal, markdown, AI, and JSON delta reports', () => {
  const baseline = {
    type: 'softscope-autobench',
    targetFile: 'src/math.js',
    functions: [
      { name: 'add', status: 'ok', opsPerSec: 1000000, avgMs: 0.001, maxMs: 0.01, crashes: [], cliffs: [] }
    ]
  };
  const current = {
    type: 'softscope-autobench',
    targetFile: 'src/math.js',
    functions: [
      { name: 'add', status: 'ok', opsPerSec: 1250000, avgMs: 0.0008, maxMs: 0.009, crashes: [], cliffs: [] }
    ]
  };

  const delta = computeAutoBenchDelta(baseline, current, { threshold: 10 });

  const termReport = renderAutoBenchCompareTerminalReport(delta);
  assert.ok(termReport.includes('Auto-Bench Performance Comparison'));
  assert.ok(termReport.includes('add'));
  assert.ok(termReport.includes('Improved'));

  const mdReport = renderAutoBenchCompareMarkdownReport(delta);
  assert.ok(mdReport.includes('## Softscope Auto-Bench Performance Comparison'));
  assert.ok(mdReport.includes('| `add` |'));

  const aiReport = renderAutoBenchCompareAiReport(delta);
  assert.ok(aiReport.includes('[SOFTSCOPE_AUTOBENCH_COMPARE_V1]'));
  assert.ok(aiReport.includes('TOTAL_OPS_DELTA_PERCENT'));

  const jsonReport = renderAutoBenchCompareJsonReport(delta);
  const parsed = JSON.parse(jsonReport);
  assert.equal(parsed.type, 'softscope-autobench-compare');
  assert.equal(parsed.comparisons.length, 1);
});
