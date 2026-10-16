import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { softscopeVitest } from '../src/vitest/index.js';
import { SoftscopeTestRunner } from '../src/vitest/runner.js';
import { SoftscopeVitestReporter } from '../src/vitest/reporter.js';
import { compareTestMetrics } from '../src/vitest/compare.js';
import { sessionManager, als, TestSession, fileRegistry, globalStats } from '../src/vitest/context.js';
import { transformSource } from '../src/instrument/transform.js';
import { createFunctionRegistry } from '../src/instrument/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Vitest Plugin: exports plugin factory with proper hooks and metadata', () => {
  const plugin = softscopeVitest({ threshold: 15 });

  assert.equal(plugin.name, 'softscope:vitest');
  assert.equal(plugin.enforce, 'pre');
  assert.equal(typeof plugin.config, 'function');
  assert.equal(typeof plugin.configResolved, 'function');
  assert.equal(typeof plugin.resolveId, 'function');
  assert.equal(typeof plugin.load, 'function');
  assert.equal(typeof plugin.transform, 'function');
});

test('Vitest Plugin: preserves user reporters and setupFiles while configuring runner', () => {
  const customReporter = { onFinished() {} };
  const userConfig = {
    test: {
      reporters: ['verbose', customReporter],
      setupFiles: ['./custom-setup.ts']
    }
  };

  const plugin = softscopeVitest();
  plugin.config(userConfig);

  // Check reporters preserved + softscope reporter appended
  assert.equal(userConfig.test.reporters[0], 'verbose');
  assert.equal(userConfig.test.reporters[1], customReporter);
  assert.ok(userConfig.test.reporters.length >= 3);
  assert.ok(userConfig.test.reporters[2] instanceof SoftscopeVitestReporter);

  // Check runner configured
  assert.ok(userConfig.test.runner.endsWith('runner.js'));

  // Check setupFiles preserved
  assert.deepEqual(userConfig.test.setupFiles, ['./custom-setup.ts']);
});

test('Vitest Plugin: gracefully falls back to setupFiles when user already has custom runner', () => {
  const userConfig = {
    test: {
      runner: './my-custom-runner.ts',
      setupFiles: ['./existing-setup.ts']
    }
  };

  const plugin = softscopeVitest();
  plugin.config(userConfig);

  // Custom runner should not be silently overwritten
  assert.equal(userConfig.test.runner, './my-custom-runner.ts');
  // Setup file should be attached
  assert.ok(userConfig.test.setupFiles.includes('./existing-setup.ts'));
  assert.ok(userConfig.test.setupFiles.some(f => f.endsWith('setup.js')));
});

test('Vitest Plugin: warns when browser mode is enabled', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  try {
    const userConfig = {
      test: {
        browser: { enabled: true }
      }
    };
    const plugin = softscopeVitest();
    plugin.config(userConfig);

    assert.ok(warnings.some(w => w.includes('Browser Mode is not supported')));
  } finally {
    console.warn = origWarn;
  }
});

test('Vitest Plugin: instruments application files with virtual client import and function hooks', () => {
  const root = path.resolve('/tmp/test-vitest-project');
  const plugin = softscopeVitest();
  plugin.configResolved({ root });

  const filePath = path.join(root, 'src', 'math.js');
  const code = `
export function add(a, b) {
  return a + b;
}
export const multiply = (a, b) => a * b;
`;

  const result = plugin.transform(code, filePath);
  assert.ok(result);
  assert.ok(result.code.includes('import __softscope from "virtual:softscope-vitest-client";'));
  assert.ok(result.code.includes('globalThis.__softscope?.registerFile?.'));
  assert.ok(result.code.includes('__softscope.enter(1)'));
  assert.ok(result.code.includes('__softscope.exit(1)'));
  assert.ok(result.code.includes('__softscope.enter(2)'));
  assert.ok(result.code.includes('__softscope.exit(2)'));

  // Test files themselves must NOT be instrumented
  const testFile = path.join(root, 'src', 'math.test.js');
  assert.equal(plugin.transform(code, testFile), null);

  // Setup files and global-setup must NOT be instrumented
  const globalSetupFile = path.join(root, 'tests', 'global-setup.js');
  assert.equal(plugin.transform(code, globalSetupFile), null);

  const vitestSetupFile = path.join(root, 'vitest.setup.ts');
  assert.equal(plugin.transform(code, vitestSetupFile), null);
});

