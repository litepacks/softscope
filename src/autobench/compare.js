import path from 'node:path';
import { formatDuration, formatNumber, formatPercent, formatBytesPerOp, renderTable } from '../report/format.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Computes deltas between two auto-bench benchmark profiles.
 */
export function computeAutoBenchDelta(baselineData, currentData, options = {}) {
  const threshold = options.threshold != null ? options.threshold : 10;
  const baseTarget = baselineData.targetFile || 'baseline';
  const currTarget = currentData.targetFile || 'current';

  const baseFunctions = baselineData.functions || [];
  const currFunctions = currentData.functions || [];

  const baseMap = new Map();
  for (const fn of baseFunctions) {
    baseMap.set(fn.name, fn);
  }

  const currMap = new Map();
  for (const fn of currFunctions) {
    currMap.set(fn.name, fn);
  }

  // Aggregate overview metrics
  let totalOpsBase = 0;
  for (const fn of baseFunctions) {
    if (fn.status === 'ok') totalOpsBase += (fn.opsPerSec || 0);
  }

  let totalOpsCurr = 0;
  for (const fn of currFunctions) {
    if (fn.status === 'ok') totalOpsCurr += (fn.opsPerSec || 0);
  }

  const totalOpsDiff = totalOpsCurr - totalOpsBase;
  const totalOpsPercent = totalOpsBase > 0 ? (totalOpsDiff / totalOpsBase) * 100 : 0;

  const totalCrashesBase = baselineData.totalCrashes || 0;
  const totalCrashesCurr = currentData.totalCrashes || 0;
  const totalCrashesDiff = totalCrashesCurr - totalCrashesBase;

  const totalCliffsBase = baselineData.totalCliffs || 0;
  const totalCliffsCurr = currentData.totalCliffs || 0;
  const totalCliffsDiff = totalCliffsCurr - totalCliffsBase;

  const comparisons = [];
  const added = [];

  for (const currFn of currFunctions) {
    const baseFn = baseMap.get(currFn.name);
    if (baseFn) {
      const opsBase = baseFn.opsPerSec || 0;
      const opsCurr = currFn.opsPerSec || 0;
      const opsDiff = opsCurr - opsBase;
      const opsPercent = opsBase > 0 ? (opsDiff / opsBase) * 100 : 0;

      const avgBaseMs = baseFn.avgMs || 0;
      const avgCurrMs = currFn.avgMs || 0;
      const avgDiffMs = avgCurrMs - avgBaseMs;
      const avgPercent = avgBaseMs > 0 ? (avgDiffMs / avgBaseMs) * 100 : 0;

      const maxBaseMs = baseFn.maxMs || 0;
      const maxCurrMs = currFn.maxMs || 0;
      const maxDiffMs = maxCurrMs - maxBaseMs;

      const crashesBase = baseFn.crashes ? baseFn.crashes.length : 0;
      const crashesCurr = currFn.crashes ? currFn.crashes.length : 0;
      const crashesDiff = crashesCurr - crashesBase;

      const cliffsBase = baseFn.cliffs ? baseFn.cliffs.length : 0;
      const cliffsCurr = currFn.cliffs ? currFn.cliffs.length : 0;
      const cliffsDiff = cliffsCurr - cliffsBase;

      const allocBase = baseFn.bytesPerOp != null ? baseFn.bytesPerOp : null;
      const allocCurr = currFn.bytesPerOp != null ? currFn.bytesPerOp : null;
      const allocDiff = (allocBase != null && allocCurr != null) ? allocCurr - allocBase : 0;
      const allocPercent = (allocBase != null && allocBase > 0) ? (allocDiff / allocBase) * 100 : 0;

      // Status classification
      let status = 'unchanged';
      if (opsPercent <= -threshold || crashesDiff > 0 || cliffsDiff > 0) {
        status = 'regressed';
      } else if (opsPercent >= threshold || crashesDiff < 0 || cliffsDiff < 0) {
        status = 'improved';
      }

      comparisons.push({
        name: currFn.name,
        status,
        base: {
          opsPerSec: opsBase,
          bytesPerOp: allocBase != null ? allocBase : 0,
          avgMs: avgBaseMs,
          minMs: baseFn.minMs || 0,
          maxMs: maxBaseMs,
          crashesCount: crashesBase,
          cliffsCount: cliffsBase
        },
        current: {
          opsPerSec: opsCurr,
          bytesPerOp: allocCurr != null ? allocCurr : 0,
          avgMs: avgCurrMs,
          minMs: currFn.minMs || 0,
          maxMs: maxCurrMs,
          crashesCount: crashesCurr,
          cliffsCount: cliffsCurr
        },
        diff: {
          opsPerSec: opsDiff,
          opsPercent,
          bytesPerOp: allocDiff,
          bytesPerOpPercent: allocPercent,
          avgMs: avgDiffMs,
          avgPercent,
          maxMs: maxDiffMs,
          crashes: crashesDiff,
          cliffs: cliffsDiff
        }
      });
    } else {
      added.push(currFn);
    }
  }

  const removed = [];
  for (const baseFn of baseFunctions) {
    if (!currMap.has(baseFn.name)) {
      removed.push(baseFn);
    }
  }

  const regressions = comparisons.filter(c => c.status === 'regressed');
  const improvements = comparisons.filter(c => c.status === 'improved');

  // Gating threshold check
  const thresholdBreached = regressions.some(
    r => r.diff.opsPercent <= -threshold || r.diff.crashes > 0
  );

  return {
    overview: {
      baselineTarget: baseTarget,
      currentTarget: currTarget,
      iterationsBase: baselineData.iterations || 0,
      iterationsCurr: currentData.iterations || 0,
      totalOpsBase,
      totalOpsCurr,
      totalOpsDiff,
      totalOpsPercent,
      totalCrashesBase,
      totalCrashesCurr,
      totalCrashesDiff,
      totalCliffsBase,
      totalCliffsCurr,
      totalCliffsDiff,
      avgAllocBase: baselineData.avgBytesPerOp != null ? baselineData.avgBytesPerOp : 0,
      avgAllocCurr: currentData.avgBytesPerOp != null ? currentData.avgBytesPerOp : 0,
      functionsCompared: comparisons.length
    },
    comparisons,
    added,
    removed,
    regressions,
    improvements,
    threshold,
    thresholdBreached
  };
}

