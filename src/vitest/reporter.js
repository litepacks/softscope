import fs from 'node:fs';
import path from 'node:path';
import { compareTestMetrics } from './compare.js';

function writeDirect(msg = '') {
  if (typeof process !== 'undefined' && process.stdout && typeof process.stdout.write === 'function') {
    process.stdout.write(msg + '\n');
  } else {
    console.log(msg);
  }
}

/**
 * Custom Vitest Reporter for aggregating and printing Softscope performance metrics.
 * Runs on the main Node.js process and receives serialized task.meta from worker threads.
 */
export class SoftscopeVitestReporter {
  /**
   * @param {Object} [options]
   * @param {string|boolean} [options.json=false] - File path to save JSON report (or true for softscope-report.json)
   * @param {string} [options.baseline] - File path to compare against
   * @param {string|boolean} [options.saveBaseline=false] - File path to save baseline (or true for softscope-baseline.json)
   * @param {number} [options.threshold=10] - Percentage regression threshold (default: 10%)
   * @param {number} [options.minAbsoluteDeltaMs=1.0] - Minimum absolute delta in ms (default: 1.0ms)
   * @param {boolean} [options.silent=false] - Suppress terminal output
   */
  constructor(options = {}) {
    this.options = options;
    this.collectedTests = [];
    this.failedOrCancelledCount = 0;
    this._finalized = false;
  }

  onWatcherRerun() {
    this.collectedTests = [];
    this.failedOrCancelledCount = 0;
    this._finalized = false;
  }

  onTestRunStart() {
    this.collectedTests = [];
    this.failedOrCancelledCount = 0;
    this._finalized = false;
  }

  // Intercept real-time RPC task updates from worker threads / child processes
  onTaskUpdate(packs) {
    if (!Array.isArray(packs)) return;
    for (const pack of packs) {
      if (!Array.isArray(pack)) continue;
      const [id, result, meta] = pack;
      const softscopeData = meta?.softscope;
      if (softscopeData && Array.isArray(softscopeData.metrics) && softscopeData.metrics.length > 0) {
        if (!this.collectedTests.some(t => t.sessionId === softscopeData.sessionId)) {
          this.collectedTests.push(softscopeData);
        }
      }
    }
  }

  // Vitest 2.x and 3.x per-test hook
  onTestCaseResult(testCase) {
    const meta = typeof testCase?.meta === 'function' ? testCase.meta() : testCase?.meta;
    const softscopeData = meta?.softscope;
    if (softscopeData && Array.isArray(softscopeData.metrics) && softscopeData.metrics.length > 0) {
      if (!this.collectedTests.some(t => t.sessionId === softscopeData.sessionId)) {
        this.collectedTests.push(softscopeData);
      }
    }
  }

  // Vitest 3+ final run hook
  onTestRunEnd(testModules = []) {
    this._finalizeRun(testModules);
  }

  // Vitest 1.x / 2.x legacy final run hook
  onFinished(files = []) {
    this._finalizeRun(files);
  }

  _finalizeRun(modulesOrFiles = []) {
    if (this._finalized) return;
    this._finalized = true;

    // Flatten all test tasks from files, modules, and suites
    const allTasks = [];
    extractTestTasks(modulesOrFiles, allTasks);

    for (const task of allTasks) {
      const meta = typeof task?.meta === 'function' ? task.meta() : task?.meta;
      const softscopeData = meta?.softscope;

      if (softscopeData && Array.isArray(softscopeData.metrics) && softscopeData.metrics.length > 0) {
        if (!this.collectedTests.some(t => t.sessionId === softscopeData.sessionId)) {
          this.collectedTests.push(softscopeData);
        }
      } else if (task.result?.state === 'fail' || task.state === 'fail') {
        this.failedOrCancelledCount++;
      }
    }

    if (!this.options.silent) {
      this.printTerminalSummary();
    }

    // Save baseline if requested
    if (this.options.saveBaseline) {
      this.writeBaselineFile();
    }

    // Export JSON report if requested
    if (this.options.json) {
      this.writeJsonReport();
    }
  }

  printTerminalSummary() {
    if (this.collectedTests.length === 0) {
      if (this.failedOrCancelledCount > 0) {
        writeDirect(`\n⚡ \x1b[33mSoftscope:\x1b[0m No performance metrics captured (${this.failedOrCancelledCount} test(s) failed or cancelled).`);
      }
      return;
    }

    const rows = [];
    let totalCalls = 0;

    for (const test of this.collectedTests) {
      for (const m of test.metrics) {
        totalCalls += m.calls;
        rows.push({
          test: truncate(test.testName, 36),
          fn: truncate(m.name, 22),
          calls: String(m.calls),
          total: m.totalDurationMs.toFixed(2),
          avg: m.avgDurationMs.toFixed(3)
        });
      }
    }

    writeDirect('\n⚡ \x1b[1mSoftscope Test Performance Summary\x1b[0m');
    writeDirect('─'.repeat(78));
    writeDirect(
      'Test'.padEnd(38) +
      'Function'.padEnd(24) +
      'Calls'.padStart(6) +
      'Total (ms)'.padStart(12) +
      'Avg (ms)'.padStart(10)
    );
    writeDirect('─'.repeat(78));

    for (const r of rows) {
      writeDirect(
        r.test.padEnd(38) +
        r.fn.padEnd(24) +
        r.calls.padStart(6) +
        r.total.padStart(12) +
        r.avg.padStart(10)
      );
    }

    writeDirect('─'.repeat(78));
    writeDirect('\x1b[2m* Function times are inclusive and may overlap across nested calls.\x1b[0m');

    // Run baseline comparison if baseline path was provided
    if (this.options.baseline) {
      this.printBaselineComparison();
    }
  }