test('Vitest Plugin: virtual client proxy safely handles uninitialized globalThis.__softscope without throwing', () => {
  const plugin = softscopeVitest();
  const clientCode = plugin.load('\0virtual:softscope-vitest-client');

  assert.ok(clientCode.includes('new Proxy'));

  // Evaluate the proxy code in an isolated scope where globalThis.__softscope is undefined
  const origSoftscope = globalThis.__softscope;
  delete globalThis.__softscope;

  try {
    const executableCode = clientCode
      .replace(/export\s+default\s+client;?/g, '')
      .replace(/export\s+const\s+__softscope\s+=\s+client;?/g, '');
    const fn = new Function(`${executableCode}; return client;`);
    const client = fn();

    // Calling enter/exit/registerFile on uninitialized proxy must NOT throw TypeError
    assert.doesNotThrow(() => client.enter(1));
    assert.doesNotThrow(() => client.exit(1));
    assert.doesNotThrow(() => client.registerFile('foo.js', []));
    assert.doesNotThrow(() => client.anyOtherMethod?.());
  } finally {
    globalThis.__softscope = origSoftscope;
  }
});

test('Vitest Runner: captures instrumented calls without measure() wrapper', async () => {
  sessionManager.init();

  // Register function metadata as if loaded through instrumented file
  fileRegistry.set(1001, {
    id: 1001,
    name: 'calculateTax',
    file: 'src/billing.js',
    line: 12,
    column: 1
  });

  const runner = new SoftscopeTestRunner({});
  const task = {
    id: 'test-1',
    name: 'calculates sales tax accurately',
    file: { filepath: 'test/billing.test.js' },
    fn: async () => {
      // Simulate instrumented code running inside application
      globalThis.__softscope.enter(1001);
      await new Promise(resolve => setTimeout(resolve, 5));
      globalThis.__softscope.exit(1001);
    }
  };

  await runner.runTest(task);

  assert.ok(task.meta?.softscope, 'task.meta.softscope should be populated');
  const report = task.meta.softscope;
  assert.equal(report.testName, 'calculates sales tax accurately');
  assert.equal(report.file, 'test/billing.test.js');
  assert.equal(report.metrics.length, 1);
  assert.equal(report.metrics[0].name, 'calculateTax');
  assert.equal(report.metrics[0].calls, 1);
  assert.ok(report.metrics[0].totalDurationMs >= 4, 'Should record elapsed duration');
  assert.equal(report.metrics[0].errors, 0);
});

test('Vitest Runner: guarantees strict isolation across concurrent async tests', async () => {
  sessionManager.init();

  fileRegistry.set(2001, { id: 2001, name: 'asyncWorkerA', file: 'src/workerA.js' });
  fileRegistry.set(2002, { id: 2002, name: 'asyncWorkerB', file: 'src/workerB.js' });

  const runner = new SoftscopeTestRunner({});

  const taskA = {
    id: 'test-concurrent-a',
    name: 'task A concurrent execution',
    file: { filepath: 'test/concurrent.test.js' },
    fn: async () => {
      globalThis.__softscope.enter(2001);
      await new Promise(r => setTimeout(r, 20));
      globalThis.__softscope.exit(2001);

      globalThis.__softscope.enter(2001);
      await new Promise(r => setTimeout(r, 10));
      globalThis.__softscope.exit(2001);
    }
  };

  const taskB = {
    id: 'test-concurrent-b',
    name: 'task B concurrent execution',
    file: { filepath: 'test/concurrent.test.js' },
    fn: async () => {
      globalThis.__softscope.enter(2002);
      await new Promise(r => setTimeout(r, 15));
      globalThis.__softscope.exit(2002);
    }
  };

  // Run concurrently on the same thread/event loop
  await Promise.all([
    runner.runTest(taskA),
    runner.runTest(taskB)
  ]);

  // Task A must only contain workerA metrics
  const metaA = taskA.meta.softscope;
  assert.equal(metaA.metrics.length, 1);
  assert.equal(metaA.metrics[0].name, 'asyncWorkerA');
  assert.equal(metaA.metrics[0].calls, 2);

  // Task B must only contain workerB metrics
  const metaB = taskB.meta.softscope;
  assert.equal(metaB.metrics.length, 1);
  assert.equal(metaB.metrics[0].name, 'asyncWorkerB');
  assert.equal(metaB.metrics[0].calls, 1);
});

