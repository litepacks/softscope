// Softscope browser client runtime for Vite applications
import { RuntimeCollector } from '../runtime/collector.js';
import { createOverlay } from './overlay.js';

export function initSoftscopeClient(options = {}) {
  if (globalThis.__softscope && typeof globalThis.__softscope.getSnapshot === 'function') {
    return globalThis.__softscope;
  }

  const collector = new RuntimeCollector();
  let overlay = null;

  if (typeof document !== 'undefined' && options.overlay !== false) {
    overlay = createOverlay(collector, options);
  }

  const client = {
    enter: (id) => collector.enter(id),
    exit: (id, isError) => collector.exit(id, isError),
    registerFile: (file, fns) => collector.registerFile(file, fns),
    getSnapshot: () => collector.getSnapshot(),
    reset: () => {
      collector.reset();
      if (overlay) overlay.render();
    },
    toggleOverlay: (state) => overlay?.toggle(state),
    printReport: () => {
      const snap = collector.getSnapshot();
      const sorted = [...snap.functions].filter(f => f.calls > 0).sort((a, b) => b.selfDurationMs - a.selfDurationMs);
      console.group('⚡ Softscope Profile Summary');
      console.log(`Duration: ${(snap.durationMs / 1000).toFixed(2)}s | Total Calls: ${snap.totalCalls} | Functions: ${snap.totalExecuted} / ${snap.totalDiscovered}`);
      console.table(sorted.slice(0, 20).map(f => ({
        Function: f.name,
        Location: `${f.file}:${f.line}:${f.column}`,
        Calls: f.calls,
        'Self Time (ms)': f.selfDurationMs.toFixed(2),
        'Total Time (ms)': f.totalDurationMs.toFixed(2),
        'Avg (ms)': (f.calls > 0 ? f.totalDurationMs / f.calls : 0).toFixed(3)
      })));
      console.groupEnd();
    },
    getAiProfile: () => {
      const snap = collector.getSnapshot();
      const executed = (snap.functions || []).filter(f => f.calls > 0);
      const totalSelf = executed.reduce((acc, f) => acc + (f.selfDurationMs || 0), 0);
      const sorted = [...executed].sort((a, b) => b.selfDurationMs - a.selfDurationMs);
      const reachPct = snap.totalDiscovered > 0
        ? ((snap.totalExecuted / snap.totalDiscovered) * 100).toFixed(1)
        : '0.0';

      const lines = [];
      lines.push('# Softscope AI Profile (Browser)');
      lines.push(`- **Duration**: ${(snap.durationMs / 1000).toFixed(2)}s`);
      lines.push(`- **Total Calls**: ${snap.totalCalls}`);
      lines.push(`- **Functions**: Discovered: ${snap.totalDiscovered} | Executed: ${snap.totalExecuted} (${reachPct}%)`);
      lines.push('');

      lines.push('## Critical Bottlenecks (Top Self-Time)');
      sorted.slice(0, 10).forEach((fn, idx) => {
        const pct = totalSelf > 0 ? ((fn.selfDurationMs / totalSelf) * 100).toFixed(1) : '0.0';
        const avg = fn.calls > 0 ? (fn.totalDurationMs / fn.calls) : 0;
        lines.push(`${idx + 1}. \`${fn.name}\` (\`${fn.file}:${fn.line}:${fn.column}\`)`);
        lines.push(`   - **Self Time**: ${fn.selfDurationMs.toFixed(2)}ms (${pct}%) | **Calls**: ${fn.calls} | **Avg**: ${avg.toFixed(2)}ms`);
      });
      lines.push('');

      if (sorted.length > 0) {
        lines.push('## Actionable Directives for AI Agent');
        lines.push(`1. Prioritize optimizing \`${sorted[0].file}:${sorted[0].line}:${sorted[0].column}\` (\`${sorted[0].name}\`), consuming ${totalSelf > 0 ? ((sorted[0].selfDurationMs / totalSelf) * 100).toFixed(1) : 0}% of active CPU time.`);
      }

      return lines.join('\n');
    },
    _collector: collector,
    _overlay: overlay
  };

  globalThis.__softscope = client;
  if (typeof window !== 'undefined') {
    window.__softscope = client;
  }

  return client;
}

// Auto-initialize with default options when loaded as a module in browser
let defaultClient = null;
if (typeof window !== 'undefined') {
  defaultClient = initSoftscopeClient();
}

export default defaultClient;
export { defaultClient as client };

