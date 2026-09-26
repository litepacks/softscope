import { formatNumber, formatBytesPerOp } from '../report/format.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function formatCompactOps(ops) {
  if (!ops || ops <= 0) return '0 ops/s';
  if (ops >= 1_000_000_000) return `${(ops / 1_000_000_000).toFixed(1)}B ops/s`;
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(1)}M ops/s`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)}K ops/s`;
  return `${formatNumber(ops)} ops/s`;
}

/**
 * Creates a real-time progress reporter for auto-bench execution.
 */
export function createProgressReporter({
  total = 0,
  isTTY = Boolean(process.stderr && process.stderr.isTTY),
  enabled = true,
  sequential = false
} = {}) {
  let spinnerIndex = 0;
  let spinnerTimer = null;
  let currentItem = null;
  let currentIndex = 0;

  function renderStreamLine() {
    if (!enabled || !isTTY || !currentItem) return;
    const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    const pct = total > 0 ? Math.round((currentIndex / total) * 100) : 0;
    const barWidth = 12;
    const filled = total > 0 ? Math.round((currentIndex / total) * barWidth) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled));

    const idxStr = String(currentIndex).padStart(String(total).length, ' ');
    const line = `\r\x1b[2K\x1b[36m${bar}\x1b[0m \x1b[1;30m[\x1b[1;36m${idxStr}\x1b[1;30m/\x1b[1;36m${total}\x1b[1;30m]\x1b[0m \x1b[33m${String(pct).padStart(3, ' ')}%\x1b[0m \x1b[35m${spinner}\x1b[0m \x1b[1m${currentItem.name}\x1b[0m${currentItem.extra || ''}`;
    try {
      process.stderr.write(line);
    } catch {}
  }

  function startSpinner() {
    if (!isTTY || !enabled || spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerIndex++;
      if (!sequential) {
        renderStreamLine();
      } else if (currentItem) {
        const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
        const idxStr = String(currentIndex).padStart(String(total).length, ' ');
        const dotLen = Math.max(2, 28 - currentItem.name.length);
        const dots = '.'.repeat(dotLen);
        try {
          process.stderr.write(`\r\x1b[2K  \x1b[35m${spinner}\x1b[0m \x1b[1;30m[\x1b[1;36m${idxStr}\x1b[1;30m/\x1b[1;36m${total}\x1b[1;30m]\x1b[0m \x1b[1m${currentItem.name}\x1b[0m ${dots} \x1b[2mrunning...\x1b[0m`);
        } catch {}
      }
    }, 80);
    if (spinnerTimer.unref) spinnerTimer.unref();
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  return {
    onStart(index, name) {
      if (!enabled) return;
      currentIndex = index;
      currentItem = { name, extra: '' };
      startSpinner();
      if (!sequential) {
        renderStreamLine();
      } else if (!isTTY) {
        const idxStr = String(index).padStart(String(total).length, ' ');
        process.stderr.write(`  ▶ [${idxStr}/${total}] ${name} ...\n`);
      }
    },

    onDone(index, name, data = {}) {
      if (!enabled) return;
      currentIndex = index;
      const { opsPerSec, bytesPerOp, status, cliffs, crashes, error, timedOut } = data;

      let statSummary = '';
      if (status === 'timeout' || timedOut) {
        statSummary = `\x1b[31m✖ Timeout\x1b[0m`;
      } else if (status === 'error') {
        statSummary = `\x1b[31m✖ Error\x1b[0m \x1b[2m(${error || 'failed'})\x1b[0m`;
      } else {
        const ops = formatCompactOps(opsPerSec);
        const alloc = formatBytesPerOp(bytesPerOp);
        let tags = '';
        if (crashes > 0) tags += ` \x1b[31m[Crashes (${crashes})]\x1b[0m`;
        if (cliffs > 0) tags += ` \x1b[33m[Cliff (${cliffs})]\x1b[0m`;
        statSummary = `\x1b[32m✔\x1b[0m \x1b[1m${ops}\x1b[0m (\x1b[36m${alloc}\x1b[0m)${tags}`;
      }

      if (sequential) {
        const idxStr = String(index).padStart(String(total).length, ' ');
        const dotLen = Math.max(2, 28 - name.length);
        const dots = '.'.repeat(dotLen);
        if (isTTY) {
          process.stderr.write(`\r\x1b[2K  \x1b[1;30m[\x1b[1;36m${idxStr}\x1b[1;30m/\x1b[1;36m${total}\x1b[1;30m]\x1b[0m \x1b[1m${name}\x1b[0m ${dots} ${statSummary}\n`);
        } else {
          process.stderr.write(`    ↳ ${statSummary.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
        }
      } else {
        currentItem = { name, extra: ` · ${statSummary}` };
        renderStreamLine();
      }
    },

    clear() {
      stopSpinner();
      if (enabled && isTTY) {
        try {
          process.stderr.write('\r\x1b[2K');
        } catch {}
      }
    },

    finish() {
      stopSpinner();
      if (enabled && isTTY && !sequential) {
        try {
          process.stderr.write('\r\x1b[2K');
        } catch {}
      }
    }
  };
}