test('Vitest Runner: handles failed tests and retries with proper cleanup without masking error', async () => {
  sessionManager.init();

  fileRegistry.set(3001, { id: 3001, name: 'faultyService', file: 'src/faulty.js' });

  const runner = new SoftscopeTestRunner({});
  const taskFail = {
    id: 'test-fail-1',
    name: 'asserts faulty service',
    file: { filepath: 'test/faulty.test.js' },
    retry: 0,
    fn: async () => {
      globalThis.__softscope.enter(3001);
      globalThis.__softscope.exit(3001, true); // error exit
      throw new Error('Assertion failed: expected 200 OK');
    }
  };

  // The runner must propagate the error without masking it
  await assert.rejects(
    async () => await runner.runTest(taskFail),
    /Assertion failed: expected 200 OK/
  );

  // Metrics must still be cleanly recorded despite test failure
  assert.ok(taskFail.meta?.softscope);
  assert.equal(taskFail.meta.softscope.metrics[0].errors, 1);
  assert.equal(taskFail.meta.softscope.retry, 0);

  // Simulate retry of the same test
  const taskRetry = {
    id: 'test-fail-1',
    name: 'asserts faulty service',
    file: { filepath: 'test/faulty.test.js' },
    retry: 1,
    fn: async () => {
      globalThis.__softscope.enter(3001);
      globalThis.__softscope.exit(3001);
    }
  };

  await runner.runTest(taskRetry);
  assert.ok(taskRetry.meta?.softscope);
  assert.equal(taskRetry.meta.softscope.retry, 1);
  assert.notEqual(taskFail.meta.softscope.sessionId, taskRetry.meta.softscope.sessionId, 'Session IDs must differ between retries');
  assert.equal(taskRetry.meta.softscope.metrics[0].calls, 1, 'Retry calls should start fresh');
});

test('Vitest Runner: ignores or tracks calls made after session has closed (late calls)', async () => {
  sessionManager.init();
  fileRegistry.set(4001, { id: 4001, name: 'lateAsyncCall', file: 'src/late.js' });

  const runner = new SoftscopeTestRunner({});
  let resolveLate;
  const latePromise = new Promise(r => { resolveLate = r; });

  const task = {
    id: 'test-late',
    name: 'test with dangling async timer',
    file: { filepath: 'test/late.test.js' },
    fn: async () => {
      // Spawn async call that completes after test finishes
      setTimeout(() => {
        globalThis.__softscope.enter(4001);
        globalThis.__softscope.exit(4001);
        resolveLate();
      }, 10);
    }
  };

  await runner.runTest(task);
  // Wait for late call to fire
  await latePromise;

  // The metric inside closed session should have 0 calls because it was closed
  assert.ok(task.meta.softscope);
  assert.equal(task.meta.softscope.metrics.length, 0);

  // Late call must be captured in globalStats or session after timeout
  assert.ok(globalStats.lateCalls >= 1, 'Late calls counter should record delayed calls');

  // Verify next test does NOT inherit or leak late calls from previous test
  const nextTask = {
    id: 'test-next',
    name: 'subsequent isolated test',
    file: { filepath: 'test/late.test.js' },
    fn: async () => {}
  };
  await runner.runTest(nextTask);
  assert.equal(nextTask.meta.softscope.metrics.length, 0);
  assert.equal(nextTask.meta.softscope.lateCallsCount, 0);
});

