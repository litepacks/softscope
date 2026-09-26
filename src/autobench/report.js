import path from 'node:path';
import { formatDuration, formatNumber, formatBytesPerOp, renderTable } from '../report/format.js';
import { renderCallTree } from '../report/tree.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function padRightVisible(str, len) {
  const vlen = stripAnsi(str).length;
  if (vlen >= len) return String(str);
  return String(str) + ' '.repeat(len - vlen);
}

function formatSeedArgs(args) {
  if (!args || args.length === 0) return '()';
  return `(${args.map(a => {
    if (typeof a === 'string') return JSON.stringify(a.length > 25 ? a.slice(0, 22) + '…' : a);
    if (typeof a === 'number') return Number.isNaN(a) ? 'NaN' : String(a);
    if (Array.isArray(a)) return a.length === 0 ? '[]' : `[Array(${a.length})]`;
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    if (typeof a === 'object') return '{}';
    return String(a);
  }).join(', ')})`;
}

/**
 * Terminal report for auto-benchmarking and edge-case results.
 */
export function renderAutoBenchTerminalReport(results, options = {}) {
  const lines = [];

  const fns = results.functions || [];
  const callableFns = fns.filter(f => f.status === 'ok');
  const totalOps = callableFns.reduce((acc, f) => acc + (f.opsPerSec || 0), 0);
  const totalGcs = results.totalGcCycles != null
    ? results.totalGcCycles
    : callableFns.reduce((acc, f) => acc + (f.gcCount || 0), 0);
  const avgAlloc = results.avgBytesPerOp != null
    ? results.avgBytesPerOp
    : (callableFns.length > 0
      ? callableFns.reduce((acc, f) => acc + (f.bytesPerOp || 0), 0) / callableFns.length
      : 0);

  const cliffsStr = results.totalCliffs > 0
    ? `${YELLOW}${results.totalCliffs} ⚠${RESET}`
    : `${GREEN}0 ✔${RESET}`;

  const crashesStr = results.totalCrashes > 0
    ? `${RED}${results.totalCrashes} 🔴${RESET}`
    : `${GREEN}0 ✔${RESET}`;

  const gcStr = totalGcs > 0
    ? `${YELLOW}${totalGcs} ⚠${RESET}`
    : `${GREEN}0 ✔${RESET}`;

  const col1 = 'Target: ' + results.targetFile;
  const col2 = 'Iterations: ' + formatNumber(results.iterations);
  const col3 = 'Functions Tested: ' + String(fns.length);
  const col4 = 'Total Throughput: ' + formatNumber(totalOps) + ' ops/s';
  const col5 = 'Latency Cliffs:   ' + cliffsStr;
  const col6 = 'Unhandled Crashes: ' + crashesStr;
  const col7 = 'Avg Alloc/Op:     ' + formatBytesPerOp(avgAlloc);
  const col8 = 'Total GC Cycles:   ' + gcStr;

  lines.push('┌─ Auto-Benchmark & Robustness Overview ────────────────────────────────────┐');
  lines.push(`│ ${padRightVisible(col1, 38)}${padRightVisible(col2, 36)}│`);
  lines.push(`│ ${padRightVisible(col3, 38)}${padRightVisible(col4, 36)}│`);
  lines.push(`│ ${padRightVisible(col5, 38)}${padRightVisible(col6, 36)}│`);
  lines.push(`│ ${padRightVisible(col7, 38)}${padRightVisible(col8, 36)}│`);
  lines.push('└───────────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // 1. Throughput Table
  if (callableFns.length > 0) {
    lines.push(`${BOLD}Throughput & Latency${RESET}`);
    const cols = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 30 },
      { key: 'ops', label: 'Ops / sec', align: 'right', minWidth: 14 },
      { key: 'alloc', label: 'Alloc / op', align: 'right', minWidth: 11 },
      { key: 'avg', label: 'Avg Latency', align: 'right', minWidth: 11 },
      { key: 'min', label: 'Min', align: 'right', minWidth: 9 },
      { key: 'max', label: 'Max', align: 'right', minWidth: 9 },
      { key: 'status', label: 'Stability', align: 'left', minWidth: 14 }
    ];

    const rows = callableFns.map(fn => {
      let statusStr = `${GREEN}Stable${RESET}`;
      if (fn.crashes && fn.crashes.length > 0) {
        statusStr = `${RED}Crashes (${fn.crashes.length})${RESET}`;
      } else if (fn.cliffs && fn.cliffs.length > 0) {
        statusStr = `${YELLOW}Cliff (${fn.cliffs.length})${RESET}`;
      } else if (fn.gcCount && fn.gcCount > 0) {
        statusStr = `${YELLOW}GC (${fn.gcCount})${RESET}`;
      }

      let allocStr = `${GREEN}0 B/op${RESET}`;
      const bOp = fn.bytesPerOp || 0;
      if (bOp > 0) {
        if (bOp < 128) {
          allocStr = `${CYAN}${formatBytesPerOp(bOp)}${RESET}`;
        } else if (bOp < 1024) {
          allocStr = `${YELLOW}${formatBytesPerOp(bOp)}${RESET}`;
        } else {
          allocStr = `${RED}${formatBytesPerOp(bOp)}${RESET}`;
        }
      }

      return {
        name: fn.name,
        ops: formatNumber(fn.opsPerSec) + ' /s',
        alloc: allocStr,
        avg: formatDuration(fn.avgMs),
        min: formatDuration(fn.minMs),
        max: formatDuration(fn.maxMs),
        status: statusStr
      };
    });

    lines.push(renderTable({ columns: cols, rows }));
    lines.push('');
  }

  // Failed, Incompatible or Timed Out Functions
  const failedFns = fns.filter(f => f.status !== 'ok');
  if (failedFns.length > 0) {
    lines.push(`${BOLD}${RED}✖ Incompatible, Failed or Timed Out Functions (${failedFns.length}):${RESET}`);
    for (const f of failedFns) {
      const reason = f.status === 'timeout'
        ? (f.error || 'Execution Timed Out')
        : (f.error || f.status);
      lines.push(`  • ${BOLD}${f.name}${RESET}: ${RED}${reason}${RESET}`);
    }
    lines.push('');
  }

  // 2. Unhandled Crashes Breakdown
  if (results.totalCrashes > 0) {
    lines.push(`${BOLD}${RED}🔴 Unhandled Crashes Discovered:${RESET}`);
    for (const fn of fns) {
      if (fn.crashes && fn.crashes.length > 0) {
        lines.push(`  • ${BOLD}${fn.name}${RESET}:`);
        for (const c of fn.crashes) {
          lines.push(`    - Trigger: ${YELLOW}${formatSeedArgs(c.seed)}${RESET} (${c.label})`);
          lines.push(`      Error:   ${RED}${c.error}${RESET}`);
          if (c.file && c.line) {
            const relFile = path.relative(process.cwd(), c.file) || c.file;
            lines.push(`      Site:    ${CYAN}${relFile}:${c.line}:${c.column || 1}${RESET}`);
          }
          if (c.coloredCodeFrame) {
            lines.push('');
            lines.push(c.coloredCodeFrame);
            lines.push('');
          }
        }
      }
    }
    lines.push('');
  }

  // 3. Latency Cliffs Breakdown
  if (results.totalCliffs > 0) {
    lines.push(`${BOLD}${YELLOW}⚠ Latency Cliffs Discovered (>10x avg latency):${RESET}`);
    for (const fn of fns) {
      if (fn.cliffs && fn.cliffs.length > 0) {
        lines.push(`  • ${BOLD}${fn.name}${RESET} (Avg: ${formatDuration(fn.avgMs)}):`);
        for (const cl of fn.cliffs) {
          lines.push(`    - Trigger: ${formatSeedArgs(cl.seed)} (${cl.label})`);
          lines.push(`      Spike:   ${YELLOW}${formatDuration(cl.durationMs)} (${cl.factor}x slower)${RESET}`);
        }
      }
    }
    lines.push('');
  }

  // 4. Call Relationships & Hierarchy
  if (results.callEdges && results.callEdges.length > 0) {
    const rootNames = fns.map(f => f.name || f.exportName);
    const treeStr = renderCallTree(results.callEdges, { rootNames, color: true });
    if (treeStr) {
      lines.push(`${BOLD}Call Hierarchy (Tree)${RESET}`);
      lines.push(treeStr);
      lines.push('');
    }

    const topEdges = [...results.callEdges]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, Math.max(10, options.top || 10));

    lines.push(`${BOLD}Call Invocations Summary${RESET}`);
    const edgeColumns = [
      { key: 'caller', label: 'Caller', align: 'left', minWidth: 20, maxWidth: 36 },
      { key: 'callee', label: 'Callee', align: 'left', minWidth: 20, maxWidth: 36 },
      { key: 'calls', label: 'Calls', align: 'right', minWidth: 10 }
    ];

    const edgeRows = topEdges.map(e => ({
      caller: e.callerName,
      callee: e.calleeName,
      calls: 'x' + formatNumber(e.calls)
    }));

    lines.push(renderTable({ columns: edgeColumns, rows: edgeRows }));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Markdown report formatted for CI / PR comments.
 */
