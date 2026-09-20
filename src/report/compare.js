import fs from 'node:fs';
import path from 'node:path';
import { formatDuration, formatNumber, formatPercent, renderTable } from './format.js';

/**
 * Normalizes file path to a relative POSIX-style path for consistent comparison
 * across different directories or CI machines.
 */
function normalizePath(filePath, projectRoot = process.cwd()) {
  if (!filePath) return '-';
  try {
    const rel = path.relative(projectRoot, filePath);
    return rel.split(path.sep).join('/');
  } catch {
    return String(filePath).split(path.sep).join('/');
  }
}

/**
 * Loads and validates a baseline JSON report from disk.
 */
export function loadBaseline(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Baseline file not found at: ${resolved}`);
  }

  let data;
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse baseline JSON file at ${resolved}: ${err.message}`);
  }

  // Validate basic schema (either v1 export or raw summary snapshot)
  const fns = data.functions;
  if (!Array.isArray(fns)) {
    throw new Error(`Invalid baseline format: expected "functions" array in ${resolved}`);
  }

  return data;
}

/**
 * Computes deltas between baseline and current profiles.
 */
export function computeDelta(baseline, current, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const threshold = options.threshold != null ? options.threshold : 10;

  // Runtime overview deltas
  const durationBaseMs = baseline.runtime ? baseline.runtime.durationMs : baseline.durationMs || 0;
  const durationCurrMs = current.runtime ? current.runtime.durationMs : current.durationMs || 0;
  const durationDiffMs = durationCurrMs - durationBaseMs;
  const durationPercent = durationBaseMs > 0 ? ((durationDiffMs) / durationBaseMs) * 100 : 0;

  const callsBase = baseline.runtime ? baseline.runtime.functionCalls : baseline.totalFunctionCalls || 0;
  const callsCurr = current.runtime ? current.runtime.functionCalls : current.totalFunctionCalls || 0;
  const callsDiff = callsCurr - callsBase;
  const callsPercent = callsBase > 0 ? ((callsDiff) / callsBase) * 100 : 0;

  const reachBase = baseline.runtime?.runtimeReach?.executedPercent ?? baseline.runtimeReach?.executedPercent ?? 0;
  const reachCurr = current.runtime?.runtimeReach?.executedPercent ?? current.runtimeReach?.executedPercent ?? 0;
  const reachDiff = reachCurr - reachBase;

  const baseFunctions = baseline.functions || [];
  const currFunctions = current.functions || [];

  // Index baseline functions
  // Primary key: `${normFile}:${name}:${line}:${col}`
  // Fallback key: `${normFile}:${name}` (only if unique in baseline)
  const basePrimaryMap = new Map();
  const baseNameCounts = new Map();
  const baseNameMap = new Map();

  for (const fn of baseFunctions) {
    const normFile = normalizePath(fn.file, projectRoot);
    const primaryKey = `${normFile}:${fn.name}:${fn.line}:${fn.column}`;
    basePrimaryMap.set(primaryKey, fn);

    const nameKey = `${normFile}:${fn.name}`;
    baseNameCounts.set(nameKey, (baseNameCounts.get(nameKey) || 0) + 1);
    baseNameMap.set(nameKey, fn);
  }

  // Count current functions by nameKey for fallback uniqueness
  const currNameCounts = new Map();
  for (const fn of currFunctions) {
    const normFile = normalizePath(fn.file, projectRoot);
    const nameKey = `${normFile}:${fn.name}`;
    currNameCounts.set(nameKey, (currNameCounts.get(nameKey) || 0) + 1);
  }

  const matchedBaseKeys = new Set();
  const comparisons = [];
  const added = [];

  for (const currFn of currFunctions) {
    const normFile = normalizePath(currFn.file, projectRoot);
    const primaryKey = `${normFile}:${currFn.name}:${currFn.line}:${currFn.column}`;
    const nameKey = `${normFile}:${currFn.name}`;

    let baseFn = null;
    let matchKey = null;

    if (basePrimaryMap.has(primaryKey)) {
      baseFn = basePrimaryMap.get(primaryKey);
      matchKey = primaryKey;
    } else if (baseNameCounts.get(nameKey) === 1 && currNameCounts.get(nameKey) === 1) {
      // Fuzzy fallback: line number moved, but function name is unique in file
      baseFn = baseNameMap.get(nameKey);
      matchKey = `${normFile}:${baseFn.name}:${baseFn.line}:${baseFn.column}`;
    }

    if (baseFn) {
      matchedBaseKeys.add(matchKey);

      const callsDiff = currFn.calls - baseFn.calls;
      const callsPercent = baseFn.calls > 0 ? ((callsDiff) / baseFn.calls) * 100 : 0;

      const selfDiffMs = currFn.selfDurationMs - baseFn.selfDurationMs;
      const selfPercent = baseFn.selfDurationMs > 0 ? ((selfDiffMs) / baseFn.selfDurationMs) * 100 : 0;

      const totalDiffMs = currFn.totalDurationMs - baseFn.totalDurationMs;
      const totalPercent = baseFn.totalDurationMs > 0 ? ((totalDiffMs) / baseFn.totalDurationMs) * 100 : 0;

      const avgCurrMs = currFn.calls > 0 ? currFn.totalDurationMs / currFn.calls : 0;
      const avgBaseMs = baseFn.calls > 0 ? baseFn.totalDurationMs / baseFn.calls : 0;
      const avgDiffMs = avgCurrMs - avgBaseMs;

      // Status classification
      let status = 'unchanged';
      if (selfDiffMs > 0.05 && selfPercent >= 5) {
        status = 'regressed';
      } else if (selfDiffMs < -0.05 && selfPercent <= -5) {
        status = 'improved';
      }

      comparisons.push({
        name: currFn.name,
        file: normFile,
        line: currFn.line,
        column: currFn.column,
        status,
        base: {
          calls: baseFn.calls,
          selfMs: baseFn.selfDurationMs,
          totalMs: baseFn.totalDurationMs,
          avgMs: avgBaseMs,
          line: baseFn.line
        },
        current: {
          calls: currFn.calls,
          selfMs: currFn.selfDurationMs,
          totalMs: currFn.totalDurationMs,
          avgMs: avgCurrMs,
          line: currFn.line
        },
        diff: {
          calls: callsDiff,
          callsPercent,
          selfMs: selfDiffMs,
          selfPercent,
          totalMs: totalDiffMs,
          totalPercent,
          avgMs: avgDiffMs
        }
      });
    } else {
      if (currFn.calls > 0) {
        added.push({
          name: currFn.name,
          file: normFile,
          line: currFn.line,
          column: currFn.column,
          calls: currFn.calls,
          selfMs: currFn.selfDurationMs,
          totalMs: currFn.totalDurationMs
        });
      }
    }
  }

  // Find removed functions (in baseline with calls > 0, but not matched in current)
  const removed = [];
  for (const baseFn of baseFunctions) {
    const normFile = normalizePath(baseFn.file, projectRoot);
    const primaryKey = `${normFile}:${baseFn.name}:${baseFn.line}:${baseFn.column}`;
    if (!matchedBaseKeys.has(primaryKey) && baseFn.calls > 0) {
      removed.push({
        name: baseFn.name,
        file: normFile,
        line: baseFn.line,
        column: baseFn.column,
        calls: baseFn.calls,
        selfMs: baseFn.selfDurationMs,
        totalMs: baseFn.totalDurationMs
      });
    }
  }

  // Sort regressions: highest self-time slowdown first
  const regressions = comparisons
    .filter(c => c.status === 'regressed')
    .sort((a, b) => b.diff.selfMs - a.diff.selfMs);

  // Sort improvements: biggest self-time speedup first
  const improvements = comparisons
    .filter(c => c.status === 'improved')
    .sort((a, b) => a.diff.selfMs - b.diff.selfMs);

  // Check if any regression exceeded the specified regression threshold
  const thresholdBreached = regressions.some(r => r.diff.selfPercent >= threshold && r.diff.selfMs >= 1);

  return {
    overview: {
      durationBaseMs,
      durationCurrMs,
      durationDiffMs,
      durationPercent,
      callsBase,
      callsCurr,
      callsDiff,
      callsPercent,
      reachBase,
      reachCurr,
      reachDiff
    },
    threshold,
    thresholdBreached,
    comparisons,
    regressions,
    improvements,
    added,
    removed
  };
}