test('Vitest Reporter: aggregates multi-worker test results and outputs atomic JSON', () => {
  const jsonReportPath = path.resolve('/tmp/softscope-test-report.json');
  if (fs.existsSync(jsonReportPath)) fs.unlinkSync(jsonReportPath);

  const reporter = new SoftscopeVitestReporter({
    json: jsonReportPath,
    silent: true
  });

  // Simulate finished files from multiple worker threads
  const files = [
    {
      filepath: 'test/user.test.js',
      tasks: [
        {
          type: 'test',
          name: 'creates user',
          meta: {
            softscope: {
              sessionId: 'sess-worker1',
              testName: 'creates user',
              file: 'test/user.test.js',
              baselineKey: 'test/user.test.js > creates user',
              metrics: [
                { id: 1, name: 'hashPassword', calls: 1, totalDurationMs: 4.2, avgDurationMs: 4.2 }
              ]
            }
          }
        }
      ]
    },
    {
      filepath: 'test/order.test.js',
      tasks: [
        {
          type: 'test',
          name: 'processes payment',
          meta: {
            softscope: {
              sessionId: 'sess-worker2',
              testName: 'processes payment',
              file: 'test/order.test.js',
              baselineKey: 'test/order.test.js > processes payment',
              metrics: [
                { id: 2, name: 'chargeCard', calls: 2, totalDurationMs: 15.0, avgDurationMs: 7.5 }
              ]
            }
          }
        }
      ]
    }
  ];

  reporter.onFinished(files);

  assert.equal(reporter.collectedTests.length, 2);
  assert.ok(fs.existsSync(jsonReportPath), 'JSON report file must be written atomically');

  const content = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
  assert.equal(content.schemaVersion, 1);
  assert.equal(content.summary.totalProfileedTests, 2);
  assert.equal(content.summary.totalFunctionCalls, 3);
  assert.equal(content.environment.platform, process.platform);

  // Clean up test file
  fs.unlinkSync(jsonReportPath);
});

test('Vitest Reporter: resets state across watch mode reruns', () => {
  const reporter = new SoftscopeVitestReporter({ silent: true });

  const run1Files = [
    {
      tasks: [
        {
          type: 'test',
          name: 'test 1',
          meta: {
            softscope: {
              sessionId: 'sess-1',
              testName: 'test 1',
              metrics: [{ id: 1, name: 'fn1', calls: 5, totalDurationMs: 1.0, avgDurationMs: 0.2 }]
            }
          }
        }
      ]
    }
  ];

  reporter.onFinished(run1Files);
  assert.equal(reporter.collectedTests.length, 1);

  // Trigger watch rerun
  reporter.onWatcherRerun();
  assert.equal(reporter.collectedTests.length, 0, 'Should clear collected tests on watcher rerun');

  const run2Files = [
    {
      tasks: [
        {
          type: 'test',
          name: 'test 2',
          meta: {
            softscope: {
              sessionId: 'sess-2',
              testName: 'test 2',
              metrics: [{ id: 2, name: 'fn2', calls: 1, totalDurationMs: 0.5, avgDurationMs: 0.5 }]
            }
          }
        }
      ]
    }
  ];

  reporter.onFinished(run2Files);
  assert.equal(reporter.collectedTests.length, 1);
  assert.equal(reporter.collectedTests[0].testName, 'test 2');
});

