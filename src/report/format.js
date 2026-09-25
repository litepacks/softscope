import path from 'node:path';
import { renderCallTree } from './tree.js';

export function formatDuration(ms) {
  if (ms === undefined || ms === null || isNaN(ms)) return '0ms';
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  if (ms >= 10) {
    return `${Math.round(ms)}ms`;
  }
  if (ms >= 1) {
    return `${ms.toFixed(1)}ms`;
  }
  return `${ms.toFixed(2)}ms`;
}

export function formatNumber(n) {
  if (n === undefined || n === null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US');
}

export function formatPercent(p) {
  if (p === undefined || p === null || isNaN(p)) return '0.0%';
  return `${p.toFixed(1)}%`;
}

export function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
  return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBytesPerOp(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes === 0) return '0 B/op';
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (abs < 1024) {
    const formatted = abs < 10 && abs !== Math.round(abs) ? abs.toFixed(1) : Math.round(abs);
    return `${sign}${formatted} B/op`;
  }
  if (abs < 1024 * 1024) {
    return `${sign}${(abs / 1024).toFixed(1)} KB/op`;
  }
  return `${sign}${(abs / (1024 * 1024)).toFixed(1)} MB/op`;
}

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

function truncateString(str, maxLen, fromLeft = false) {
  const s = String(str);
  if (visibleLength(s) <= maxLen) return s;
  const stripped = stripAnsi(s);
  if (maxLen <= 1) return '…';
  if (fromLeft) {
    return '…' + stripped.slice(stripped.length - maxLen + 1);
  }
  return stripped.slice(0, maxLen - 1) + '…';
}

function padRight(str, len) {
  const vlen = visibleLength(str);
  if (vlen >= len) return String(str);
  return String(str) + ' '.repeat(len - vlen);
}

function padLeft(str, len) {
  const vlen = visibleLength(str);
  if (vlen >= len) return String(str);
  return ' '.repeat(len - vlen) + String(str);
}

export function renderTable({ columns, rows, maxTotalWidth }) {
  if (!rows || rows.length === 0) return '';

  const termWidth = maxTotalWidth || (process.stdout.columns ? Math.max(process.stdout.columns, 80) : 120);

  // Determine initial column widths
  const colWidths = columns.map(col => {
    let w = Math.max(visibleLength(col.label), col.minWidth || 4);
    for (const row of rows) {
      const val = row[col.key] != null ? String(row[col.key]) : '';
      w = Math.max(w, visibleLength(val));
    }
    if (col.maxWidth) {
      w = Math.min(w, col.maxWidth);
    }
    return w;
  });

  // Calculate borders width: │  │  │ ...
  const bordersWidth = 3 * (columns.length - 1) + 4;
  let totalWidth = colWidths.reduce((a, b) => a + b, 0) + bordersWidth;

  // Shrink elastic columns if table exceeds target width
  if (totalWidth > termWidth) {
    let excess = totalWidth - termWidth;
    for (let i = 0; i < columns.length && excess > 0; i++) {
      const col = columns[i];
      const min = col.minWidth || 6;
      if (colWidths[i] > min) {
        const shrink = Math.min(colWidths[i] - min, excess);
        colWidths[i] -= shrink;
        excess -= shrink;
      }
    }
  }

  const lines = [];

  // Top border: ┌───┬───┐
  lines.push('┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');

  // Header: │ Title │ Title │
  const headerCells = columns.map((col, i) => {
    const w = colWidths[i];
    const text = truncateString(col.label, w);
    return col.align === 'right' ? padLeft(text, w) : padRight(text, w);
  });
  lines.push('│ ' + headerCells.join(' │ ') + ' │');

  // Separator: ├───┼───┤
  lines.push('├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤');

  // Data rows
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const w = colWidths[i];
      const rawVal = row[col.key] != null ? String(row[col.key]) : '';
      const text = truncateString(rawVal, w, Boolean(col.truncateLeft));
      return col.align === 'right' ? padLeft(text, w) : padRight(text, w);
    });
    lines.push('│ ' + cells.join(' │ ') + ' │');
  }

  // Bottom border: └───┴───┘
  lines.push('└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');

  return lines.join('\n');
}

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

