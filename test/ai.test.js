import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAiReport } from '../src/report/ai.js';
import { parseCliArgs } from '../src/config.js';

test('AI Config: parses --ai and --llm flags correctly', () => {
  const opt1 = parseCliArgs(['--ai', 'bench/run.js']);
  assert.equal(opt1.ai, true);
  assert.deepEqual(opt1.command, ['bench/run.js']);

  const opt2 = parseCliArgs(['--llm', 'bench/run.js']);
  assert.equal(opt2.ai, true);
  assert.deepEqual(opt2.command, ['bench/run.js']);
});

test('AI Report: renders empty summary gracefully', () => {
  const empty = {
    durationMs: 0,
    filesObserved: 0,
    functionsDiscovered: 0,
    functionsExecuted: 0,
    functionsNeverExecuted: 0,
    totalFunctionCalls: 0,
    runtimeReach: { executedPercent: 0, notExecutedPercent: 0 },
    files: [],
    functions: [],
    edges: []
  };

  const output = renderAiReport(empty);
  assert.ok(output.includes('# Softscope AI Profile'));
  assert.ok(output.includes('**Wall Duration**: 0.00ms'));
  assert.ok(output.includes('**Total Function Calls**: 0'));
  assert.ok(output.includes('No critical performance bottlenecks or dead code detected.'));
});

test('AI Report: generates diagnosis and actionable directives for hotspots', () => {
  const summary = {
    durationMs: 2500,
    filesObserved: 2,
    functionsDiscovered: 4,
    functionsExecuted: 3,
    functionsNeverExecuted: 1,
    totalFunctionCalls: 100005,
    runtimeReach: { executedPercent: 75.0, notExecutedPercent: 25.0 },
    functions: [
      {
        id: 1,
        file: 'src/heavy.js',
        name: 'heavyLoop',
        line: 10,
        column: 1,
        calls: 1,
        totalDurationMs: 2000,
        selfDurationMs: 1800,
        minDurationMs: 2000,
        maxDurationMs: 2000,
        errors: 0
      },
      {
        id: 2,
        file: 'src/math.js',
        name: 'microAdd',
        line: 5,
        column: 8,
        calls: 100000,
        totalDurationMs: 200,
        selfDurationMs: 200,
        minDurationMs: 0.001,
        maxDurationMs: 5.0,
        errors: 0
      },
      {
        id: 3,
        file: 'src/api.js',
        name: 'flakyNetwork',
        line: 20,
        column: 14,
        calls: 4,
        totalDurationMs: 100,
        selfDurationMs: 50,
        minDurationMs: 10,
        maxDurationMs: 50,
        errors: 2
      },
      {
        id: 4,
        file: 'src/dead.js',
        name: 'neverExecutedWorker',
        line: 40,
        column: 8,
        calls: 0,
        totalDurationMs: 0,
        selfDurationMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
        errors: 0
      }
    ],
    edges: [
      { callerName: 'heavyLoop', calleeName: 'microAdd', calls: 100000 }
    ],
    files: []
  };

  const output = renderAiReport(summary, { targetCommand: 'node bench/test.js' });

  // 1. Header checks
  assert.ok(output.includes('# Softscope AI Profile'));
  assert.ok(output.includes('**Target**: `node bench/test.js`'));
  assert.ok(output.includes('Discovered: 4'));
  assert.ok(output.includes('Executed: 3 (75.0%)'));

  // 2. Critical Bottlenecks & Diagnosis
  assert.ok(output.includes('## Critical Bottlenecks (Top Self-Time)'));
  assert.ok(output.includes('`heavyLoop`'));
  assert.ok(output.includes('Dominates application execution'));
  assert.ok(output.includes('`microAdd`'));
  assert.ok(output.includes('Extremely high frequency'));

  // 3. High-Frequency Invocations
  assert.ok(output.includes('## High-Frequency Invocations'));
  assert.ok(output.includes('100,000 calls'));

  // 4. Hot Call Paths
  assert.ok(output.includes('## Hot Call Paths'));
  assert.ok(output.includes('`heavyLoop` -> `microAdd` (x100,000)'));

  // 5. Untouched Code
  assert.ok(output.includes('## Untouched Code (0 runtime calls)'));
  assert.ok(output.includes('`neverExecutedWorker`'));

  // 6. Actionable Directives
  assert.ok(output.includes('## Actionable Directives for AI Agent'));
  assert.ok(output.includes('Prioritize optimizing `src/heavy.js:10:1` (`heavyLoop`)'));
  assert.ok(output.includes('Investigate inlining or memoizing `src/math.js:5:8` (`microAdd`)'));
  assert.ok(output.includes('Check why 1 function(s) were never executed'));
  assert.ok(output.includes('Address runtime errors in: `flakyNetwork` (2 errors)'));
});
