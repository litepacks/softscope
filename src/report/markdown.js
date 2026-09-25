import path from 'node:path';
import { formatDuration, formatNumber, formatPercent } from './format.js';
import { renderCallTree } from './tree.js';

function formatLocation(fn) {
  if (!fn.file) return '-';
  let relPath = fn.file;
  try {
    relPath = path.relative(process.cwd(), fn.file) || fn.file;
  } catch {
    // Keep as-is
  }
  if (fn.line) {
    return `${relPath}:${fn.line}`;
  }
  return relPath;
}

export function renderMarkdownReport(summary, options = {}) {
  const topLimit = options.top || 10;
  const showFiles = Boolean(options.files);

  const lines = [];

  lines.push('# Softscope Report');
  lines.push('');
  lines.push('## Runtime Overview');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| :--- | :--- |');
  lines.push(`| **Duration** | ${formatDuration(summary.durationMs)} |`);
  lines.push(`| **Files observed** | ${formatNumber(summary.filesObserved)} |`);
  lines.push(`| **Functions discovered** | ${formatNumber(summary.functionsDiscovered)} |`);
  lines.push(`| **Functions executed** | ${formatNumber(summary.functionsExecuted)} |`);
  lines.push(`| **Function calls** | ${formatNumber(summary.totalFunctionCalls)} |`);
  const reach = summary.runtimeReach || { executedPercent: 0, notExecutedPercent: 0 };
  const untouched = summary.functionsNeverExecuted ?? 0;
  lines.push(`| **Runtime reach** | ${formatPercent(reach.executedPercent)} executed (${formatNumber(untouched)} untouched) |`);
  lines.push('');

  const executedFns = (summary.functions || []).filter(f => f.calls > 0);

  if (executedFns.length > 0) {
    // 1. Top total time
    const topTotal = [...executedFns]
      .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
      .slice(0, topLimit);

    lines.push('## Top Total Time');
    lines.push('');
    lines.push('| Function | Location | Calls | Total | Self | Avg | Max |');
    lines.push('| :--- | :--- | :---: | :---: | :---: | :---: | :---: |');
    for (const fn of topTotal) {
      lines.push(`| \`${fn.name}\` | \`${formatLocation(fn)}\` | ${formatNumber(fn.calls)} | ${formatDuration(fn.totalDurationMs)} | ${formatDuration(fn.selfDurationMs)} | ${formatDuration(fn.avgDurationMs)} | ${formatDuration(fn.maxDurationMs)} |`);
    }
    lines.push('');

    // 2. Most called
    const mostCalled = [...executedFns]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, topLimit);

    lines.push('## Most Called');
    lines.push('');
    lines.push('| Function | Location | Calls | Total | Self | Avg |');
    lines.push('| :--- | :--- | :---: | :---: | :---: | :---: |');
    for (const fn of mostCalled) {
      lines.push(`| \`${fn.name}\` | \`${formatLocation(fn)}\` | ${formatNumber(fn.calls)} | ${formatDuration(fn.totalDurationMs)} | ${formatDuration(fn.selfDurationMs)} | ${formatDuration(fn.avgDurationMs)} |`);
    }
    lines.push('');
  }

  // 3. Call hierarchy & relationships
  if (summary.edges && summary.edges.length > 0) {
    const treeStr = renderCallTree(summary.edges, { color: false });
    if (treeStr) {
      lines.push('## Call Hierarchy');
      lines.push('');
      lines.push('```text');
      lines.push(treeStr);
      lines.push('```');
      lines.push('');
    }

    const topEdges = summary.edges.slice(0, Math.min(topLimit, 10));
    lines.push('## Call Relationships');
    lines.push('');
    lines.push('| Caller | Callee | Calls |');
    lines.push('| :--- | :--- | :---: |');
    for (const e of topEdges) {
      lines.push(`| \`${e.callerName}\` | \`${e.calleeName}\` | x${formatNumber(e.calls)} |`);
    }
    lines.push('');
  }

  // 4. File-level summary
  if (showFiles && summary.files && summary.files.length > 0) {
    lines.push('## File-Level Summary');
    lines.push('');
    lines.push('| File | Discovered | Executed | Reach | Calls | Total Time |');
    lines.push('| :--- | :---: | :---: | :---: | :---: | :---: |');
    for (const f of summary.files) {
      let rel = f.file;
      try {
        rel = path.relative(process.cwd(), f.file) || f.file;
      } catch {
        // Keep as-is
      }
      const reachPct = f.functionsDiscovered > 0
        ? formatPercent((f.functionsExecuted / f.functionsDiscovered) * 100)
        : '0.0%';
      lines.push(`| \`${rel}\` | ${formatNumber(f.functionsDiscovered)} | ${formatNumber(f.functionsExecuted)} | ${reachPct} | ${formatNumber(f.calls)} | ${formatDuration(f.totalTimeMs)} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}
