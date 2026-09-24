import { formatDuration, formatNumber, renderTable } from '../report/format.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

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

  const cliffsStr = results.totalCliffs > 0
    ? `${YELLOW}${results.totalCliffs} ⚠${RESET}`
    : `${GREEN}0 ✔${RESET}`;

  const crashesStr = results.totalCrashes > 0
    ? `${RED}${results.totalCrashes} 🔴${RESET}`
    : `${GREEN}0 ✔${RESET}`;

  lines.push('┌─ Auto-Benchmark & Robustness Overview ────────────────────────────────────┐');
  lines.push(`│ Target: ${results.targetFile.padEnd(28)} Iterations: ${formatNumber(results.iterations).padEnd(22)} │`);
  lines.push(`│ Functions Tested: ${String(fns.length).padEnd(18)} Total Throughput: ${(formatNumber(totalOps) + ' ops/s').padEnd(16)} │`);
  lines.push(`│ Latency Cliffs:   ${cliffsStr.padEnd(28)} Unhandled Crashes: ${crashesStr.padEnd(20)} │`);
  lines.push('└───────────────────────────────────────────────────────────────────────────┘');
  lines.push('');

  // 1. Throughput Table
  if (callableFns.length > 0) {
    lines.push(`${BOLD}Throughput & Latency${RESET}`);
    const cols = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 30 },
      { key: 'ops', label: 'Ops / sec', align: 'right', minWidth: 14 },
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
      }

      return {
        name: fn.name,
        ops: formatNumber(fn.opsPerSec) + ' /s',
        avg: formatDuration(fn.avgMs),
        min: formatDuration(fn.minMs),
        max: formatDuration(fn.maxMs),
        status: statusStr
      };
    });

    lines.push(renderTable({ columns: cols, rows }));
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

  return lines.join('\n');
}

/**
 * Markdown report formatted for CI / PR comments.
 */
export function renderAutoBenchMarkdownReport(results, options = {}) {
  const lines = [];

  lines.push('# Softscope Auto-Benchmark & Robustness Report');
  lines.push('');
  lines.push(`- **Target**: \`${results.targetFile}\``);
  lines.push(`- **Iterations**: ${formatNumber(results.iterations)} per function`);
  lines.push(`- **Crashes**: ${results.totalCrashes > 0 ? `🔴 ${results.totalCrashes}` : '🟢 0'}`);
  lines.push(`- **Latency Cliffs**: ${results.totalCliffs > 0 ? `⚠ ${results.totalCliffs}` : '🟢 0'}`);
  lines.push('');

  const callableFns = (results.functions || []).filter(f => f.status === 'ok');
  if (callableFns.length > 0) {
    lines.push('## Throughput & Latency');
    lines.push('');
    lines.push('| Function | Ops / sec | Avg Latency | Min | Max | Robustness |');
    lines.push('| :--- | :---: | :---: | :---: | :---: | :---: |');
    for (const fn of callableFns) {
      const robustness = (fn.crashes && fn.crashes.length > 0)
        ? `🔴 Crashes (${fn.crashes.length})`
        : (fn.cliffs && fn.cliffs.length > 0)
          ? `⚠ Cliffs (${fn.cliffs.length})`
          : '🟢 Stable';

      lines.push(`| \`${fn.name}\` | **${formatNumber(fn.opsPerSec)} /s** | ${formatDuration(fn.avgMs)} | ${formatDuration(fn.minMs)} | ${formatDuration(fn.maxMs)} | ${robustness} |`);
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

  lines.push('# Softscope AI Auto-Bench & Edge-Case Profile');
  lines.push(`TARGET: ${results.targetFile}`);
  lines.push(`TOTAL_CRASHES: ${results.totalCrashes}`);
  lines.push(`TOTAL_CLIFFS: ${results.totalCliffs}`);
  lines.push('');

  const callableFns = (results.functions || []).filter(f => f.status === 'ok');
  lines.push('## THROUGHPUT SUMMARY');
  for (const fn of callableFns) {
    lines.push(`- ${fn.name}: ${formatNumber(fn.opsPerSec)} ops/sec (avg: ${formatDuration(fn.avgMs)})`);
  }
  lines.push('');

  if (results.totalCrashes > 0) {
    lines.push('## CRITICAL BUGS (UNHANDLED CRASHES)');
    for (const fn of results.functions) {
      if (fn.crashes && fn.crashes.length > 0) {
        for (const c of fn.crashes) {
          lines.push(`- Function: \`${fn.name}\``);
          lines.push(`  Seed: ${formatSeedArgs(c.seed)} (${c.label})`);
          lines.push(`  Error: ${c.error}`);
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
  return JSON.stringify({
    version: 1,
    type: 'softscope-autobench',
    targetFile: results.targetFile,
    iterations: results.iterations,
    totalCrashes: results.totalCrashes,
    totalCliffs: results.totalCliffs,
    functions: results.functions
  }, null, 2);
}