test('Baseline Comparison: handles matches, regressions, improvements, and safe zero division', () => {
  const baseline = {
    schemaVersion: 1,
    environment: {
      platform: process.platform,
      arch: process.arch
    },
    tests: [
      {
        baselineKey: 'test/math.test.js > adds numbers',
        testName: 'adds numbers',
        file: 'test/math.test.js',
        metrics: [
          { name: 'fastAdd', file: 'src/math.js', line: 10, calls: 100, totalDurationMs: 1.0, avgDurationMs: 0.01 },
          { name: 'slowSum', file: 'src/math.js', line: 20, calls: 10, totalDurationMs: 10.0, avgDurationMs: 1.0 },
          { name: 'zeroBase', file: 'src/math.js', line: 30, calls: 5, totalDurationMs: 0.0, avgDurationMs: 0.0 },
          { name: 'removedFn', file: 'src/math.js', line: 40, calls: 1, totalDurationMs: 2.0, avgDurationMs: 2.0 }
        ]
      }
    ]
  };

  const currentTests = [
    {
      baselineKey: 'test/math.test.js > adds numbers',
      testName: 'adds numbers',
      file: 'test/math.test.js',
      metrics: [
        // fastAdd: regressed by +1.5ms (from 1.0ms to 2.5ms = +150%, exceeds threshold 10% and min delta 1.0ms)
        { name: 'fastAdd', file: 'src/math.js', line: 10, calls: 100, totalDurationMs: 2.5, avgDurationMs: 0.025 },
        // slowSum: improved by -3.0ms (from 10.0ms to 7.0ms = -30%)
        { name: 'slowSum', file: 'src/math.js', line: 20, calls: 10, totalDurationMs: 7.0, avgDurationMs: 0.7 },
        // zeroBase: was 0.0ms, now 0.005ms (does NOT exceed min delta 1.0ms -> should match, no divide-by-zero crash)
        { name: 'zeroBase', file: 'src/math.js', line: 30, calls: 5, totalDurationMs: 0.005, avgDurationMs: 0.001 },
        // newFn: newly introduced metric
        { name: 'newFn', file: 'src/math.js', line: 50, calls: 2, totalDurationMs: 0.5, avgDurationMs: 0.25 }
      ]
    }
  ];

  const report = compareTestMetrics(currentTests, baseline, { threshold: 10, minAbsoluteDeltaMs: 1.0 });

  assert.equal(report.missingBaseline, false);
  assert.equal(report.hasRegressions, true);
  assert.equal(report.regressions.length, 1);
  assert.equal(report.regressions[0].name, 'fastAdd');
  assert.equal(report.regressions[0].deltaMs, 1.5);
  assert.equal(report.regressions[0].deltaPct, 150);

  assert.equal(report.improvements.length, 1);
  assert.equal(report.improvements[0].name, 'slowSum');

  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].name, 'zeroBase');

  assert.equal(report.newMetrics.length, 1);
  assert.equal(report.newMetrics[0].metric.name, 'newFn');

  assert.equal(report.removedMetrics.length, 1);
  assert.equal(report.removedMetrics[0].metric.name, 'removedFn');
});

test('Baseline Comparison: handles missing baseline gracefully without throwing', () => {
  const report = compareTestMetrics([{ testName: 'foo', file: 'foo.js', metrics: [] }], '/non/existent/baseline.json');
  assert.equal(report.missingBaseline, true);
  assert.equal(report.regressions.length, 0);
});

