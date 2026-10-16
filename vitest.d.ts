import type { Plugin } from 'vite';

export interface SoftscopeVitestOptions {
  /**
   * File inclusion patterns (globs or regular expressions).
   */
  include?: Array<string | RegExp>;

  /**
   * File exclusion patterns (globs or regular expressions).
   */
  exclude?: Array<string | RegExp>;

  /**
   * Whether to profile dependencies in node_modules.
   * @default false
   */
  includeNodeModules?: boolean;

  /**
   * Output file path for performance JSON report, or true for default 'softscope-report.json'.
   * @default false
   */
  json?: string | boolean;

  /**
   * Path to baseline JSON file to compare current run against.
   */
  baseline?: string;

  /**
   * Save current run results as baseline to specified path, or true for default 'softscope-baseline.json'.
   * @default false
   */
  saveBaseline?: string | boolean;

  /**
   * Percentage degradation threshold to flag as regression.
   * @default 10
   */
  threshold?: number;

  /**
   * Minimum absolute duration difference in ms before flagging regression.
   * @default 1.0
   */
  minAbsoluteDeltaMs?: number;

  /**
   * Suppress terminal summary table.
   * @default false
   */
  silent?: boolean;
}

export interface MetricEntry {
  id: number;
  name: string;
  file: string;
  line: number;
  column: number;
  calls: number;
  totalDurationMs: number;
  selfDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  errors: number;
}

export interface TestPerformanceSummary {
  sessionId: string;
  testId: string;
  testName: string;
  file: string;
  projectName?: string;
  retry: number;
  repeat: number;
  baselineKey: string;
  durationMs: number;
  lateCallsCount: number;
  metrics: MetricEntry[];
}

export declare function softscopeVitest(options?: SoftscopeVitestOptions): Plugin;

export declare class SoftscopeVitestReporter {
  constructor(options?: SoftscopeVitestOptions);
  onWatcherRerun(): void;
  onTestRunStart(): void;
  onFinished(files?: any[]): void;
}

export declare class SoftscopeTestRunner {
  constructor(config: any);
  runTest(test: any): Promise<void>;
}

export default softscopeVitest;
