import fs from 'node:fs';
import path from 'node:path';
import { compareTestMetrics } from './compare.js';

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
  }

  onWatcherRerun() {
    // Reset state in watch mode to avoid mixing runs
    this.collectedTests = [];
    this.failedOrCancelledCount = 0;
  }

  onTestRunStart() {
    this.collectedTests = [];
    this.failedOrCancelledCount = 0;
  }

  onFinished(files = []) {
    // Flatten all test tasks from files and suites
    const allTasks = [];
    extractTestTasks(files, allTasks);

    for (const task of allTasks) {
      const softscopeData = task.meta?.softscope;
      if (softscopeData && Array.isArray(softscopeData.metrics) && softscopeData.metrics.length > 0) {
        this.collectedTests.push(softscopeData);
      } else if (task.result?.state === 'fail') {
        // Track failed or crashed tasks without attributing artificial zero metrics
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
        console.log(`\n⚡ \x1b[33mSoftscope:\x1b[0m No performance metrics captured (${this.failedOrCancelledCount} test(s) failed or cancelled).`);
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

    console.log('\n⚡ \x1b[1mSoftscope Test Performance Summary\x1b[0m');
    console.log('─'.repeat(78));
    console.log(
      'Test'.padEnd(38) +
      'Function'.padEnd(24) +
      'Calls'.padStart(6) +
      'Total (ms)'.padStart(12) +
      'Avg (ms)'.padStart(10)
    );
    console.log('─'.repeat(78));

    for (const r of rows) {
      console.log(
        r.test.padEnd(38) +
        r.fn.padEnd(24) +
        r.calls.padStart(6) +
        r.total.padStart(12) +
        r.avg.padStart(10)
      );
    }

    console.log('─'.repeat(78));
    console.log('\x1b[2m* Function times are inclusive and may overlap across nested calls.\x1b[0m');

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
      console.log(`\n\x1b[33m[softscope baseline]\x1b[0m Baseline file not found: "${this.options.baseline}". Run with saveBaseline to generate.`);
      return;
    }

    if (report.envWarnings && report.envWarnings.length > 0) {
      for (const w of report.envWarnings) {
        console.log(`\x1b[33m[softscope baseline warning]\x1b[0m ${w}`);
      }
    }

    if (report.regressions.length > 0) {
      console.log(`\n⚠️  \x1b[1;33mSoftscope Performance Regressions Detected\x1b[0m (Baseline: ${this.options.baseline})`);
      console.log('─'.repeat(84));
      console.log(
        'Test'.padEnd(34) +
        'Function'.padEnd(20) +
        'Baseline'.padStart(10) +
        'Current'.padStart(10) +
        'Delta'.padStart(18)
      );
      console.log('─'.repeat(84));

      for (const reg of report.regressions) {
        const deltaStr = `+${reg.deltaPct}% (+${reg.deltaMs}ms)`;
        console.log(
          truncate(reg.testName, 32).padEnd(34) +
          truncate(reg.name, 18).padEnd(20) +
          `${reg.baselineDurationMs.toFixed(2)}ms`.padStart(10) +
          `${reg.currentDurationMs.toFixed(2)}ms`.padStart(10) +
          `\x1b[31m${deltaStr.padStart(18)}\x1b[0m`
        );
      }
      console.log('─'.repeat(84));
      console.log(`\x1b[2m* Threshold: ${report.thresholdPct}% (min +${report.minAbsoluteDeltaMs}ms). Regressions are reported as warnings only.\x1b[0m`);
    } else if (report.matches.length > 0) {
      console.log(`\n\x1b[32m✔ Softscope:\x1b[0m All ${report.matches.length} measured function(s) within baseline thresholds.`);
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
    console.log(`\x1b[32m[softscope]\x1b[0m Saved baseline to ${path.resolve(targetFile)}`);
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
    console.log(`\x1b[32m[softscope]\x1b[0m Saved performance JSON report to ${path.resolve(targetFile)}`);
  }
}

function extractTestTasks(tasksOrFiles, result) {
  if (!Array.isArray(tasksOrFiles)) return;
  for (const item of tasksOrFiles) {
    if (!item) continue;
    // In Vitest, tasks inside a file can be accessed via item.tasks
    if (item.type === 'test' || item.type === 'custom') {
      result.push(item);
    }
    if (Array.isArray(item.tasks)) {
      extractTestTasks(item.tasks, result);
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