test('Complex Nesting: multi-level synchronous call tree (parent -> child -> grandchild)', async () => {
  sessionManager.init();

  fileRegistry.set(6001, { id: 6001, name: 'orderService', file: 'src/order.js', line: 10, column: 1 });
  fileRegistry.set(6002, { id: 6002, name: 'validateOrder', file: 'src/order.js', line: 20, column: 1 });
  fileRegistry.set(6003, { id: 6003, name: 'checkInventory', file: 'src/order.js', line: 30, column: 1 });
  fileRegistry.set(6004, { id: 6004, name: 'applyPricing', file: 'src/order.js', line: 40, column: 1 });
  fileRegistry.set(6005, { id: 6005, name: 'computeDiscount', file: 'src/order.js', line: 50, column: 1 });

  const runner = new SoftscopeTestRunner({});
  const task = {
    id: 'test-sync-nested-tree',
    name: 'processes multi-level sync order pipeline',
    file: { filepath: 'test/order.test.js' },
    fn: async () => {
      // 1. Enter parent: orderService
      globalThis.__softscope.enter(6001);

      // Child 1: validateOrder
      globalThis.__softscope.enter(6002);
      // Grandchild: checkInventory x3
      for (let i = 0; i < 3; i++) {
        globalThis.__softscope.enter(6003);
        // Simulate small work
        let sum = 0; for (let j = 0; j < 50000; j++) sum += j;
        globalThis.__softscope.exit(6003);
      }
      globalThis.__softscope.exit(6002);

      // Child 2: applyPricing
      globalThis.__softscope.enter(6004);
      // Grandchild: computeDiscount x2
      for (let i = 0; i < 2; i++) {
        globalThis.__softscope.enter(6005);
        let sum = 0; for (let j = 0; j < 50000; j++) sum += j;
        globalThis.__softscope.exit(6005);
      }
      globalThis.__softscope.exit(6004);

      globalThis.__softscope.exit(6001);
    }
  };

  await runner.runTest(task);

  assert.ok(task.meta?.softscope);
  const metrics = task.meta.softscope.metrics;

  // All 5 functions in hierarchy must be captured
  assert.equal(metrics.length, 5);

  const mOrder = metrics.find(m => m.name === 'orderService');
  const mValidate = metrics.find(m => m.name === 'validateOrder');
  const mCheck = metrics.find(m => m.name === 'checkInventory');
  const mPricing = metrics.find(m => m.name === 'applyPricing');
  const mDiscount = metrics.find(m => m.name === 'computeDiscount');

  assert.ok(mOrder, 'orderService must be measured');
  assert.ok(mValidate, 'validateOrder must be measured');
  assert.ok(mCheck, 'checkInventory must be measured');
  assert.ok(mPricing, 'applyPricing must be measured');
  assert.ok(mDiscount, 'computeDiscount must be measured');

  // Verify call frequencies
  assert.equal(mOrder.calls, 1);
  assert.equal(mValidate.calls, 1);
  assert.equal(mCheck.calls, 3);
  assert.equal(mPricing.calls, 1);
  assert.equal(mDiscount.calls, 2);

  // Total call count in session must be 1 + 1 + 3 + 1 + 2 = 8
  const totalCalls = metrics.reduce((sum, m) => sum + m.calls, 0);
  assert.equal(totalCalls, 8);

  // Inclusive duration verification: parent duration covers children
  assert.ok(mOrder.totalDurationMs >= mValidate.totalDurationMs + mPricing.totalDurationMs);
  assert.ok(mValidate.totalDurationMs >= mCheck.totalDurationMs);
  assert.ok(mPricing.totalDurationMs >= mDiscount.totalDurationMs);

  // Exclusive self time: child durations subtracted from parents
  assert.ok(mOrder.selfDurationMs <= mOrder.totalDurationMs);
  assert.ok(mValidate.selfDurationMs <= mValidate.totalDurationMs);
});

test('Complex Nesting: multi-level asynchronous call chain (async parent -> await async child -> sync leaf)', async () => {
  sessionManager.init();

  fileRegistry.set(6101, { id: 6101, name: 'fetchUserProfile', file: 'src/user.js', line: 10, column: 1 });
  fileRegistry.set(6102, { id: 6102, name: 'queryDatabase', file: 'src/db.js', line: 20, column: 1 });
  fileRegistry.set(6103, { id: 6103, name: 'parseRow', file: 'src/db.js', line: 30, column: 1 });
  fileRegistry.set(6104, { id: 6104, name: 'enrichFromCache', file: 'src/cache.js', line: 40, column: 1 });
  fileRegistry.set(6105, { id: 6105, name: 'hashKey', file: 'src/cache.js', line: 50, column: 1 });

  const runner = new SoftscopeTestRunner({});
  const task = {
    id: 'test-async-nested-chain',
    name: 'fetches profile with async nested callees',
    file: { filepath: 'test/user.test.js' },
    fn: async () => {
      // Async parent
      globalThis.__softscope.enter(6101);

      // Await async child 1
      globalThis.__softscope.enter(6102);
      await new Promise(r => setTimeout(r, 12));
      // Sync leaves under child 1
      for (let i = 0; i < 4; i++) {
        globalThis.__softscope.enter(6103);
        globalThis.__softscope.exit(6103);
      }
      globalThis.__softscope.exit(6102);

      // Await async child 2
      globalThis.__softscope.enter(6104);
      await new Promise(r => setTimeout(r, 8));
      // Sync leaf under child 2
      globalThis.__softscope.enter(6105);
      globalThis.__softscope.exit(6105);
      globalThis.__softscope.exit(6104);

      globalThis.__softscope.exit(6101);
    }
  };

  await runner.runTest(task);

  assert.ok(task.meta?.softscope);
  const metrics = task.meta.softscope.metrics;
  assert.equal(metrics.length, 5);

  const mParent = metrics.find(m => m.name === 'fetchUserProfile');
  const mDb = metrics.find(m => m.name === 'queryDatabase');
  const mRow = metrics.find(m => m.name === 'parseRow');
  const mCache = metrics.find(m => m.name === 'enrichFromCache');
  const mHash = metrics.find(m => m.name === 'hashKey');

  assert.equal(mParent.calls, 1);
  assert.equal(mDb.calls, 1);
  assert.equal(mRow.calls, 4);
  assert.equal(mCache.calls, 1);
  assert.equal(mHash.calls, 1);

  // Total elapsed time must be at least ~20ms (12ms + 8ms async delays)
  assert.ok(mParent.totalDurationMs >= 18);
  assert.ok(mDb.totalDurationMs >= 10);
  assert.ok(mCache.totalDurationMs >= 6);
});

