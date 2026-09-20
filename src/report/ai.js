import path from 'node:path';
import { formatDuration, formatNumber, formatPercent } from './format.js';

function formatLocation(fn) {
  if (!fn || !fn.file) return '-';
  let relPath = fn.file;
  try {
    relPath = path.relative(process.cwd(), fn.file) || fn.file;
  } catch {
    // Keep as-is
  }
  if (fn.line != null) {
    if (fn.column != null) {
      return `${relPath}:${fn.line}:${fn.column}`;
    }
    return `${relPath}:${fn.line}`;
  }
  return relPath;
}

export function renderAiReport(summary, options = {}) {
  const topLimit = options.top || 10;
  const lines = [];

  // 1. Header & Overview
  lines.push('# Softscope AI Profile');
  if (options.targetCommand) {
    lines.push(`- **Target**: \`${options.targetCommand}\``);
  }
  lines.push(`- **Wall Duration**: ${formatDuration(summary.durationMs)}`);
  lines.push(`- **Total Function Calls**: ${formatNumber(summary.totalFunctionCalls)}`);
  lines.push(`- **Files Observed**: ${formatNumber(summary.filesObserved)}`);
  const reach = summary.runtimeReach || { executedPercent: 0, notExecutedPercent: 100 };
  lines.push(
    `- **Functions**: Discovered: ${formatNumber(summary.functionsDiscovered)} | Executed: ${formatNumber(
      summary.functionsExecuted
    )} (${formatPercent(reach.executedPercent)}) | Untouched: ${formatNumber(
      summary.functionsNeverExecuted
    )} (${formatPercent(reach.notExecutedPercent)})`
  );
  lines.push('');

  const executedFns = (summary.functions || []).filter(f => f.calls > 0);
  const totalActiveSelfTime = executedFns.reduce((acc, f) => acc + (f.selfDurationMs || 0), 0);

  // 2. Critical Bottlenecks (Sorted by Self Time)
  const topSelf = [...executedFns]
    .sort((a, b) => b.selfDurationMs - a.selfDurationMs)
    .slice(0, topLimit);

  if (topSelf.length > 0) {
    lines.push('## Critical Bottlenecks (Top Self-Time)');
    lines.push(
      '> Note: Self-time excludes downstream child function calls and reflects where CPU cycles were directly consumed.'
    );
    lines.push('');

    topSelf.forEach((fn, idx) => {
      const selfPct = totalActiveSelfTime > 0
        ? ((fn.selfDurationMs / totalActiveSelfTime) * 100).toFixed(1)
        : '0.0';
      const loc = formatLocation(fn);
      const avg = fn.calls > 0 ? (fn.totalDurationMs / fn.calls) : 0;

      lines.push(`${idx + 1}. \`${fn.name}\` (\`${loc}\`)`);
      lines.push(
        `   - **Self Time**: ${formatDuration(fn.selfDurationMs)} (${selfPct}%) | **Total Time**: ${formatDuration(
          fn.totalDurationMs
        )} | **Calls**: ${formatNumber(fn.calls)} | **Avg**: ${formatDuration(avg)} | **Max**: ${formatDuration(
          fn.maxDurationMs
        )}`
      );

      // Automated Heuristic Diagnosis
      const diagnosis = [];
      if (fn.calls >= 100000) {
        diagnosis.push(
          `Extremely high frequency (${formatNumber(fn.calls)} invocations). Prime candidate for inlining, caching, or loop unrolling.`
        );
      } else if (fn.calls >= 10000) {
        diagnosis.push(
          `High invocation frequency (${formatNumber(fn.calls)} calls). Check for redundant evaluations or batching potential.`
        );
      }

      if (Number(selfPct) >= 40) {
        diagnosis.push(
          `Dominates application execution (${selfPct}% of active self-time). Primary target for algorithmic optimization.`
        );
      }

      if (fn.calls > 5 && fn.maxDurationMs > 50 * avg && fn.maxDurationMs > 1) {
        diagnosis.push(
          `Significant latency variance (max ${formatDuration(fn.maxDurationMs)} vs avg ${formatDuration(
            avg
          )}). Possible JIT de-optimization, garbage collection pause, or cold path.`
        );
      }

      if (fn.errors > 0) {
        diagnosis.push(`Triggered ${formatNumber(fn.errors)} runtime exception(s).`);
      }

      if (fn.totalDurationMs > 0 && (fn.selfDurationMs / fn.totalDurationMs) < 0.15 && fn.totalDurationMs > 10) {
        diagnosis.push(
          `Low self-time ratio (${((fn.selfDurationMs / fn.totalDurationMs) * 100).toFixed(1)}%). Most time is spent waiting on child calls.`
        );
      }

      if (diagnosis.length > 0) {
        lines.push(`   - **Diagnosis**: ${diagnosis.join(' ')}`);
      }
    });
    lines.push('');
  }

  // 3. High-Frequency Invocations (>1,000 calls)
  const highFreqFns = [...executedFns]
    .filter(f => f.calls >= 1000)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  if (highFreqFns.length > 0) {
    lines.push('## High-Frequency Invocations (Micro-Optimization Candidates)');
    for (const fn of highFreqFns) {
      const loc = formatLocation(fn);
      const avg = fn.calls > 0 ? (fn.totalDurationMs / fn.calls) : 0;
      lines.push(
        `- \`${fn.name}\` (\`${loc}\`): ${formatNumber(fn.calls)} calls (Total: ${formatDuration(
          fn.totalDurationMs
        )}, Self: ${formatDuration(fn.selfDurationMs)}, Avg: ${formatDuration(avg)})`
      );
    }
    lines.push('');
  }

  // 4. Hot Call Relationships
  if (summary.edges && summary.edges.length > 0) {
    const topEdges = summary.edges.slice(0, Math.min(topLimit, 8));
    lines.push('## Hot Call Paths');
    for (const e of topEdges) {
      lines.push(`- \`${e.callerName}\` -> \`${e.calleeName}\` (x${formatNumber(e.calls)})`);
    }
    lines.push('');
  }

  // 5. Untouched Functions (Dead Code / Unexercised Paths)
  const untouchedFns = (summary.functions || [])
    .filter(f => f.calls === 0)
    .slice(0, 10);

  if (untouchedFns.length > 0) {
    lines.push('## Untouched Code (0 runtime calls)');
    lines.push('> Discovered by AST analysis but never executed during this run:');
    for (const fn of untouchedFns) {
      lines.push(`- \`${fn.name}\` (\`${formatLocation(fn)}\`)`);
    }
    if (summary.functionsNeverExecuted > untouchedFns.length) {
      lines.push(`- *... and ${summary.functionsNeverExecuted - untouchedFns.length} more untouched function(s)*`);
    }
    lines.push('');
  }

  // 6. Actionable Directives for AI
  lines.push('## Actionable Directives for AI Agent');
  const directives = [];

  if (topSelf.length > 0) {
    const top1 = topSelf[0];
    const top1Pct = totalActiveSelfTime > 0
      ? ((top1.selfDurationMs / totalActiveSelfTime) * 100).toFixed(1)
      : '0.0';
    directives.push(
      `Prioritize optimizing \`${formatLocation(top1)}\` (\`${top1.name}\`), which consumes ${top1Pct}% of total measured self-time.`
    );
  }

  if (highFreqFns.length > 0 && highFreqFns[0].calls >= 10000) {
    const freq1 = highFreqFns[0];
    directives.push(
      `Investigate inlining or memoizing \`${formatLocation(freq1)}\` (\`${freq1.name}\`), called ${formatNumber(
        freq1.calls
      )} times.`
    );
  }

  if (summary.functionsNeverExecuted > 0) {
    directives.push(
      `Check why ${formatNumber(summary.functionsNeverExecuted)} function(s) were never executed; verify whether benchmark scenarios lack test cases for these paths.`
    );
  }

  const errorFns = executedFns.filter(f => f.errors > 0);
  if (errorFns.length > 0) {
    directives.push(
      `Address runtime errors in: ${errorFns.map(f => `\`${f.name}\` (${f.errors} errors)`).join(', ')}.`
    );
  }

  if (directives.length === 0) {
    directives.push('No critical performance bottlenecks or dead code detected.');
  }

  directives.forEach((d, idx) => {
    lines.push(`${idx + 1}. ${d}`);
  });
  lines.push('');

  return lines.join('\n');
}