/**
 * Renders terminal report for auto-bench comparison.
 */
export function renderAutoBenchCompareTerminalReport(delta, options = {}) {
  const { overview, comparisons, regressions, improvements } = delta;
  const lines = [];

  // 1. Overview Card
  const sign = overview.totalOpsPercent >= 0 ? '+' : '';
  const opsDeltaBadge = overview.totalOpsPercent >= 0
    ? `${GREEN}${sign}${formatPercent(overview.totalOpsPercent)} 🚀${RESET}`
    : `${RED}${sign}${formatPercent(overview.totalOpsPercent)} ⚠${RESET}`;

  const throughputStr = `${formatNumber(overview.totalOpsBase)}/s ──▶ ${formatNumber(overview.totalOpsCurr)}/s (${opsDeltaBadge})`;

  let cliffsShift = `${overview.totalCliffsBase} ──▶ ${overview.totalCliffsCurr}`;
  if (overview.totalCliffsDiff < 0) {
    cliffsShift += ` (${GREEN}${overview.totalCliffsDiff} fixed! 🎉${RESET})`;
  } else if (overview.totalCliffsDiff > 0) {
    cliffsShift += ` (${YELLOW}+${overview.totalCliffsDiff} new ⚠${RESET})`;
  } else {
    cliffsShift += ` (${GREEN}✔${RESET})`;
  }

  let crashesShift = `${overview.totalCrashesBase} ──▶ ${overview.totalCrashesCurr}`;
  if (overview.totalCrashesDiff < 0) {
    crashesShift += ` (${GREEN}${overview.totalCrashesDiff} fixed! 🎉${RESET})`;
  } else if (overview.totalCrashesDiff > 0) {
    crashesShift += ` (${RED}+${overview.totalCrashesDiff} new 🔴${RESET})`;
  } else {
    crashesShift += ` (${GREEN}✔${RESET})`;
  }

  lines.push('┌─ Auto-Bench Performance Comparison ──────────────────────────────────────┐');
  lines.push(`│ Baseline: ${overview.baselineTarget.padEnd(28)} Current: ${overview.currentTarget.padEnd(26)} │`);
  lines.push(`│ Total Throughput: ${throughputStr.padEnd(68)} │`);
  lines.push(`│ Latency Cliffs:   ${cliffsShift.padEnd(38)} Unhandled Crashes: ${crashesShift.padEnd(20)} │`);
  lines.push('└───────────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // 2. Comparison Table
  if (comparisons.length > 0) {
    lines.push(`${BOLD}Function Comparison${RESET}`);
    const cols = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 12, maxWidth: 20 },
      { key: 'baseOps', label: 'Base Ops', align: 'right', minWidth: 11 },
      { key: 'currOps', label: 'Curr Ops', align: 'right', minWidth: 11 },
      { key: 'opsDelta', label: 'Ops Delta', align: 'right', minWidth: 11 },
      { key: 'allocDelta', label: 'Alloc Delta', align: 'right', minWidth: 13 },
      { key: 'latDelta', label: 'Latency', align: 'right', minWidth: 9 },
      { key: 'status', label: 'Status', align: 'left', minWidth: 10 }
    ];

    const rows = comparisons.map(c => {
      const opsSign = c.diff.opsPercent >= 0 ? '+' : '';
      let opsDeltaStr;
      if (c.diff.opsPercent >= delta.threshold) {
        opsDeltaStr = `${GREEN}${opsSign}${formatPercent(c.diff.opsPercent)} 🚀${RESET}`;
      } else if (c.diff.opsPercent <= -delta.threshold) {
        opsDeltaStr = `${RED}${opsSign}${formatPercent(c.diff.opsPercent)} ⚠${RESET}`;
      } else {
        opsDeltaStr = `${DIM}${opsSign}${formatPercent(c.diff.opsPercent)}${RESET}`;
      }

      let allocDeltaStr = `${DIM}0 B/op${RESET}`;
      if (c.diff.bytesPerOp < 0) {
        allocDeltaStr = `${GREEN}${formatBytesPerOp(c.diff.bytesPerOp)} 🚀${RESET}`;
      } else if (c.diff.bytesPerOp > 0) {
        allocDeltaStr = `${RED}+${formatBytesPerOp(c.diff.bytesPerOp)} ⚠${RESET}`;
      }

      const latSign = c.diff.avgPercent >= 0 ? '+' : '';
      let latDeltaStr;
      if (c.diff.avgPercent <= -delta.threshold) {
        latDeltaStr = `${GREEN}${latSign}${formatPercent(c.diff.avgPercent)}${RESET}`;
      } else if (c.diff.avgPercent >= delta.threshold) {
        latDeltaStr = `${RED}${latSign}${formatPercent(c.diff.avgPercent)}${RESET}`;
      } else {
        latDeltaStr = `${DIM}${latSign}${formatPercent(c.diff.avgPercent)}${RESET}`;
      }

      let extra = '';
      if (c.diff.crashes < 0) extra = ` (${Math.abs(c.diff.crashes)} fixed 🎉)`;
      else if (c.diff.crashes > 0) extra = ` (+${c.diff.crashes} crash 🔴)`;
      else if (c.diff.cliffs < 0) extra = ` (${Math.abs(c.diff.cliffs)} fixed 🎉)`;
      else if (c.diff.cliffs > 0) extra = ` (+${c.diff.cliffs} cliff ⚠)`;

      let statusStr;
      if (c.status === 'improved') {
        statusStr = `${GREEN}${BOLD}Improved${RESET}${extra}`;
      } else if (c.status === 'regressed') {
        statusStr = `${RED}${BOLD}Regressed${RESET}${extra}`;
      } else {
        statusStr = `${DIM}Unchanged${RESET}`;
      }

      return {
        name: c.name,
        baseOps: formatNumber(c.base.opsPerSec) + '/s',
        currOps: formatNumber(c.current.opsPerSec) + '/s',
        opsDelta: opsDeltaStr,
        allocDelta: allocDeltaStr,
        latDelta: latDeltaStr,
        status: statusStr
      };
    });

    lines.push(renderTable({ columns: cols, rows, maxTotalWidth: Math.max(process.stdout.columns || 80, 80) }));
    lines.push('');
  }

  // 3. Added / Removed functions
  if (delta.added.length > 0) {
    lines.push(`${CYAN}New Functions Added (${delta.added.length}):${RESET} ${delta.added.map(f => f.name).join(', ')}`);
  }
  if (delta.removed.length > 0) {
    lines.push(`${YELLOW}Functions Removed (${delta.removed.length}):${RESET} ${delta.removed.map(f => f.name).join(', ')}`);
  }

  // 4. Threshold Warning
  if (delta.thresholdBreached) {
    lines.push('');
    lines.push(`${RED}${BOLD}✖ Performance regression detected exceeding threshold (${delta.threshold}%):${RESET}`);
    for (const r of regressions) {
      if (r.diff.opsPercent <= -delta.threshold) {
        lines.push(`  • ${r.name}: ${formatNumber(r.base.opsPerSec)}/s -> ${formatNumber(r.current.opsPerSec)}/s (${formatPercent(r.diff.opsPercent)})`);
      }
      if (r.diff.crashes > 0) {
        lines.push(`  • ${r.name}: Introduced ${r.diff.crashes} new unhandled crash(es)`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Markdown report for auto-bench comparison (GFM PR comments).
 */
export function renderAutoBenchCompareMarkdownReport(delta, options = {}) {
  const { overview, comparisons, regressions } = delta;
  const lines = [];

  const sign = overview.totalOpsPercent >= 0 ? '+' : '';
  const emoji = overview.totalOpsPercent >= 0 ? '🚀' : '⚠️';

  lines.push('## Softscope Auto-Bench Performance Comparison');
  lines.push('');
  lines.push(`**Baseline:** \`${overview.baselineTarget}\` | **Current:** \`${overview.currentTarget}\``);
  lines.push(`**Throughput Delta:** **${sign}${formatPercent(overview.totalOpsPercent)}** ${emoji} (${formatNumber(overview.totalOpsBase)}/s ──▶ ${formatNumber(overview.totalOpsCurr)}/s)`);
  lines.push(`**Unhandled Crashes:** ${overview.totalCrashesBase} ──▶ ${overview.totalCrashesCurr} | **Latency Cliffs:** ${overview.totalCliffsBase} ──▶ ${overview.totalCliffsCurr}`);
  lines.push('');

  lines.push('| Function | Baseline Ops/s | Current Ops/s | Ops Delta | Alloc Delta | Latency Delta | Stability | Status |');
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | :--- | :--- |');

  for (const c of comparisons) {
    const opsSign = c.diff.opsPercent >= 0 ? '+' : '';
    const latSign = c.diff.avgPercent >= 0 ? '+' : '';
    let allocDeltaStr = '0 B/op';
    if (c.diff.bytesPerOp < 0) {
      allocDeltaStr = `${formatBytesPerOp(c.diff.bytesPerOp)} 🚀`;
    } else if (c.diff.bytesPerOp > 0) {
      allocDeltaStr = `+${formatBytesPerOp(c.diff.bytesPerOp)} ⚠`;
    }

    let stabilityStr = 'Stable';
    if (c.diff.crashes > 0) stabilityStr = `+${c.diff.crashes} Crash 🔴`;
    else if (c.diff.crashes < 0) stabilityStr = `${Math.abs(c.diff.crashes)} Crash Fixed 🎉`;
    else if (c.diff.cliffs > 0) stabilityStr = `+${c.diff.cliffs} Cliff ⚠️`;
    else if (c.diff.cliffs < 0) stabilityStr = `${Math.abs(c.diff.cliffs)} Cliff Fixed 🎉`;

    lines.push(`| \`${c.name}\` | ${formatNumber(c.base.opsPerSec)} | ${formatNumber(c.current.opsPerSec)} | ${opsSign}${formatPercent(c.diff.opsPercent)} | ${allocDeltaStr} | ${latSign}${formatPercent(c.diff.avgPercent)} | ${stabilityStr} | **${c.status}** |`);
  }
  lines.push('');

  if (delta.thresholdBreached) {
    lines.push('> ⚠️ **Warning: Performance regressions detected exceeding threshold.**');
  }

  return lines.join('\n');
}

/**
 * Token-efficient AI/LLM report for auto-bench comparison.
 */
export function renderAutoBenchCompareAiReport(delta, options = {}) {
  const { overview, comparisons, regressions } = delta;
  const lines = [];

  lines.push('[SOFTSCOPE_AUTOBENCH_COMPARE_V1]');
  lines.push(`BASELINE_TARGET: ${overview.baselineTarget}`);
  lines.push(`CURRENT_TARGET: ${overview.currentTarget}`);
  lines.push(`TOTAL_OPS_DELTA_PERCENT: ${formatPercent(overview.totalOpsPercent)}`);
  lines.push(`CRASHES_DELTA: ${overview.totalCrashesDiff}`);
  lines.push(`CLIFFS_DELTA: ${overview.totalCliffsDiff}`);
  lines.push(`THRESHOLD_BREACHED: ${delta.thresholdBreached ? 'TRUE' : 'FALSE'}`);
  lines.push('');

  lines.push('## FUNCTION_DELTAS');
  for (const c of comparisons) {
    lines.push(`- ${c.name}: ops=${c.diff.opsPercent >= 0 ? '+' : ''}${formatPercent(c.diff.opsPercent)} (${formatNumber(c.base.opsPerSec)}->${formatNumber(c.current.opsPerSec)}), alloc=${formatBytesPerOp(c.diff.bytesPerOp)}, lat=${c.diff.avgPercent >= 0 ? '+' : ''}${formatPercent(c.diff.avgPercent)}, status=${c.status}`);
  }
  lines.push('');

  if (regressions.length > 0) {
    lines.push('## REGRESSIONS_ACTIONABLE');
    for (const r of regressions) {
      lines.push(`- Investigate slowdown in ${r.name}: throughput degraded by ${formatPercent(r.diff.opsPercent)}.`);
    }
  }

  return lines.join('\n');
}

/**
 * Version 1 JSON report for auto-bench comparison.
 */
export function renderAutoBenchCompareJsonReport(delta) {
  return JSON.stringify({
    version: 1,
    type: 'softscope-autobench-compare',
    overview: delta.overview,
    comparisons: delta.comparisons,
    added: delta.added,
    removed: delta.removed,
    regressions: delta.regressions,
    improvements: delta.improvements,
    threshold: delta.threshold,
    thresholdBreached: delta.thresholdBreached
  }, null, 2);
}