test('Complex Nesting: recursive functions measure total calls and stack exits accurately', async () => {
  sessionManager.init();

  fileRegistry.set(6201, { id: 6201, name: 'fibonacci', file: 'src/algo.js', line: 15, column: 1 });

  function fib(n) {
    globalThis.__softscope.enter(6201);
    try {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    } finally {
      globalThis.__softscope.exit(6201);
    }
  }

  const runner = new SoftscopeTestRunner({});
  const task = {
    id: 'test-recursion',
    name: 'computes recursive fibonacci with accurate call count',
    file: { filepath: 'test/algo.test.js' },
    fn: async () => {
      const res = fib(6); // fib(6) = 8, triggers exactly 25 recursive calls
      assert.equal(res, 8);
    }
  };

  await runner.runTest(task);

  assert.ok(task.meta?.softscope);
  const mFib = task.meta.softscope.metrics.find(m => m.name === 'fibonacci');
  assert.ok(mFib);
  // Fibonacci(6) binary recursion tree has exactly 25 calls
  assert.equal(mFib.calls, 25);
  assert.equal(mFib.errors, 0);
  assert.ok(mFib.totalDurationMs > 0);
  assert.ok(mFib.avgDurationMs > 0);
});

test('Complex Nesting: error in child function correctly attributes error count and cleans up stack', async () => {
  sessionManager.init();

  fileRegistry.set(6301, { id: 6301, name: 'safeExecute', file: 'src/handler.js', line: 10, column: 1 });
  fileRegistry.set(6302, { id: 6302, name: 'riskyChild', file: 'src/handler.js', line: 20, column: 1 });
  fileRegistry.set(6303, { id: 6303, name: 'fallbackChild', file: 'src/handler.js', line: 30, column: 1 });

  const runner = new SoftscopeTestRunner({});
  const task = {
    id: 'test-error-nesting',
    name: 'catches child failure and runs fallback smoothly',
    file: { filepath: 'test/handler.test.js' },
    fn: async () => {
      globalThis.__softscope.enter(6301);
      try {
        // Call risky child that throws
        try {
          globalThis.__softscope.enter(6302);
          throw new Error('Database connection reset');
        } catch (err) {
          globalThis.__softscope.exit(6302, true); // error exit
          // Handle error and execute fallback
          globalThis.__softscope.enter(6303);
          globalThis.__softscope.exit(6303);
        }
      } finally {
        globalThis.__softscope.exit(6301, false); // parent succeeds
      }
    }
  };

  await runner.runTest(task);

  assert.ok(task.meta?.softscope);
  const metrics = task.meta.softscope.metrics;

  const mSafe = metrics.find(m => m.name === 'safeExecute');
  const mRisky = metrics.find(m => m.name === 'riskyChild');
  const mFallback = metrics.find(m => m.name === 'fallbackChild');

  assert.equal(mSafe.calls, 1);
  assert.equal(mSafe.errors, 0, 'Parent must have 0 errors since exception was caught');

  assert.equal(mRisky.calls, 1);
  assert.equal(mRisky.errors, 1, 'Child must record 1 error');

  assert.equal(mFallback.calls, 1);
  assert.equal(mFallback.errors, 0, 'Fallback child must record 0 errors');
});