function formatDeltaPercent(pct, isImprovement = false) {
  const sign = pct > 0 ? '+' : '';
  const formatted = `${sign}${pct.toFixed(1)}%`;
  return formatted;
}

function formatDeltaMs(ms) {
  const sign = ms > 0 ? '+' : '';
  return `${sign}${formatDuration(Math.abs(ms))}`;
}

/**
 * Renders terminal report for comparison.
 */
export function renderCompareTerminalReport(delta, options = {}) {
  const topLimit = options.top || 10;
  const lines = [];

  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const RESET = '\x1b[0m';

  const ov = delta.overview;
  const durationDeltaStr = ov.durationPercent <= 0
    ? `${GREEN}${formatDeltaPercent(ov.durationPercent)} (${formatDeltaMs(ov.durationDiffMs)})${RESET}`
    : `${RED}${formatDeltaPercent(ov.durationPercent)} (${formatDeltaMs(ov.durationDiffMs)})${RESET}`;

  const callsDeltaStr = ov.callsPercent <= 0
    ? `${GREEN}${formatDeltaPercent(ov.callsPercent)} (${ov.callsDiff >= 0 ? '+' : ''}${formatNumber(ov.callsDiff)})${RESET}`
    : `${YELLOW}${formatDeltaPercent(ov.callsPercent)} (+${formatNumber(ov.callsDiff)})${RESET}`;

  const reachDeltaStr = ov.reachDiff >= 0
    ? `${formatPercent(ov.reachBase)} -> ${formatPercent(ov.reachCurr)} (${GREEN}+${ov.reachDiff.toFixed(1)}%${RESET})`
    : `${formatPercent(ov.reachBase)} -> ${formatPercent(ov.reachCurr)} (${RED}${ov.reachDiff.toFixed(1)}%${RESET})`;

  lines.push('┌─ Performance Comparison Overview ──────────────────────────────────────────┐');
  lines.push(`│ Duration:     Baseline ${formatDuration(ov.durationBaseMs).padEnd(9)} Current ${formatDuration(ov.durationCurrMs).padEnd(9)} Delta: ${durationDeltaStr.padEnd(28)} │`);
  lines.push(`│ Calls:        Baseline ${formatNumber(ov.callsBase).padEnd(9)} Current ${formatNumber(ov.callsCurr).padEnd(9)} Delta: ${callsDeltaStr.padEnd(28)} │`);
  lines.push(`│ Reach:        ${reachDeltaStr.padEnd(58)} │`);
  lines.push('└────────────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // 1. Regressions Table
  if (delta.regressions.length > 0) {
    lines.push(`${BOLD}${RED}Regressions (Self-Time Slower)${RESET}`);
    const regCols = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 30 },
      { key: 'loc', label: 'Location', align: 'left', minWidth: 14, maxWidth: 24, truncateLeft: true },
      { key: 'baseSelf', label: 'Base Self', align: 'right', minWidth: 9 },
      { key: 'currSelf', label: 'Curr Self', align: 'right', minWidth: 9 },
      { key: 'delta', label: 'Delta', align: 'right', minWidth: 16 },
      { key: 'calls', label: 'Calls (Base->Curr)', align: 'right', minWidth: 18 }
    ];

    const regRows = delta.regressions.slice(0, topLimit).map(r => ({
      name: r.name,
      loc: `${r.file}:${r.line}`,
      baseSelf: formatDuration(r.base.selfMs),
      currSelf: formatDuration(r.current.selfMs),
      delta: `${RED}+${formatDuration(r.diff.selfMs)} (+${r.diff.selfPercent.toFixed(1)}%)${RESET}`,
      calls: `${formatNumber(r.base.calls)} -> ${formatNumber(r.current.calls)}`
    }));

    lines.push(renderTable({ columns: regCols, rows: regRows }));
    lines.push('');
  } else {
    lines.push(`${GREEN}✔ No regressions detected.${RESET}`);
    lines.push('');
  }

  // 2. Improvements Table
  if (delta.improvements.length > 0) {
    lines.push(`${BOLD}${GREEN}Improvements (Self-Time Faster)${RESET}`);
    const impCols = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 30 },
      { key: 'loc', label: 'Location', align: 'left', minWidth: 14, maxWidth: 24, truncateLeft: true },
      { key: 'baseSelf', label: 'Base Self', align: 'right', minWidth: 9 },
      { key: 'currSelf', label: 'Curr Self', align: 'right', minWidth: 9 },
      { key: 'delta', label: 'Delta', align: 'right', minWidth: 16 },
      { key: 'calls', label: 'Calls (Base->Curr)', align: 'right', minWidth: 18 }
    ];

    const impRows = delta.improvements.slice(0, topLimit).map(r => ({
      name: r.name,
      loc: `${r.file}:${r.line}`,
      baseSelf: formatDuration(r.base.selfMs),
      currSelf: formatDuration(r.current.selfMs),
      delta: `${GREEN}-${formatDuration(Math.abs(r.diff.selfMs))} (${r.diff.selfPercent.toFixed(1)}%)${RESET}`,
      calls: `${formatNumber(r.base.calls)} -> ${formatNumber(r.current.calls)}`
    }));

    lines.push(renderTable({ columns: impCols, rows: impRows }));
    lines.push('');
  }

  // 3. Newly Added Functions
  if (delta.added.length > 0) {
    lines.push(`${YELLOW}Added Functions in Current Run: ${delta.added.length}${RESET}`);
    const addedCols = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 32 },
      { key: 'loc', label: 'Location', align: 'left', minWidth: 14, maxWidth: 28, truncateLeft: true },
      { key: 'calls', label: 'Calls', align: 'right', minWidth: 8 },
      { key: 'self', label: 'Self Time', align: 'right', minWidth: 10 }
    ];
    const addedRows = delta.added.slice(0, 5).map(a => ({
      name: a.name,
      loc: `${a.file}:${a.line}`,
      calls: formatNumber(a.calls),
      self: formatDuration(a.selfMs)
    }));
    lines.push(renderTable({ columns: addedCols, rows: addedRows }));
    lines.push('');
  }

  // 4. Removed Functions
  if (delta.removed.length > 0) {
    lines.push(`${DIM}Removed/Uncalled Baseline Functions: ${delta.removed.length}${RESET}`);
    lines.push('');
  }

  if (delta.thresholdBreached) {
    lines.push(`${RED}${BOLD}⚠ REGRESSION THRESHOLD BREACHED: Some functions regressed beyond the ${delta.threshold}% limit.${RESET}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders GitHub Flavored Markdown report for PR comments and CI.
 */
export function renderCompareMarkdownReport(delta, options = {}) {
  const topLimit = options.top || 10;
  const lines = [];

  lines.push('# Softscope Performance Comparison');
  lines.push('');

  const ov = delta.overview;
  const durationStatus = ov.durationPercent <= 0 ? '🟢 Faster' : '🔴 Slower';

  lines.push('## Executive Summary');
  lines.push('');
  lines.push('| Metric | Baseline | Current | Delta | Status |');
  lines.push('| :--- | :---: | :---: | :---: | :---: |');
  lines.push(`| **Duration** | ${formatDuration(ov.durationBaseMs)} | ${formatDuration(ov.durationCurrMs)} | **${formatDeltaPercent(ov.durationPercent)}** (${formatDeltaMs(ov.durationDiffMs)}) | ${durationStatus} |`);
  lines.push(`| **Function Calls** | ${formatNumber(ov.callsBase)} | ${formatNumber(ov.callsCurr)} | **${formatDeltaPercent(ov.callsPercent)}** (${ov.callsDiff >= 0 ? '+' : ''}${formatNumber(ov.callsDiff)}) | - |`);
  lines.push(`| **Runtime Reach** | ${formatPercent(ov.reachBase)} | ${formatPercent(ov.reachCurr)} | **${ov.reachDiff >= 0 ? '+' : ''}${ov.reachDiff.toFixed(1)}%** | - |`);
  lines.push('');

  if (delta.regressions.length > 0) {
    lines.push(`## 🔴 Regressions (${delta.regressions.length})`);
    lines.push('');
    lines.push('| Function | Location | Baseline Self | Current Self | Delta | Calls |');
    lines.push('| :--- | :--- | :---: | :---: | :---: | :---: |');
    for (const r of delta.regressions.slice(0, topLimit)) {
      lines.push(`| \`${r.name}\` | \`${r.file}:${r.line}\` | ${formatDuration(r.base.selfMs)} | ${formatDuration(r.current.selfMs)} | **+${formatDuration(r.diff.selfMs)} (+${r.diff.selfPercent.toFixed(1)}%)** | ${formatNumber(r.base.calls)} → ${formatNumber(r.current.calls)} |`);
    }
    lines.push('');
  }

  if (delta.improvements.length > 0) {
    lines.push(`## 🟢 Improvements (${delta.improvements.length})`);
    lines.push('');
    lines.push('| Function | Location | Baseline Self | Current Self | Delta | Calls |');
    lines.push('| :--- | :--- | :---: | :---: | :---: | :---: |');
    for (const r of delta.improvements.slice(0, topLimit)) {
      lines.push(`| \`${r.name}\` | \`${r.file}:${r.line}\` | ${formatDuration(r.base.selfMs)} | ${formatDuration(r.current.selfMs)} | **-${formatDuration(Math.abs(r.diff.selfMs))} (${r.diff.selfPercent.toFixed(1)}%)** | ${formatNumber(r.base.calls)} → ${formatNumber(r.current.calls)} |`);
    }
    lines.push('');
  }

  if (delta.added.length > 0) {
    lines.push(`<details><summary><b>Newly Added Functions (${delta.added.length})</b></summary>`);
    lines.push('');
    lines.push('| Function | Location | Calls | Self Time | Total Time |');
    lines.push('| :--- | :--- | :---: | :---: | :---: |');
    for (const a of delta.added.slice(0, topLimit)) {
      lines.push(`| \`${a.name}\` | \`${a.file}:${a.line}\` | ${formatNumber(a.calls)} | ${formatDuration(a.selfMs)} | ${formatDuration(a.totalMs)} |`);
    }
    lines.push('</details>');
    lines.push('');
  }

  if (delta.thresholdBreached) {
    lines.push(`> ⚠ **Regression Warning**: One or more functions exceeded the configured ${delta.threshold}% regression threshold.`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders token-efficient diagnostic report for AI coding agents.
 */
export function renderCompareAiReport(delta, options = {}) {
  const topLimit = options.top || 10;
  const lines = [];

  const ov = delta.overview;

  lines.push('# Softscope AI Performance Delta Profile');
  if (options.targetCommand) {
    lines.push(`- **Target**: \`${options.targetCommand}\``);
  }
  lines.push(`- **Baseline Duration**: ${formatDuration(ov.durationBaseMs)} | **Current Duration**: ${formatDuration(ov.durationCurrMs)} (${formatDeltaPercent(ov.durationPercent)})`);
  lines.push(`- **Calls**: Base: ${formatNumber(ov.callsBase)} -> Curr: ${formatNumber(ov.callsCurr)} (${formatDeltaPercent(ov.callsPercent)})`);
  lines.push(`- **Regressions Count**: ${delta.regressions.length} | **Improvements Count**: ${delta.improvements.length} | **Threshold**: ${delta.threshold}%`);
  lines.push('');

  if (delta.regressions.length > 0) {
    lines.push('## Regressions (>5% Self-Time Slowdown)');
    delta.regressions.slice(0, topLimit).forEach((r, idx) => {
      lines.push(`${idx + 1}. \`${r.name}\` (\`${r.file}:${r.line}\`)`);
      lines.push(`   - **Self Time**: ${formatDuration(r.base.selfMs)} -> ${formatDuration(r.current.selfMs)} (+${formatDuration(r.diff.selfMs)}, +${r.diff.selfPercent.toFixed(1)}%)`);
      lines.push(`   - **Calls**: ${formatNumber(r.base.calls)} -> ${formatNumber(r.current.calls)}`);
      if (r.diff.callsPercent > 20) {
        lines.push(`   - **Directive**: Function invocation frequency increased by ${r.diff.callsPercent.toFixed(1)}%. Check upstream loops or caller logic for accidental duplication.`);
      } else if (r.diff.selfPercent > 25 && Math.abs(r.diff.callsPercent) <= 5) {
        lines.push(`   - **Directive**: Call count is stable but execution duration jumped +${r.diff.selfPercent.toFixed(1)}%. Inspect internal loop algorithms, allocations, or regex in \`${r.name}\`.`);
      }
    });
    lines.push('');
  }

  if (delta.improvements.length > 0) {
    lines.push('## Improvements (>5% Self-Time Speedup)');
    delta.improvements.slice(0, topLimit).forEach((r, idx) => {
      lines.push(`${idx + 1}. \`${r.name}\` (\`${r.file}:${r.line}\`): ${formatDuration(r.base.selfMs)} -> ${formatDuration(r.current.selfMs)} (-${r.diff.selfPercent.toFixed(1)}%)`);
    });
    lines.push('');
  }

  if (delta.thresholdBreached) {
    lines.push(`## Gating Directive`);
    lines.push(`- Regression threshold of ${delta.threshold}% was breached. Automated gating advised.`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Returns JSON report for machine consumers and CI gating.
 */
export function renderCompareJsonReport(delta) {
  return JSON.stringify({
    version: 1,
    type: 'softscope-compare',
    overview: delta.overview,
    threshold: delta.threshold,
    thresholdBreached: delta.thresholdBreached,
    regressions: delta.regressions,
    improvements: delta.improvements,
    added: delta.added,
    removed: delta.removed
  }, null, 2);
}
