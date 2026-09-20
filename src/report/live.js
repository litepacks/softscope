import { formatNumber } from './format.js';

export function createLiveReporter() {
  let lastPrint = 0;
  const isTTY = process.stderr.isTTY;

  function render(stats) {
    const now = Date.now();
    if (now - lastPrint < 400) return;
    lastPrint = now;

    const lines = [];
    lines.push('\n--- Softscope (live) ---');
    lines.push(`Files observed       ${formatNumber(stats.filesObserved || 0)}`);
    lines.push(`Functions discovered ${formatNumber(stats.functionsDiscovered || 0)}`);
    lines.push(`Functions executed   ${formatNumber(stats.functionsExecuted || 0)}`);
    lines.push(`Function calls       ${formatNumber(stats.totalCalls || 0)}`);
    lines.push(`Active functions     ${formatNumber(stats.activeFunctions || 0)}`);

    if (stats.hot && stats.hot.length > 0) {
      lines.push('\nHot now:');
      for (const item of stats.hot) {
        lines.push(`  ${item.name.padEnd(24)} ${formatNumber(item.calls)} calls`);
      }
    }
    lines.push('------------------------\n');

    process.stderr.write(lines.join('\n'));
  }

  return {
    render
  };
}