test('Complex Nesting: end-to-end transformed code pipeline captures all nested callee metrics', async () => {
  sessionManager.init();

  const registry = createFunctionRegistry();
  const sourceCode = `
function formatCurrency(val) {
  return '$' + val.toFixed(2);
}

function calculateItem(item) {
  const total = item.qty * item.price;
  return formatCurrency(total);
}

function checkoutCart(cart) {
  const formatted = [];
  for (const item of cart.items) {
    formatted.push(calculateItem(item));
  }
  return formatted;
}
`;

  const transformed = transformSource(sourceCode, 'src/shop.js', 'src/shop.js', registry);
  assert.ok(transformed.transformed);

  // Evaluate the transformed code with Softscope hooks in place
  const fnModule = new Function(
    '__softscope',
    `${transformed.code}; return { checkoutCart, calculateItem, formatCurrency };`
  );
  const shop = fnModule(globalThis.__softscope);

  const runner = new SoftscopeTestRunner({});
  const task = {
    id: 'test-e2e-transformed-nesting',
    name: 'exercises end-to-end AST instrumented nested shopping pipeline',
    file: { filepath: 'test/shop.test.js' },
    fn: async () => {
      const cart = {
        items: [
          { name: 'Apple', qty: 3, price: 1.5 },
          { name: 'Banana', qty: 2, price: 0.75 },
          { name: 'Cherry', qty: 5, price: 2.0 }
        ]
      };
      const result = shop.checkoutCart(cart);
      assert.deepEqual(result, ['$4.50', '$1.50', '$10.00']);
    }
  };

  await runner.runTest(task);

  assert.ok(task.meta?.softscope);
  const metrics = task.meta.softscope.metrics;

  const mCheckout = metrics.find(m => m.name === 'checkoutCart');
  const mCalc = metrics.find(m => m.name === 'calculateItem');
  const mFormat = metrics.find(m => m.name === 'formatCurrency');

  assert.ok(mCheckout, 'checkoutCart must be measured');
  assert.ok(mCalc, 'calculateItem must be measured');
  assert.ok(mFormat, 'formatCurrency must be measured');

  // checkoutCart called 1 time
  assert.equal(mCheckout.calls, 1);
  // calculateItem called 3 times (once per item)
  assert.equal(mCalc.calls, 3);
  // formatCurrency called 3 times (once per item inside calculateItem)
  assert.equal(mFormat.calls, 3);

  // Inclusive duration hierarchy
  assert.ok(mCheckout.totalDurationMs >= mCalc.totalDurationMs);
  assert.ok(mCalc.totalDurationMs >= mFormat.totalDurationMs);
});

test('Complex Nesting: Reporter formats and prints multi-level nested function breakdown cleanly', () => {
  const printedLines = [];
  const origLog = console.log;
  console.log = (...args) => printedLines.push(args.join(' '));

  try {
    const reporter = new SoftscopeVitestReporter({ silent: false });
    reporter.collectedTests = [
      {
        testName: 'checkout pipeline test',
        file: 'test/shop.test.js',
        metrics: [
          { id: 1, name: 'checkoutCart', calls: 1, totalDurationMs: 12.5, avgDurationMs: 12.5 },
          { id: 2, name: 'calculateItem', calls: 3, totalDurationMs: 9.3, avgDurationMs: 3.1 },
          { id: 3, name: 'formatCurrency', calls: 3, totalDurationMs: 1.2, avgDurationMs: 0.4 }
        ]
      }
    ];

    reporter.printTerminalSummary();

    const output = printedLines.join('\n');
    assert.ok(output.includes('Softscope Test Performance Summary'));
    assert.ok(output.includes('checkoutCart'));
    assert.ok(output.includes('calculateItem'));
    assert.ok(output.includes('formatCurrency'));
    assert.ok(output.includes('Function times are inclusive and may overlap across nested calls'));
  } finally {
    console.log = origLog;
  }
});

