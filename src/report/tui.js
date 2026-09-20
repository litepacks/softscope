import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { formatDuration, formatNumber, formatPercent } from './format.js';
import { renderMarkdownReport } from './markdown.js';

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function visibleLength(str) {
  return stripAnsi(str).length;
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

function truncate(str, maxLen) {
  const s = String(str);
  if (visibleLength(s) <= maxLen) return s;
  if (maxLen <= 3) return '...'.slice(0, maxLen);
  return s.slice(0, maxLen - 1) + '…';
}

function formatLocation(fn) {
  if (!fn || !fn.file) return '-';
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

export function createTui(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stdin = options.stdin || process.stdin;
  const isTTY = Boolean(stdout.isTTY && stdin.isTTY);

  // State
  const state = {
    status: 'running', // 'running' | 'completed'
    targetCommand: options.targetCommand || 'target process',
    pid: null,
    exitCode: 0,
    startTime: Date.now(),
    durationMs: 0,
    activeTab: 0, // 0: Overview, 1: Functions, 2: Call Graph, 3: Files, 4: Logs
    scrollOffsets: [0, 0, 0, 0, 0],
    selectedIndices: [0, 0, 0, 0, 0],
    sortBy: 'total', // 'total' | 'self' | 'calls' | 'avg'
    sortDirection: 'desc',
    logs: [],
    maxLogs: 200,
    liveStats: null,
    summary: null,
    selectedFunction: null,
    toastMessage: null,
    toastTimer: null,
    renderTimer: null,
    isClosed: false
  };

  const TABS = [
    { id: 'overview', title: '1. Overview' },
    { id: 'functions', title: '2. Functions' },
    { id: 'graph', title: '3. Call Graph' },
    { id: 'files', title: '4. Files' },
    { id: 'logs', title: '5. Logs' }
  ];

  let onExitCallback = null;
  let onAbortCallback = null;

  function showToast(msg, durationMs = 2500) {
    state.toastMessage = msg;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      state.toastMessage = null;
      render();
    }, durationMs);
    render();
  }

  function appendLog(chunk, stream = 'stdout') {
    const text = String(chunk);
    const lines = text.split('\n');
    for (const l of lines) {
      if (!l.trim() && lines.length === 1) continue;
      const prefix = stream === 'stderr' ? '\x1b[33m[err]\x1b[0m ' : '';
      state.logs.push(prefix + l);
      if (state.logs.length > state.maxLogs) {
        state.logs.shift();
      }
    }
    // Auto-scroll logs tab to bottom
    if (state.activeTab === 4) {
      render();
    }
  }

  function update(heartbeat) {
    state.liveStats = heartbeat;
    if (heartbeat.pid && !state.pid) {
      state.pid = heartbeat.pid;
    }
    render();
  }

  function finish(summary, exitCode = 0) {
    state.status = 'completed';
    state.summary = summary;
    state.exitCode = exitCode;
    state.durationMs = summary ? summary.durationMs : Date.now() - state.startTime;
    render();
  }

  function getSortedFunctions() {
    const list = state.summary
      ? state.summary.functions
      : (state.liveStats && state.liveStats.hot ? state.liveStats.hot : []);

    const fns = [...list];
    fns.sort((a, b) => {
      let valA = 0;
      let valB = 0;
      if (state.sortBy === 'total') {
        valA = a.totalDurationMs || 0;
        valB = b.totalDurationMs || 0;
      } else if (state.sortBy === 'self') {
        valA = a.selfDurationMs || 0;
        valB = b.selfDurationMs || 0;
      } else if (state.sortBy === 'calls') {
        valA = a.calls || 0;
        valB = b.calls || 0;
      } else if (state.sortBy === 'avg') {
        valA = a.avgDurationMs || 0;
        valB = b.avgDurationMs || 0;
      }
      return state.sortDirection === 'desc' ? valB - valA : valA - valB;
    });
    return fns;
  }

  function cycleSort() {
    const orders = ['total', 'self', 'calls', 'avg'];
    const idx = orders.indexOf(state.sortBy);
    state.sortBy = orders[(idx + 1) % orders.length];
    showToast(`Sorted by ${state.sortBy.toUpperCase()}`);
    render();
  }

  function exportMarkdown() {
    if (!state.summary) {
      showToast('No final summary data yet to export.');
      return;
    }
    try {
      const md = renderMarkdownReport(state.summary, { files: true });
      const outPath = path.resolve(process.cwd(), 'softscope-report.md');
      fs.writeFileSync(outPath, md, 'utf-8');
      showToast(`Exported report to ${path.basename(outPath)}!`);
    } catch (err) {
      showToast(`Export failed: ${err.message}`);
    }
  }

  // --- Keyboard Handler ---
  function handleKeypress(str, key) {
    if (state.isClosed) return;

    if ((key && key.ctrl && key.name === 'c') || str === 'q' || (key && key.name === 'escape')) {
      if (state.selectedFunction) {
        state.selectedFunction = null;
        render();
        return;
      }
      if (state.status === 'running') {
        if (onAbortCallback) onAbortCallback();
      }
      close();
      return;
    }

    // Number keys 1..5 for direct tab selection
    if (str >= '1' && str <= '5') {
      state.activeTab = parseInt(str, 10) - 1;
      state.selectedFunction = null;
      render();
      return;
    }

    if (key && key.name === 'tab') {
      if (key.shift) {
        state.activeTab = (state.activeTab + TABS.length - 1) % TABS.length;
      } else {
        state.activeTab = (state.activeTab + 1) % TABS.length;
      }
      state.selectedFunction = null;
      render();
      return;
    }

    // Sort toggle on functions tab
    if (str === 's' || str === 'S') {
      cycleSort();
      return;
    }

    // Export markdown
    if (str === 'm' || str === 'M') {
      exportMarkdown();
      return;
    }

    // Arrow keys & vim navigation (k=up, j=down)
    if (key && (key.name === 'up' || str === 'k')) {
      navigate(-1);
      return;
    }

    if (key && (key.name === 'down' || str === 'j')) {
      navigate(1);
      return;
    }

    if (key && key.name === 'pageup') {
      navigate(-10);
      return;
    }

    if (key && key.name === 'pagedown') {
      navigate(10);
      return;
    }

    // Enter to inspect function details
    if (key && (key.name === 'return' || key.name === 'enter')) {
      if (state.selectedFunction) {
        state.selectedFunction = null;
      } else if (state.activeTab === 1) {
        const fns = getSortedFunctions();
        const selIdx = state.selectedIndices[1];
        if (fns[selIdx]) {
          state.selectedFunction = fns[selIdx];
        }
      }
      render();
      return;
    }
  }

  function navigate(delta) {
    const tab = state.activeTab;
    let max = 0;
    if (tab === 1) {
      max = Math.max(0, getSortedFunctions().length - 1);
    } else if (tab === 2) {
      max = Math.max(0, (state.summary ? state.summary.edges.length : 0) - 1);
    } else if (tab === 3) {
      max = Math.max(0, (state.summary ? state.summary.files.length : 0) - 1);
    } else if (tab === 4) {
      max = Math.max(0, state.logs.length - 1);
    }

    const newIdx = Math.max(0, Math.min(max, state.selectedIndices[tab] + delta));
    state.selectedIndices[tab] = newIdx;
    render();
  }

  // --- Rendering Engine ---
  function render() {
    if (!isTTY || state.isClosed) return;

    const termWidth = stdout.columns || 100;
    const termHeight = stdout.rows || 30;

    const lines = [];

    // 1. Top Header Box
    const elapsedMs = state.status === 'running'
      ? Date.now() - state.startTime
      : state.durationMs;

    const statusBadge = state.status === 'running'
      ? '\x1b[1;32m● RUNNING\x1b[0m'
      : (state.exitCode === 0
          ? '\x1b[1;36m✔ COMPLETED\x1b[0m'
          : `\x1b[1;31m✖ EXITED (${state.exitCode})\x1b[0m`);

    const totalCalls = state.summary
      ? state.summary.totalFunctionCalls
      : (state.liveStats ? state.liveStats.totalCalls : 0);

    const titleLeft = ` Softscope Profiler `;
    const headerBorder = '┌─' + titleLeft + '─'.repeat(Math.max(2, termWidth - titleLeft.length - 4)) + '┐';
    lines.push(headerBorder);

    const infoLine = ` Target: \x1b[1m${truncate(state.targetCommand, 28)}\x1b[0m | Status: ${statusBadge} | Time: \x1b[36m${formatDuration(elapsedMs)}\x1b[0m | Calls: \x1b[33m${formatNumber(totalCalls)}\x1b[0m`;
    lines.push('│ ' + padRight(infoLine, termWidth - 4) + ' │');
    lines.push('├' + '─'.repeat(termWidth - 2) + '┤');

    // 2. Tab Navigation Bar
    const tabHeaders = TABS.map((t, idx) => {
      if (idx === state.activeTab) {
        return `\x1b[7;1m ${t.title} \x1b[0m`;
      }
      return `\x1b[2m ${t.title} \x1b[0m`;
    }).join(' ');

    lines.push('│ ' + padRight(tabHeaders, termWidth - 4) + ' │');
    lines.push('├' + '─'.repeat(termWidth - 2) + '┤');

    // 3. Tab Content Area
    const contentHeight = Math.max(6, termHeight - 8);
    const contentLines = renderTabContent(state.activeTab, termWidth - 4, contentHeight);

    for (let i = 0; i < contentHeight; i++) {
      const line = contentLines[i] || '';
      lines.push('│ ' + padRight(line, termWidth - 4) + ' │');
    }

    // 4. Toast Message / Notification Bar
    lines.push('├' + '─'.repeat(termWidth - 2) + '┤');
    if (state.toastMessage) {
      lines.push('│ ' + padRight(`\x1b[1;33mℹ ${state.toastMessage}\x1b[0m`, termWidth - 4) + ' │');
    } else {
      const footerHelp = `\x1b[2m[1-5/Tab] Switch Tab  [↑/↓/k/j] Scroll  [s] Sort (${state.sortBy})  [m] Export MD  [Enter] Details  [q] Quit\x1b[0m`;
      lines.push('│ ' + padRight(footerHelp, termWidth - 4) + ' │');
    }
    lines.push('└' + '─'.repeat(termWidth - 2) + '┘');

    // Render frame to alternate screen in a single write
    stdout.write('\x1b[H' + lines.slice(0, termHeight).join('\n'));
  }

  function renderTabContent(tabIdx, width, height) {
    switch (tabIdx) {
      case 0: return renderOverviewTab(width, height);
      case 1: return renderFunctionsTab(width, height);
      case 2: return renderGraphTab(width, height);
      case 3: return renderFilesTab(width, height);
      case 4: return renderLogsTab(width, height);
      default: return [];
    }
  }

  function renderOverviewTab(width, height) {
    const out = [];
    const stats = state.summary || state.liveStats || {};
    const filesCount = stats.filesObserved || (stats.files ? stats.files.length : 0);
    const discCount = stats.functionsDiscovered || 0;
    const execCount = stats.functionsExecuted || 0;
    const callsCount = stats.totalFunctionCalls || stats.totalCalls || 0;
    const reach = stats.runtimeReach || { executedPercent: 0, notExecutedPercent: 0 };

    out.push('\x1b[1;36m▶ Runtime Metrics\x1b[0m');
    out.push(`  Duration:              \x1b[1m${formatDuration(stats.durationMs || (Date.now() - state.startTime))}\x1b[0m`);
    out.push(`  Observed Files:        \x1b[1m${formatNumber(filesCount)}\x1b[0m`);
    out.push(`  Discovered Functions:  \x1b[1m${formatNumber(discCount)}\x1b[0m`);
    out.push(`  Executed Functions:    \x1b[1m${formatNumber(execCount)}\x1b[0m`);
    out.push(`  Total Function Calls:  \x1b[1m${formatNumber(callsCount)}\x1b[0m`);
    out.push('');

    // Reach Gauge
    out.push('\x1b[1;36m▶ Runtime Reach\x1b[0m');
    const barWidth = Math.min(36, Math.max(10, width - 40));
    const filled = Math.round((reach.executedPercent / 100) * barWidth);
    const empty = Math.max(0, barWidth - filled);
    const progressBar = `\x1b[32m${'█'.repeat(filled)}\x1b[2m${'░'.repeat(empty)}\x1b[0m`;
    const untouched = stats.functionsNeverExecuted ?? Math.max(0, discCount - execCount);
    out.push(`  Coverage: [${progressBar}] \x1b[1m${formatPercent(reach.executedPercent)}\x1b[0m (${untouched} untouched)`);
    out.push('');

    // Quick Hot Functions preview
    const hotList = (state.summary ? state.summary.functions : (state.liveStats ? state.liveStats.hot : [])) || [];
    out.push('\x1b[1;36m▶ Top Hot Functions\x1b[0m');
    if (hotList.length === 0) {
      out.push('  \x1b[2m(No function calls recorded yet)\x1b[0m');
    } else {
      for (const fn of hotList.slice(0, Math.max(2, height - out.length - 1))) {
        const name = padRight(truncate(fn.name, 28), 30);
        const calls = padLeft(formatNumber(fn.calls) + ' calls', 14);
        const dur = fn.totalDurationMs != null ? ` \x1b[36m(${formatDuration(fn.totalDurationMs)})\x1b[0m` : '';
        out.push(`  • ${name} ${calls}${dur}`);
      }
    }

    return out;
  }

  function renderFunctionsTab(width, height) {
    const fns = getSortedFunctions();
    const out = [];

    // Header line
    const sortIndicator = (col) => state.sortBy === col ? (state.sortDirection === 'desc' ? ' ▼' : ' ▲') : '';
    const hFunction = padRight('Function', 26);
    const hLoc = padRight('Location', 22);
    const hCalls = padLeft('Calls' + sortIndicator('calls'), 10);
    const hTotal = padLeft('Total' + sortIndicator('total'), 10);
    const hSelf = padLeft('Self' + sortIndicator('self'), 10);
    const hAvg = padLeft('Avg' + sortIndicator('avg'), 9);

    out.push(`\x1b[1;37m  ${hFunction} ${hLoc} ${hCalls} ${hTotal} ${hSelf} ${hAvg}\x1b[0m`);
    out.push(`\x1b[2m  ${'─'.repeat(width - 4)}\x1b[0m`);

    if (fns.length === 0) {
      out.push('  \x1b[2mNo function execution data available.\x1b[0m');
      return out;
    }

    const visibleRows = Math.max(1, height - 3);
    const selIdx = state.selectedIndices[1];
    let offset = state.scrollOffsets[1];

    if (selIdx < offset) offset = selIdx;
    if (selIdx >= offset + visibleRows) offset = selIdx - visibleRows + 1;
    state.scrollOffsets[1] = offset;

    for (let i = offset; i < Math.min(fns.length, offset + visibleRows); i++) {
      const fn = fns[i];
      const isSelected = i === selIdx;
      const marker = isSelected ? '\x1b[1;36m>\x1b[0m' : ' ';
      const cName = padRight(truncate(fn.name, 26), 26);
      const cLoc = padRight(truncate(formatLocation(fn), 22), 22);
      const cCalls = padLeft(formatNumber(fn.calls), 10);
      const cTotal = padLeft(formatDuration(fn.totalDurationMs), 10);
      const cSelf = padLeft(formatDuration(fn.selfDurationMs), 10);
      const cAvg = padLeft(formatDuration(fn.avgDurationMs), 9);

      const rowStr = `${marker} ${cName} ${cLoc} ${cCalls} ${cTotal} ${cSelf} ${cAvg}`;
      out.push(isSelected ? `\x1b[7m${rowStr}\x1b[0m` : rowStr);
    }

    // Modal overlay if a function was selected with Enter
    if (state.selectedFunction) {
      return renderFunctionModal(state.selectedFunction, width, height);
    }

    return out;
  }

  function renderFunctionModal(fn, width, height) {
    const out = [];
    out.push(`\x1b[1;36m┌── Function Details: ${fn.name} ─────────────────────┐\x1b[0m`);
    out.push(`│ File:          \x1b[1m${formatLocation(fn)}\x1b[0m`);
    out.push(`│ Calls:         \x1b[1m${formatNumber(fn.calls)}\x1b[0m`);
    out.push(`│ Total Time:    \x1b[1m${formatDuration(fn.totalDurationMs)}\x1b[0m`);
    out.push(`│ Self Time:     \x1b[1m${formatDuration(fn.selfDurationMs)}\x1b[0m`);
    out.push(`│ Avg Latency:   \x1b[1m${formatDuration(fn.avgDurationMs)}\x1b[0m`);
    out.push(`│ Min Latency:   \x1b[1m${formatDuration(fn.minDurationMs)}\x1b[0m`);
    out.push(`│ Max Latency:   \x1b[1m${formatDuration(fn.maxDurationMs)}\x1b[0m`);
    out.push(`│ Errors:        \x1b[1m${formatNumber(fn.errors || 0)}\x1b[0m`);
    out.push(`│ Concurrency:   \x1b[1m${formatNumber(fn.maxConcurrent || 0)}\x1b[0m`);
    out.push(`\x1b[1;36m└────────────────────────────────────────────────────────┘\x1b[0m`);
    out.push(`\x1b[2m(Press [Enter] or [Esc] to close modal)\x1b[0m`);
    return out;
  }

  function renderGraphTab(width, height) {
    const out = [];
    const edges = state.summary ? state.summary.edges : [];

    out.push(`\x1b[1;37m  ${padRight('Caller', 34)} ${padRight('Callee', 34)} ${padLeft('Calls', 12)}\x1b[0m`);
    out.push(`\x1b[2m  ${'─'.repeat(width - 4)}\x1b[0m`);

    if (!edges || edges.length === 0) {
      out.push('  \x1b[2mNo dynamic call relationships discovered.\x1b[0m');
      return out;
    }

    const visibleRows = Math.max(1, height - 3);
    const selIdx = state.selectedIndices[2];
    let offset = state.scrollOffsets[2];

    if (selIdx < offset) offset = selIdx;
    if (selIdx >= offset + visibleRows) offset = selIdx - visibleRows + 1;
    state.scrollOffsets[2] = offset;

    for (let i = offset; i < Math.min(edges.length, offset + visibleRows); i++) {
      const e = edges[i];
      const isSelected = i === selIdx;
      const marker = isSelected ? '\x1b[1;36m>\x1b[0m' : ' ';
      const cCaller = padRight(truncate(e.callerName, 34), 34);
      const cCallee = padRight(truncate(e.calleeName, 34), 34);
      const cCalls = padLeft('x' + formatNumber(e.calls), 12);
      const rowStr = `${marker} ${cCaller} ${cCallee} ${cCalls}`;
      out.push(isSelected ? `\x1b[7m${rowStr}\x1b[0m` : rowStr);
    }
    return out;
  }

  function renderFilesTab(width, height) {
    const out = [];
    const files = state.summary ? state.summary.files : [];

    out.push(`\x1b[1;37m  ${padRight('File', 38)} ${padLeft('Funcs', 8)} ${padLeft('Exec', 8)} ${padLeft('Reach', 8)} ${padLeft('Calls', 10)} ${padLeft('Total', 10)}\x1b[0m`);
    out.push(`\x1b[2m  ${'─'.repeat(width - 4)}\x1b[0m`);

    if (!files || files.length === 0) {
      out.push('  \x1b[2mNo file metrics available.\x1b[0m');
      return out;
    }

    const visibleRows = Math.max(1, height - 3);
    const selIdx = state.selectedIndices[3];
    let offset = state.scrollOffsets[3];

    if (selIdx < offset) offset = selIdx;
    if (selIdx >= offset + visibleRows) offset = selIdx - visibleRows + 1;
    state.scrollOffsets[3] = offset;

    for (let i = offset; i < Math.min(files.length, offset + visibleRows); i++) {
      const f = files[i];
      const isSelected = i === selIdx;
      const marker = isSelected ? '\x1b[1;36m>\x1b[0m' : ' ';
      let rel = f.file;
      try {
        rel = path.relative(process.cwd(), f.file) || f.file;
      } catch {}
      const cFile = padRight(truncate(rel, 38), 38);
      const cDisc = padLeft(formatNumber(f.functionsDiscovered), 8);
      const cExec = padLeft(formatNumber(f.functionsExecuted), 8);
      const reachPct = f.functionsDiscovered > 0
        ? formatPercent((f.functionsExecuted / f.functionsDiscovered) * 100)
        : '0.0%';
      const cReach = padLeft(reachPct, 8);
      const cCalls = padLeft(formatNumber(f.calls), 10);
      const cTotal = padLeft(formatDuration(f.totalTimeMs), 10);

      const rowStr = `${marker} ${cFile} ${cDisc} ${cExec} ${cReach} ${cCalls} ${cTotal}`;
      out.push(isSelected ? `\x1b[7m${rowStr}\x1b[0m` : rowStr);
    }
    return out;
  }

  function renderLogsTab(width, height) {
    const out = [];
    if (state.logs.length === 0) {
      out.push('  \x1b[2m(No output logged from target process)\x1b[0m');
      return out;
    }

    const visibleRows = Math.max(1, height - 1);
    const slice = state.logs.slice(Math.max(0, state.logs.length - visibleRows));
    for (const l of slice) {
      out.push('  ' + truncate(l, width - 4));
    }
    return out;
  }

  // --- Lifecycle Methods ---
  function start() {
    if (!isTTY) return;

    // Enter alternate screen buffer & hide cursor
    stdout.write('\x1b[?1049h\x1b[?25l');

    // Setup raw input mode & keypress events
    readline.emitKeypressEvents(stdin);
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on('keypress', handleKeypress);

    stdout.on('resize', render);

    // Initial render
    render();

    // Live redraw timer during execution (update elapsed time & frames)
    state.renderTimer = setInterval(() => {
      if (state.status === 'running') {
        render();
      }
    }, 250);
  }

  function close() {
    if (state.isClosed) return;
    state.isClosed = true;

    if (state.renderTimer) clearInterval(state.renderTimer);
    if (state.toastTimer) clearTimeout(state.toastTimer);

    if (isTTY) {
      stdin.removeListener('keypress', handleKeypress);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.pause();
      stdout.removeListener('resize', render);

      // Exit alternate screen buffer & restore cursor
      stdout.write('\x1b[?1049l\x1b[?25h');
    }

    if (onExitCallback) {
      onExitCallback(state.exitCode);
    }
  }

  return {
    start,
    update,
    appendLog,
    finish,
    close,
    isTTY: () => isTTY,
    getState: () => state,
    onExit: (cb) => { onExitCallback = cb; },
    onAbort: (cb) => { onAbortCallback = cb; },
    handleKeypress,
    renderTabContent
  };
}