  printBaselineComparison() {
    const report = compareTestMetrics(this.collectedTests, this.options.baseline, {
      threshold: this.options.threshold,
      minAbsoluteDeltaMs: this.options.minAbsoluteDeltaMs
    });

    if (report.missingBaseline) {
      writeDirect(`\n\x1b[33m[softscope baseline]\x1b[0m Baseline file not found: "${this.options.baseline}". Run with saveBaseline to generate.`);
      return;
    }

    if (report.envWarnings && report.envWarnings.length > 0) {
      for (const w of report.envWarnings) {
        writeDirect(`\x1b[33m[softscope baseline warning]\x1b[0m ${w}`);
      }
    }

    if (report.regressions.length > 0) {
      writeDirect(`\n⚠️  \x1b[1;33mSoftscope Performance Regressions Detected\x1b[0m (Baseline: ${this.options.baseline})`);
      writeDirect('─'.repeat(84));
      writeDirect(
        'Test'.padEnd(34) +
        'Function'.padEnd(20) +
        'Baseline'.padStart(10) +
        'Current'.padStart(10) +
        'Delta'.padStart(18)
      );
      writeDirect('─'.repeat(84));

      for (const reg of report.regressions) {
        const deltaStr = `+${reg.deltaPct}% (+${reg.deltaMs}ms)`;
        writeDirect(
          truncate(reg.testName, 32).padEnd(34) +
          truncate(reg.name, 18).padEnd(20) +
          `${reg.baselineDurationMs.toFixed(2)}ms`.padStart(10) +
          `${reg.currentDurationMs.toFixed(2)}ms`.padStart(10) +
          `\x1b[31m${deltaStr.padStart(18)}\x1b[0m`
        );
      }
      writeDirect('─'.repeat(84));
      writeDirect(`\x1b[2m* Threshold: ${report.thresholdPct}% (min +${report.minAbsoluteDeltaMs}ms). Regressions are reported as warnings only.\x1b[0m`);
    } else if (report.matches.length > 0) {
      writeDirect(`\n\x1b[32m✔ Softscope:\x1b[0m All ${report.matches.length} measured function(s) within baseline thresholds.`);
    }
  }

  writeBaselineFile() {
    const targetFile = typeof this.options.saveBaseline === 'string'
      ? this.options.saveBaseline
      : 'softscope-baseline.json';

    const baselinePayload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch
      },
      tests: this.collectedTests
    };

    writeAtomic(targetFile, JSON.stringify(baselinePayload, null, 2));
    writeDirect(`\x1b[32m[softscope]\x1b[0m Saved baseline to ${path.resolve(targetFile)}`);
  }

  writeJsonReport() {
    const targetFile = typeof this.options.json === 'string'
      ? this.options.json
      : 'softscope-report.json';

    let comparison = null;
    if (this.options.baseline) {
      comparison = compareTestMetrics(this.collectedTests, this.options.baseline, {
        threshold: this.options.threshold,
        minAbsoluteDeltaMs: this.options.minAbsoluteDeltaMs
      });
    }

    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
      },
      config: {
        threshold: this.options.threshold ?? 10,
        minAbsoluteDeltaMs: this.options.minAbsoluteDeltaMs ?? 1.0,
        baseline: this.options.baseline || null
      },
      summary: {
        totalProfileedTests: this.collectedTests.length,
        totalFunctionCalls: this.collectedTests.reduce((sum, t) => sum + t.metrics.reduce((mSum, m) => mSum + m.calls, 0), 0),
        regressionsCount: comparison?.regressions?.length ?? 0
      },
      tests: this.collectedTests,
      comparison: comparison || undefined
    };

    writeAtomic(targetFile, JSON.stringify(payload, null, 2));
    writeDirect(`\x1b[32m[softscope]\x1b[0m Saved performance JSON report to ${path.resolve(targetFile)}`);
  }
}

function extractTestTasks(tasksOrFiles, result) {
  if (!Array.isArray(tasksOrFiles)) return;
  for (const item of tasksOrFiles) {
    if (!item) continue;
    if (item.type === 'test' || item.type === 'custom') {
      result.push(item);
    }
    if (Array.isArray(item.tasks)) {
      extractTestTasks(item.tasks, result);
    }
    if (Array.isArray(item.children)) {
      extractTestTasks(item.children, result);
    } else if (item.children && typeof item.children.allTests === 'function') {
      try {
        const tests = item.children.allTests();
        if (Array.isArray(tests)) {
          extractTestTasks(tests, result);
        }
      } catch {}
    }
  }
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function writeAtomic(targetPath, data) {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${resolved}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tempPath, data, 'utf-8');
  fs.renameSync(tempPath, resolved);
}

export default SoftscopeVitestReporter;
