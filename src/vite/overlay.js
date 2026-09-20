// Zero-dependency in-browser floating HUD overlay for Softscope Vite plugin
// Encapsulated in a closed ShadowRoot to guarantee zero CSS collisions with host app.

export function createOverlay(collector, options = {}) {
  if (typeof document === 'undefined') return null;

  const position = options.position || 'bottom-right'; // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

  // Host container
  const host = document.createElement('div');
  host.id = 'softscope-overlay-host';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647'; // Highest possible z-index
  host.style.pointerEvents = 'none';

  // Apply position
  if (position.includes('bottom')) host.style.bottom = '16px';
  if (position.includes('top')) host.style.top = '16px';
  if (position.includes('right')) host.style.right = '16px';
  if (position.includes('left')) host.style.left = '16px';

  const shadow = host.attachShadow({ mode: 'open' });

  // Styling
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    :host {
      all: initial;
    }

    /* Floating Pill Badge */
    .pill-btn {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: rgba(15, 23, 42, 0.82);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 9999px;
      color: #f8fafc;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
    }

    .pill-btn:hover {
      background: rgba(30, 41, 59, 0.92);
      border-color: rgba(56, 189, 248, 0.5);
      transform: translateY(-2px);
      box-shadow: 0 14px 28px -4px rgba(56, 189, 248, 0.25);
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 10px #38bdf8;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(56, 189, 248, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
    }

    .pill-title {
      font-weight: 700;
      letter-spacing: -0.01em;
      background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .pill-stat {
      color: #94a3b8;
      font-size: 12px;
      border-left: 1px solid rgba(255, 255, 255, 0.15);
      padding-left: 8px;
    }

    /* Modal / Drawer Overlay */
    .drawer-backdrop {
      pointer-events: auto;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      opacity: 0;
      visibility: hidden;
      transition: all 0.25s ease;
      z-index: 10;
    }

    .drawer-backdrop.open {
      opacity: 1;
      visibility: visible;
    }

    .drawer {
      pointer-events: auto;
      position: fixed;
      right: 16px;
      bottom: 60px;
      width: min(720px, calc(100vw - 32px));
      max-height: min(650px, calc(100vh - 80px));
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      transform: translateY(12px) scale(0.98);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 20;
    }

    .drawer.open {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    /* Drawer Header */
    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      background: rgba(30, 41, 59, 0.7);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-logo {
      font-size: 15px;
      font-weight: 700;
      background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .badge-live {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-primary {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.35);
      color: #38bdf8;
    }

    .btn-primary:hover {
      background: rgba(56, 189, 248, 0.28);
      color: #e0f2fe;
    }

    .btn-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 18px;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      border-radius: 4px;
    }

    .btn-close:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
    }

    /* KPI Cards */
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      padding: 14px 18px;
      background: rgba(15, 23, 42, 0.5);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .kpi-card {
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 10px 12px;
    }

    .kpi-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #94a3b8;
      margin-bottom: 4px;
    }

    .kpi-value {
      font-size: 16px;
      font-weight: 700;
      color: #f8fafc;
    }

    .kpi-sub {
      font-size: 10px;
      color: #64748b;
      margin-top: 2px;
    }

    /* Tabs */
    .tabs-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 18px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(15, 23, 42, 0.3);
    }

    .tab-item {
      background: transparent;
      border: none;
      color: #94a3b8;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      position: relative;
      transition: color 0.15s ease;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }

    .tab-item:hover {
      color: #e2e8f0;
    }

    .tab-item.active {
      color: #38bdf8;
      border-bottom-color: #38bdf8;
    }

    /* Tab Content / Body */
    .drawer-body {
      flex: 1;
      overflow-y: auto;
      padding: 14px 18px;
    }

    .table-container {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .table-container th {
      text-align: left;
      padding: 8px 10px;
      color: #94a3b8;
      font-weight: 600;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .table-container td {
      padding: 8px 10px;
      color: #cbd5e1;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
    }

    .table-container tr:hover td {
      background: rgba(255, 255, 255, 0.03);
    }

    .fn-name {
      font-weight: 600;
      color: #f1f5f9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .fn-location {
      font-size: 10px;
      color: #64748b;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      margin-top: 2px;
    }

    .progress-bar-bg {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 4px;
    }

    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #38bdf8, #6366f1);
      border-radius: 3px;
    }

    .badge-tag {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 3px;
      font-weight: 600;
      margin-left: 6px;
      display: inline-block;
    }

    .badge-dominant {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .badge-highfreq {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .toast-notice {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #10b981;
      color: #ffffff;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
      z-index: 50;
    }

    .toast-notice.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    .empty-state {
      text-align: center;
      padding: 30px 20px;
      color: #64748b;
      font-size: 13px;
    }
  `;
  shadow.appendChild(style);

  // Floating Button
  const pillBtn = document.createElement('button');
  pillBtn.className = 'pill-btn';
  pillBtn.innerHTML = `
    <span class="pulse-dot"></span>
    <span class="pill-title">⚡ Softscope</span>
    <span class="pill-stat" id="pill-stat">0 calls</span>
  `;
  shadow.appendChild(pillBtn);

  // Drawer Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  shadow.appendChild(backdrop);

  // Drawer Panel
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-header">
      <div class="header-left">
        <span class="header-logo">Softscope Profiler</span>
        <span class="badge-live">Browser HUD</span>
      </div>
      <div class="header-actions">
        <button class="btn" id="btn-reset" title="Reset all measured metrics to zero">🔄 Reset</button>
        <button class="btn btn-primary" id="btn-copy-ai" title="Copy token-dense AI diagnostic profile to clipboard">🤖 Copy AI Profile</button>
        <button class="btn" id="btn-copy-md" title="Copy Markdown table to clipboard">📋 Copy MD</button>
        <button class="btn" id="btn-console" title="Log console table in DevTools">📊 Console</button>
        <button class="btn-close" id="btn-close">✕</button>
      </div>
    </div>

    <div class="kpi-row">
      <div class="kpi-card">
        <div class="kpi-label">Wall Duration</div>
        <div class="kpi-value" id="kpi-duration">0ms</div>
        <div class="kpi-sub" id="kpi-files">0 files observed</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Function Calls</div>
        <div class="kpi-value" id="kpi-calls">0</div>
        <div class="kpi-sub" id="kpi-rate">0 calls/sec</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Runtime Reach</div>
        <div class="kpi-value" id="kpi-reach">0%</div>
        <div class="kpi-sub" id="kpi-untouched">0 untouched funcs</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Top Hotspot</div>
        <div class="kpi-value" id="kpi-hotspot" style="font-size: 13px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">-</div>
        <div class="kpi-sub" id="kpi-hotspot-time">0ms self-time</div>
      </div>
    </div>

    <div class="tabs-bar">
      <button class="tab-item active" data-tab="bottlenecks">Bottlenecks (Self-Time)</button>
      <button class="tab-item" data-tab="highfreq">High-Frequency (>1k)</button>
      <button class="tab-item" data-tab="callgraph">Call Graph</button>
      <button class="tab-item" data-tab="untouched">Untouched Code</button>
    </div>

    <div class="drawer-body" id="drawer-body">
      <!-- Dynamic tab content inserted here -->
    </div>

    <div class="toast-notice" id="toast">Copied to clipboard!</div>
  `;
  shadow.appendChild(drawer);

  // Mount to body
  if (document.body) {
    document.body.appendChild(host);
  } else {
    window.addEventListener('DOMContentLoaded', () => document.body.appendChild(host));
  }

  // State
  let activeTab = 'bottlenecks';
  let isOpen = false;

  function showToast(msg = 'Copied to clipboard!') {
    const toast = shadow.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function formatTime(ms) {
    if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
    if (ms >= 10) return Math.round(ms) + 'ms';
    if (ms >= 1) return ms.toFixed(1) + 'ms';
    return ms.toFixed(2) + 'ms';
  }

  function formatNum(n) {
    return Number(n).toLocaleString();
  }

  function toggleOpen(state = !isOpen) {
    isOpen = state;
    if (isOpen) {
      drawer.classList.add('open');
      backdrop.classList.add('open');
      render();
    } else {
      drawer.classList.remove('open');
      backdrop.classList.remove('open');
    }
  }

  pillBtn.addEventListener('click', () => toggleOpen(true));
  shadow.getElementById('btn-close').addEventListener('click', () => toggleOpen(false));
  backdrop.addEventListener('click', () => toggleOpen(false));

  // Tab switching
  shadow.querySelectorAll('.tab-item').forEach(btn => {
    btn.addEventListener('click', () => {
      shadow.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab;
      render();
    });
  });

  // Action Buttons
  shadow.getElementById('btn-reset').addEventListener('click', () => {
    collector.reset();
    showToast('Metrics reset to 0');
    render();
  });

  shadow.getElementById('btn-copy-ai').addEventListener('click', () => {
    const report = generateAiReport(collector.getSnapshot());
    navigator.clipboard.writeText(report).then(() => showToast('AI Profile copied! ✓'));
  });

  shadow.getElementById('btn-copy-md').addEventListener('click', () => {
    const report = generateMarkdownReport(collector.getSnapshot());
    navigator.clipboard.writeText(report).then(() => showToast('Markdown copied! ✓'));
  });

  shadow.getElementById('btn-console').addEventListener('click', () => {
    const snap = collector.getSnapshot();
    const sorted = [...snap.functions].filter(f => f.calls > 0).sort((a, b) => b.selfDurationMs - a.selfDurationMs);
    console.group('⚡ Softscope Browser Report');
    console.table(sorted.slice(0, 20).map(f => ({
      Function: f.name,
      File: `${f.file}:${f.line}:${f.column}`,
      Calls: f.calls,
      'Self Time (ms)': f.selfDurationMs.toFixed(2),
      'Total Time (ms)': f.totalDurationMs.toFixed(2),
      'Avg (ms)': (f.calls > 0 ? f.totalDurationMs / f.calls : 0).toFixed(3)
    })));
    console.groupEnd();
    showToast('Logged to DevTools console!');
  });

  // Render method
  function render() {
    const snap = collector.getSnapshot();
    const duration = snap.durationMs || 1;
    const executed = (snap.functions || []).filter(f => f.calls > 0);
    const totalSelf = executed.reduce((acc, f) => acc + (f.selfDurationMs || 0), 0);

    // Update Pill Button
    const pillStat = shadow.getElementById('pill-stat');
    if (pillStat) {
      pillStat.textContent = `${formatNum(snap.totalCalls)} calls`;
    }

    // Update KPIs
    shadow.getElementById('kpi-duration').textContent = formatTime(duration);
    shadow.getElementById('kpi-files').textContent = `${snap.files.length} observed files`;
    shadow.getElementById('kpi-calls').textContent = formatNum(snap.totalCalls);
    const callsPerSec = Math.round((snap.totalCalls / (duration / 1000)) || 0);
    shadow.getElementById('kpi-rate').textContent = `${formatNum(callsPerSec)} calls/sec`;

    const reachPct = snap.totalDiscovered > 0
      ? ((snap.totalExecuted / snap.totalDiscovered) * 100).toFixed(1)
      : '0.0';
    shadow.getElementById('kpi-reach').textContent = `${reachPct}%`;
    const untouchedCount = (snap.totalDiscovered || 0) - (snap.totalExecuted || 0);
    shadow.getElementById('kpi-untouched').textContent = `${untouchedCount} untouched funcs`;

    const sortedBySelf = [...executed].sort((a, b) => b.selfDurationMs - a.selfDurationMs);
    const topFn = sortedBySelf[0];
    if (topFn) {
      const topSelfPct = totalSelf > 0 ? ((topFn.selfDurationMs / totalSelf) * 100).toFixed(0) : '0';
      shadow.getElementById('kpi-hotspot').textContent = `${topFn.name} (${topSelfPct}%)`;
      shadow.getElementById('kpi-hotspot-time').textContent = `${formatTime(topFn.selfDurationMs)} self-time`;
    } else {
      shadow.getElementById('kpi-hotspot').textContent = '-';
      shadow.getElementById('kpi-hotspot-time').textContent = '0ms self-time';
    }

    if (!isOpen) return;

    // Render Active Tab
    const body = shadow.getElementById('drawer-body');
    if (activeTab === 'bottlenecks') {
      if (sortedBySelf.length === 0) {
        body.innerHTML = `<div class="empty-state">No function calls recorded yet. Interact with your application to observe metrics.</div>`;
        return;
      }

      let html = `
        <table class="table-container">
          <thead>
            <tr>
              <th style="width: 38%;">Function</th>
              <th style="width: 26%;">Self Time</th>
              <th style="width: 18%;">Calls</th>
              <th style="width: 18%;">Total Time</th>
            </tr>
          </thead>
          <tbody>
      `;

      sortedBySelf.slice(0, 15).forEach(fn => {
        const pct = totalSelf > 0 ? ((fn.selfDurationMs / totalSelf) * 100).toFixed(1) : '0.0';
        let badge = '';
        if (Number(pct) >= 40) badge = `<span class="badge-tag badge-dominant">DOMINANT</span>`;
        else if (fn.calls >= 10000) badge = `<span class="badge-tag badge-highfreq">HIGH FREQ</span>`;

        html += `
          <tr>
            <td>
              <div class="fn-name">${escapeHtml(fn.name)} ${badge}</div>
              <div class="fn-location">${escapeHtml(fn.file)}:${fn.line}:${fn.column}</div>
            </td>
            <td>
              <div>${formatTime(fn.selfDurationMs)} <span style="color:#94a3b8; font-size:11px;">(${pct}%)</span></div>
              <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${Math.min(100, pct)}%;"></div></div>
            </td>
            <td>${formatNum(fn.calls)}</td>
            <td>${formatTime(fn.totalDurationMs)}</td>
          </tr>
        `;
      });

      html += `</tbody></table>`;
      body.innerHTML = html;
    } else if (activeTab === 'highfreq') {
      const highFreq = [...executed].filter(f => f.calls >= 1000).sort((a, b) => b.calls - a.calls);
      if (highFreq.length === 0) {
        body.innerHTML = `<div class="empty-state">No functions with >= 1,000 invocations detected yet.</div>`;
        return;
      }

      let html = `
        <table class="table-container">
          <thead>
            <tr>
              <th style="width: 45%;">Function</th>
              <th style="width: 25%;">Calls</th>
              <th style="width: 15%;">Avg Time</th>
              <th style="width: 15%;">Self Time</th>
            </tr>
          </thead>
          <tbody>
      `;

      highFreq.slice(0, 15).forEach(fn => {
        const avg = fn.calls > 0 ? fn.totalDurationMs / fn.calls : 0;
        html += `
          <tr>
            <td>
              <div class="fn-name">${escapeHtml(fn.name)}</div>
              <div class="fn-location">${escapeHtml(fn.file)}:${fn.line}:${fn.column}</div>
            </td>
            <td style="font-weight: 600; color: #38bdf8;">${formatNum(fn.calls)}</td>
            <td>${formatTime(avg)}</td>
            <td>${formatTime(fn.selfDurationMs)}</td>
          </tr>
        `;
      });

      html += `</tbody></table>`;
      body.innerHTML = html;
    } else if (activeTab === 'callgraph') {
      const edges = [...(snap.edges || [])].sort((a, b) => b.calls - a.calls).slice(0, 15);
      if (edges.length === 0) {
        body.innerHTML = `<div class="empty-state">No caller-callee relationships recorded yet.</div>`;
        return;
      }

      let html = `
        <table class="table-container">
          <thead>
            <tr>
              <th style="width: 40%;">Caller</th>
              <th style="width: 40%;">Callee</th>
              <th style="width: 20%;">Invocations</th>
            </tr>
          </thead>
          <tbody>
      `;

      edges.forEach(e => {
        html += `
          <tr>
            <td class="fn-name">${escapeHtml(e.callerName)}</td>
            <td class="fn-name" style="color: #818cf8;">${escapeHtml(e.calleeName)}</td>
            <td style="font-weight: 600; color: #38bdf8;">${formatNum(e.calls)}</td>
          </tr>
        `;
      });

      html += `</tbody></table>`;
      body.innerHTML = html;
    } else if (activeTab === 'untouched') {
      const untouched = (snap.functions || []).filter(f => f.calls === 0);
      if (untouched.length === 0) {
        body.innerHTML = `<div class="empty-state">100% of discovered functions were executed at runtime!</div>`;
        return;
      }

      let html = `
        <table class="table-container">
          <thead>
            <tr>
              <th style="width: 60%;">Function</th>
              <th style="width: 40%;">Location</th>
            </tr>
          </thead>
          <tbody>
      `;

      untouched.slice(0, 20).forEach(fn => {
        html += `
          <tr>
            <td class="fn-name" style="color: #94a3b8;">${escapeHtml(fn.name)}</td>
            <td class="fn-location">${escapeHtml(fn.file)}:${fn.line}:${fn.column}</td>
          </tr>
        `;
      });

      html += `</tbody></table>`;
      body.innerHTML = html;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Generate lightweight AI Profile in browser
  function generateAiReport(snap) {
    const executed = (snap.functions || []).filter(f => f.calls > 0);
    const totalSelf = executed.reduce((acc, f) => acc + (f.selfDurationMs || 0), 0);
    const sorted = [...executed].sort((a, b) => b.selfDurationMs - a.selfDurationMs);
    const reachPct = snap.totalDiscovered > 0
      ? ((snap.totalExecuted / snap.totalDiscovered) * 100).toFixed(1)
      : '0.0';

    const lines = [];
    lines.push('# Softscope AI Profile (Browser)');
    lines.push(`- **Duration**: ${formatTime(snap.durationMs)}`);
    lines.push(`- **Total Calls**: ${formatNum(snap.totalCalls)}`);
    lines.push(`- **Functions**: Discovered: ${snap.totalDiscovered} | Executed: ${snap.totalExecuted} (${reachPct}%)`);
    lines.push('');

    lines.push('## Critical Bottlenecks (Top Self-Time)');
    sorted.slice(0, 8).forEach((fn, idx) => {
      const pct = totalSelf > 0 ? ((fn.selfDurationMs / totalSelf) * 100).toFixed(1) : '0.0';
      const avg = fn.calls > 0 ? (fn.totalDurationMs / fn.calls) : 0;
      lines.push(`${idx + 1}. \`${fn.name}\` (\`${fn.file}:${fn.line}:${fn.column}\`)`);
      lines.push(`   - **Self Time**: ${formatTime(fn.selfDurationMs)} (${pct}%) | **Calls**: ${formatNum(fn.calls)} | **Avg**: ${formatTime(avg)}`);
    });
    lines.push('');

    const highFreq = [...executed].filter(f => f.calls >= 1000).sort((a, b) => b.calls - a.calls);
    if (highFreq.length > 0) {
      lines.push('## High-Frequency Invocations');
      highFreq.slice(0, 5).forEach(fn => {
        lines.push(`- \`${fn.name}\` (\`${fn.file}:${fn.line}\`): ${formatNum(fn.calls)} calls`);
      });
      lines.push('');
    }

    if (sorted.length > 0) {
      lines.push('## Actionable Directives for AI Agent');
      lines.push(`1. Prioritize optimizing \`${sorted[0].file}:${sorted[0].line}:${sorted[0].column}\` (\`${sorted[0].name}\`), consuming ${totalSelf > 0 ? ((sorted[0].selfDurationMs / totalSelf) * 100).toFixed(1) : 0}% of active CPU time.`);
      if (highFreq.length > 0) {
        lines.push(`2. Check for unnecessary re-evaluations in \`${highFreq[0].file}:${highFreq[0].line}\` (\`${highFreq[0].name}\`), called ${formatNum(highFreq[0].calls)} times.`);
      }
    }

    return lines.join('\n');
  }

  // Generate Markdown report in browser
  function generateMarkdownReport(snap) {
    const executed = (snap.functions || []).filter(f => f.calls > 0);
    const sorted = [...executed].sort((a, b) => b.selfDurationMs - a.selfDurationMs);

    const lines = [];
    lines.push('# Softscope Report (Browser)');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`| :--- | :--- |`);
    lines.push(`| **Duration** | ${formatTime(snap.durationMs)} |`);
    lines.push(`| **Total Calls** | ${formatNum(snap.totalCalls)} |`);
    lines.push(`| **Functions Executed** | ${snap.totalExecuted} / ${snap.totalDiscovered} |`);
    lines.push('');
    lines.push('## Top Functions by Self-Time');
    lines.push('');
    lines.push('| Function | Location | Calls | Self Time | Total Time |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');

    sorted.slice(0, 10).forEach(fn => {
      lines.push(`| \`${fn.name}\` | \`${fn.file}:${fn.line}:${fn.column}\` | ${formatNum(fn.calls)} | ${formatTime(fn.selfDurationMs)} | ${formatTime(fn.totalDurationMs)} |`);
    });

    return lines.join('\n');
  }

  // Keyboard shortcuts (Alt+S to toggle, Escape to close)
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && isOpen) {
      toggleOpen(false);
    } else if (e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      toggleOpen(!isOpen);
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
  }

  // Periodic heartbeat timer to refresh live stats on badge
  const timer = setInterval(() => {
    render();
  }, 600);

  // Initial render
  render();

  return {
    toggle: toggleOpen,
    render,
    destroy() {
      clearInterval(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown);
      }
      if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
    }
  };
}