export function renderAutoBenchMarkdownReport(results, options = {}) {
  const lines = [];

  const callableFns = (results.functions || []).filter(f => f.status === 'ok');
  const totalGcs = results.totalGcCycles != null
    ? results.totalGcCycles
    : callableFns.reduce((acc, f) => acc + (f.gcCount || 0), 0);
  const avgAlloc = results.avgBytesPerOp != null
    ? results.avgBytesPerOp
    : (callableFns.length > 0
      ? callableFns.reduce((acc, f) => acc + (f.bytesPerOp || 0), 0) / callableFns.length
      : 0);

  lines.push('# Softscope Auto-Benchmark & Robustness Report');
  lines.push('');
  lines.push(`- **Target**: \`${results.targetFile}\``);
  lines.push(`- **Iterations**: ${formatNumber(results.iterations)} per function`);
  lines.push(`- **Avg Alloc/Op**: ${formatBytesPerOp(avgAlloc)}`);
  lines.push(`- **Total GC Cycles**: ${totalGcs}`);
  lines.push(`- **Crashes**: ${results.totalCrashes > 0 ? `🔴 ${results.totalCrashes}` : '🟢 0'}`);
  lines.push(`- **Latency Cliffs**: ${results.totalCliffs > 0 ? `⚠ ${results.totalCliffs}` : '🟢 0'}`);
  lines.push('');

  if (callableFns.length > 0) {
    lines.push('## Throughput & Latency');
    lines.push('');
    lines.push('| Function | Ops / sec | Alloc / op | Avg Latency | Min | Max | Robustness |');
    lines.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');
    for (const fn of callableFns) {
      const robustness = (fn.crashes && fn.crashes.length > 0)
        ? `🔴 Crashes (${fn.crashes.length})`
        : (fn.cliffs && fn.cliffs.length > 0)
          ? `⚠ Cliffs (${fn.cliffs.length})`
          : (fn.gcCount && fn.gcCount > 0)
            ? `⚠ GC (${fn.gcCount})`
            : '🟢 Stable';

      lines.push(`| \`${fn.name}\` | **${formatNumber(fn.opsPerSec)} /s** | ${formatBytesPerOp(fn.bytesPerOp)} | ${formatDuration(fn.avgMs)} | ${formatDuration(fn.minMs)} | ${formatDuration(fn.maxMs)} | ${robustness} |`);
    }
    lines.push('');
  }

  const failedFns = (results.functions || []).filter(f => f.status !== 'ok');
  if (failedFns.length > 0) {
    lines.push(`### ✖ Failed or Timed Out Functions (${failedFns.length})`);
    lines.push('');
    for (const fn of failedFns) {
      const reason = fn.status === 'timeout'
        ? (fn.error || 'Execution Timed Out')
        : (fn.error || fn.status);
      lines.push(`- **\`${fn.name}\`**: ${reason}`);
    }
    lines.push('');
  }

  if (results.callEdges && results.callEdges.length > 0) {
    const rootNames = (results.functions || []).map(f => f.name || f.exportName);
    const treeStr = renderCallTree(results.callEdges, { rootNames, color: false });
    if (treeStr) {
      lines.push('## Call Hierarchy');
      lines.push('');
      lines.push('```text');
      lines.push(treeStr);
      lines.push('```');
      lines.push('');
    }

    const topEdges = [...results.callEdges]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, Math.max(10, options.top || 10));

    lines.push('## Call Relationships (Internal Invocations)');
    lines.push('');
    lines.push('| Caller | Callee | Calls |');
    lines.push('| :--- | :--- | :---: |');
    for (const e of topEdges) {
      lines.push(`| \`${e.callerName}\` | \`${e.calleeName}\` | x${formatNumber(e.calls)} |`);
    }
    lines.push('');
  }

  if (results.totalCrashes > 0) {
    lines.push('## 🔴 Unhandled Crashes');
    lines.push('');
    for (const fn of results.functions) {
      if (fn.crashes && fn.crashes.length > 0) {
        lines.push(`### \`${fn.name}\``);
        lines.push('| Triggering Seed | Hazard Label | Exception |');
        lines.push('| :--- | :--- | :--- |');
        for (const c of fn.crashes) {
          lines.push(`| \`${formatSeedArgs(c.seed)}\` | ${c.label} | \`${c.error}\` |`);
          if (c.codeFrame) {
            lines.push('');
            const locStr = c.file && c.line ? `**Site**: \`${path.relative(process.cwd(), c.file) || c.file}:${c.line}:${c.column || 1}\`\n\n` : '';
            lines.push(locStr + '```javascript\n' + c.codeFrame + '\n```\n');
          }
        }
        lines.push('');
      }
    }
  }

  if (results.totalCliffs > 0) {
    lines.push('## ⚠ Latency Cliffs');
    lines.push('');
    for (const fn of results.functions) {
      if (fn.cliffs && fn.cliffs.length > 0) {
        lines.push(`### \`${fn.name}\` (Baseline Avg: ${formatDuration(fn.avgMs)})`);
        lines.push('| Triggering Seed | Spike Duration | Multiplier | Hazard Label |');
        lines.push('| :--- | :---: | :---: | :--- |');
        for (const cl of fn.cliffs) {
          lines.push(`| \`${formatSeedArgs(cl.seed)}\` | **${formatDuration(cl.durationMs)}** | **${cl.factor}x** | ${cl.label} |`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Token-efficient AI/LLM diagnostic profile.
 */
export function renderAutoBenchAiReport(results, options = {}) {
  const lines = [];

  const callableFns = (results.functions || []).filter(f => f.status === 'ok');
  const totalGcs = results.totalGcCycles != null
    ? results.totalGcCycles
    : callableFns.reduce((acc, f) => acc + (f.gcCount || 0), 0);
  const avgAlloc = results.avgBytesPerOp != null
    ? results.avgBytesPerOp
    : (callableFns.length > 0
      ? callableFns.reduce((acc, f) => acc + (f.bytesPerOp || 0), 0) / callableFns.length
      : 0);

  lines.push('# Softscope AI Auto-Bench & Edge-Case Profile');
  lines.push(`TARGET: ${results.targetFile}`);
  lines.push(`TOTAL_CRASHES: ${results.totalCrashes}`);
  lines.push(`TOTAL_CLIFFS: ${results.totalCliffs}`);
  lines.push(`TOTAL_GC_CYCLES: ${totalGcs}`);
  lines.push(`AVG_ALLOC_PER_OP: ${formatBytesPerOp(avgAlloc)}`);
  lines.push('');

  lines.push('## THROUGHPUT SUMMARY');
  for (const fn of callableFns) {
    lines.push(`- ${fn.name}: ${formatNumber(fn.opsPerSec)} ops/sec (alloc: ${formatBytesPerOp(fn.bytesPerOp)}, avg: ${formatDuration(fn.avgMs)})`);
  }
  lines.push('');

  const highAllocFns = callableFns.filter(f => (f.bytesPerOp && f.bytesPerOp >= 128) || (f.gcCount && f.gcCount > 0));
  if (highAllocFns.length > 0) {
    lines.push('## MEMORY & GC ALLOCATION HAZARDS');
    for (const fn of highAllocFns) {
      lines.push(`- Function: \`${fn.name}\``);
      lines.push(`  Allocations: ${formatBytesPerOp(fn.bytesPerOp)} per op`);
      if (fn.gcCount > 0) {
        lines.push(`  GC Overhead: ${fn.gcCount} GC pauses (${fn.gcTimeMs}ms)`);
      }
      lines.push(`  Action: Optimize memory allocations or reuse buffers/objects in \`${fn.name}\` to reduce GC pressure.`);
    }
    lines.push('');
  }

  if (results.callEdges && results.callEdges.length > 0) {
    const rootNames = (results.functions || []).map(f => f.name || f.exportName);
    const treeStr = renderCallTree(results.callEdges, { rootNames, color: false });
    if (treeStr) {
      lines.push('## CALL HIERARCHY');
      lines.push(treeStr);
      lines.push('');
    }

    lines.push('## INTERNAL CALL RELATIONSHIPS');
    for (const e of results.callEdges) {
      lines.push(`- \`${e.callerName}\` -> \`${e.calleeName}\` (x${formatNumber(e.calls)})`);
    }
    lines.push('');
  }

  if (results.totalCrashes > 0) {
    lines.push('## CRITICAL BUGS (UNHANDLED CRASHES)');
    for (const fn of results.functions) {
      if (fn.crashes && fn.crashes.length > 0) {
        for (const c of fn.crashes) {
          lines.push(`- Function: \`${fn.name}\``);
          lines.push(`  Seed: ${formatSeedArgs(c.seed)} (${c.label})`);
          lines.push(`  Error: ${c.error}`);
          if (c.file && c.line) {
            const relFile = path.relative(process.cwd(), c.file) || c.file;
            lines.push(`  Location: ${relFile}:${c.line}:${c.column || 1}`);
          }
          if (c.codeFrame) {
            lines.push('  Code Frame:');
            lines.push(c.codeFrame.split('\n').map(l => '    ' + l).join('\n'));
          }
          lines.push(`  Action: Add boundary validation / guard clause in \`${fn.name}\` for ${c.label}.`);
        }
      }
    }
    lines.push('');
  }

  if (results.totalCliffs > 0) {
    lines.push('## PERFORMANCE DEFECTS (LATENCY CLIFFS)');
    for (const fn of results.functions) {
      if (fn.cliffs && fn.cliffs.length > 0) {
        for (const cl of fn.cliffs) {
          lines.push(`- Function: \`${fn.name}\``);
          lines.push(`  Baseline Avg: ${formatDuration(cl.avgMs)} -> Cliff: ${formatDuration(cl.durationMs)} (${cl.factor}x degradation)`);
          lines.push(`  Trigger: ${formatSeedArgs(cl.seed)} (${cl.label})`);
          lines.push(`  Action: Inspect loop boundaries, string concatenation, or regex complexity in \`${fn.name}\`.`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Versioned JSON output.
 */
export function renderAutoBenchJsonReport(results) {
  const callableFns = (results.functions || []).filter(f => f.status === 'ok');
  const totalGcs = results.totalGcCycles != null
    ? results.totalGcCycles
    : callableFns.reduce((acc, f) => acc + (f.gcCount || 0), 0);
  const avgAlloc = results.avgBytesPerOp != null
    ? results.avgBytesPerOp
    : (callableFns.length > 0
      ? callableFns.reduce((acc, f) => acc + (f.bytesPerOp || 0), 0) / callableFns.length
      : 0);

  return JSON.stringify({
    version: 1,
    type: 'softscope-autobench',
    targetFile: results.targetFile,
    iterations: results.iterations,
    totalCrashes: results.totalCrashes,
    totalCliffs: results.totalCliffs,
    totalGcCycles: totalGcs,
    avgBytesPerOp: Math.round(avgAlloc * 10) / 10,
    functions: results.functions,
    callEdges: results.callEdges || []
  }, null, 2);
}