export function renderTerminalReport(summary, options = {}) {
  const topLimit = options.top || 10;
  const showFiles = Boolean(options.files);

  const lines = [];

  lines.push('Softscope report');
  lines.push('────────────────────────────────');
  lines.push('');

  // Overview box with clean 2-column card
  const leftCol = [
    `Duration              ${padLeft(formatDuration(summary.durationMs), 10)}`,
    `Files observed        ${padLeft(formatNumber(summary.filesObserved), 10)}`,
    `Functions discovered  ${padLeft(formatNumber(summary.functionsDiscovered), 10)}`,
    `Functions executed    ${padLeft(formatNumber(summary.functionsExecuted), 10)}`,
    `Function calls        ${padLeft(formatNumber(summary.totalFunctionCalls), 10)}`
  ];

  const rightCol = [
    `Runtime reach`,
    `Executed              ${padLeft(formatPercent(summary.runtimeReach.executedPercent), 10)}`,
    `Not executed          ${padLeft(formatPercent(summary.runtimeReach.notExecutedPercent), 10)}`,
    `Untouched funcs       ${padLeft(formatNumber(summary.functionsNeverExecuted), 10)}`,
    ''
  ];

  lines.push('┌─ Runtime ────────────────────────┬─ Runtime reach ────────────────────────┐');
  for (let i = 0; i < 5; i++) {
    const l = padRight(leftCol[i] || '', 32);
    const r = padRight(rightCol[i] || '', 38);
    lines.push(`│ ${l} │ ${r} │`);
  }
  lines.push('└──────────────────────────────────┴────────────────────────────────────────┘');
  lines.push('');

  const executedFns = summary.functions.filter(f => f.calls > 0);

  if (executedFns.length > 0) {
    // 1. Top total time Table
    const topTotal = [...executedFns]
      .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
      .slice(0, topLimit);

    lines.push('Top total time');
    const totalColumns = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 36 },
      { key: 'loc', label: 'Location', align: 'left', minWidth: 14, maxWidth: 28, truncateLeft: true },
      { key: 'calls', label: 'Calls', align: 'right', minWidth: 6 },
      { key: 'total', label: 'Total', align: 'right', minWidth: 9 },
      { key: 'self', label: 'Self', align: 'right', minWidth: 9 },
      { key: 'avg', label: 'Avg', align: 'right', minWidth: 9 },
      { key: 'max', label: 'Max', align: 'right', minWidth: 9 }
    ];

    const totalRows = topTotal.map(fn => ({
      name: fn.name,
      loc: formatLocation(fn),
      calls: formatNumber(fn.calls),
      total: formatDuration(fn.totalDurationMs),
      self: formatDuration(fn.selfDurationMs),
      avg: formatDuration(fn.avgDurationMs),
      max: formatDuration(fn.maxDurationMs)
    }));

    lines.push(renderTable({ columns: totalColumns, rows: totalRows }));
    lines.push('');

    // 2. Most called Table
    const mostCalled = [...executedFns]
      .sort((a, b) => b.calls - a.calls)
      .slice(0, topLimit);

    lines.push('Most called');
    const calledColumns = [
      { key: 'name', label: 'Function', align: 'left', minWidth: 16, maxWidth: 36 },
      { key: 'loc', label: 'Location', align: 'left', minWidth: 14, maxWidth: 28, truncateLeft: true },
      { key: 'calls', label: 'Calls', align: 'right', minWidth: 7 },
      { key: 'total', label: 'Total', align: 'right', minWidth: 9 },
      { key: 'self', label: 'Self', align: 'right', minWidth: 9 },
      { key: 'avg', label: 'Avg', align: 'right', minWidth: 9 }
    ];

    const calledRows = mostCalled.map(fn => ({
      name: fn.name,
      loc: formatLocation(fn),
      calls: formatNumber(fn.calls),
      total: formatDuration(fn.totalDurationMs),
      self: formatDuration(fn.selfDurationMs),
      avg: formatDuration(fn.avgDurationMs)
    }));

    lines.push(renderTable({ columns: calledColumns, rows: calledRows }));
    lines.push('');
  }

  // 3. Call hierarchy & relationships
  if (summary.edges && summary.edges.length > 0) {
    const callTree = renderCallTree(summary.edges, { color: true });
    if (callTree) {
      lines.push('Call hierarchy');
      lines.push(callTree);
      lines.push('');
    }

    const topEdges = summary.edges.slice(0, Math.min(topLimit, 10));
    lines.push('Call relationships');
    const edgeColumns = [
      { key: 'caller', label: 'Caller', align: 'left', minWidth: 20, maxWidth: 42 },
      { key: 'callee', label: 'Callee', align: 'left', minWidth: 20, maxWidth: 42 },
      { key: 'calls', label: 'Calls', align: 'right', minWidth: 8 }
    ];

    const edgeRows = topEdges.map(e => ({
      caller: e.callerName,
      callee: e.calleeName,
      calls: 'x' + formatNumber(e.calls)
    }));

    lines.push(renderTable({ columns: edgeColumns, rows: edgeRows }));
    lines.push('');
  }

  // 4. File-level summary Table
  if (showFiles && summary.files.length > 0) {
    lines.push('File-level summary');
    const fileColumns = [
      { key: 'file', label: 'File', align: 'left', minWidth: 24, maxWidth: 45, truncateLeft: true },
      { key: 'functions', label: 'functions', align: 'right', minWidth: 9 },
      { key: 'executed', label: 'executed', align: 'right', minWidth: 8 },
      { key: 'reach', label: 'reach', align: 'right', minWidth: 8 },
      { key: 'calls', label: 'calls', align: 'right', minWidth: 8 },
      { key: 'total', label: 'total', align: 'right', minWidth: 9 }
    ];

    const fileRows = summary.files.map(f => {
      let rel = f.file;
      try {
        rel = path.relative(process.cwd(), f.file) || f.file;
      } catch {
        // Keep as-is
      }
      const reach = f.functionsDiscovered > 0
        ? formatPercent((f.functionsExecuted / f.functionsDiscovered) * 100)
        : '0.0%';

      return {
        file: rel,
        functions: formatNumber(f.functionsDiscovered),
        executed: formatNumber(f.functionsExecuted),
        reach,
        calls: formatNumber(f.calls),
        total: formatDuration(f.totalTimeMs)
      };
    });

    lines.push(renderTable({ columns: fileColumns, rows: fileRows }));
    lines.push('');
  }

  return lines.join('\n');
}
