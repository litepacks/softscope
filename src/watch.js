import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULT_EXTENSIONS } from './config.js';

export function clearTerminal(stdout = process.stdout) {
  if (stdout.isTTY) {
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.softscope',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage'
]);

export function isWatchIgnored(filepath) {
  if (!filepath) return false;
  const parts = filepath.split(/[\\/]/);
  for (const part of parts) {
    if (IGNORED_DIRS.has(part)) return true;
  }
  if (
    filepath.includes('softscope-autobench-runner') ||
    filepath.includes('softscope-autobench-results') ||
    filepath.includes('.softscope-session')
  ) {
    return true;
  }
  return false;
}

export function createFileWatcher({
  watchPaths = [],
  onChange,
  debounceMs = 150
}) {
  const watchers = [];
  let debounceTimer = null;
  let isClosed = false;

  function handleEvent(eventType, filename, baseDir) {
    if (isClosed) return;
    if (!filename) return;

    const fullPath = path.resolve(baseDir, filename);
    if (isWatchIgnored(fullPath)) return;

    const ext = path.extname(filename);
    if (ext && !DEFAULT_EXTENSIONS.has(ext)) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!isClosed) {
        onChange(fullPath, eventType);
      }
    }, debounceMs);
  }

  for (const p of watchPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      const watchDir = stat.isDirectory() ? p : path.dirname(p);

      try {
        const watcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
          handleEvent(eventType, filename, watchDir);
        });
        watchers.push(watcher);
      } catch {
        const watcher = fs.watch(watchDir, (eventType, filename) => {
          handleEvent(eventType, filename, watchDir);
        });
        watchers.push(watcher);
      }
    } catch {
      // Inaccessible directory, ignore
    }
  }

  return {
    close() {
      isClosed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
      watchers.length = 0;
    }
  };
}

export function setupWatchKeyboard({
  onRerun,
  onQuit,
  onPick,
  onToggleFuzz,
  onToggleDiff,
  onToggleChanged,
  onToggleAll,
  onToggleSequential,
  stdin = process.stdin,
  stdout = process.stdout
}) {
  if (!stdin.isTTY) return () => {};

  readline.emitKeypressEvents(stdin);
  const wasRaw = Boolean(stdin.isRaw);
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  stdin.resume();

  const handleKey = (str, key) => {
    if (!key) return;

    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
      cleanup();
      if (onQuit) {
        onQuit();
      } else {
        process.exit(0);
      }
      return;
    }

    if (key.name === 'r') {
      if (onRerun) onRerun();
      return;
    }

    if (key.name === 'p') {
      if (onPick) onPick();
      return;
    }

    if (key.name === 'f') {
      if (onToggleFuzz) onToggleFuzz();
      return;
    }

    if (key.name === 'd') {
      if (onToggleDiff) onToggleDiff();
      return;
    }

    if (key.name === 'c') {
      if (onToggleChanged) onToggleChanged();
      return;
    }

    if (key.name === 'a') {
      if (onToggleAll) onToggleAll();
      return;
    }

    if (key.name === 's') {
      if (onToggleSequential) onToggleSequential();
      return;
    }
  };

  stdin.on('keypress', handleKey);

  function cleanup() {
    stdin.removeListener('keypress', handleKey);
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(wasRaw);
    }
    stdin.pause();
  }

  return cleanup;
}

export async function runWatchLoop({
  title = 'softscope',
  targetPath,
  watchPaths = [],
  runTask,
  onPick = null,
  onToggleFuzz = null,
  onToggleDiff = null,
  onToggleChanged = null,
  onToggleAll = null,
  onToggleSequential = null,
  getState = null,
  stdin = process.stdin,
  stdout = process.stdout
}) {
  let isRunning = false;
  let rerunQueued = false;
  let cleanupKeyboard = null;
  let watcher = null;

  function printFooter() {
    const state = typeof getState === 'function' ? getState() : {};
    const shortcuts = [];
    shortcuts.push('\x1b[1mr\x1b[0m: re-run');
    if (onPick) shortcuts.push('\x1b[1mp\x1b[0m: pick');
    if (onToggleFuzz) {
      const status = state.fuzz !== false ? '\x1b[32mON\x1b[0m' : '\x1b[90mOFF\x1b[0m';
      shortcuts.push(`\x1b[1mf\x1b[0m: fuzz (${status})`);
    }
    if (onToggleDiff) {
      const status = state.diff ? '\x1b[32mON\x1b[0m' : '\x1b[90mOFF\x1b[0m';
      shortcuts.push(`\x1b[1md\x1b[0m: diff (${status})`);
    }
    if (onToggleChanged) {
      const status = state.changed ? '\x1b[32mON\x1b[0m' : '\x1b[90mOFF\x1b[0m';
      shortcuts.push(`\x1b[1mc\x1b[0m: changed (${status})`);
    }
    if (onToggleAll) {
      const status = state.all ? '\x1b[32mON\x1b[0m' : '\x1b[90mOFF\x1b[0m';
      shortcuts.push(`\x1b[1ma\x1b[0m: all (${status})`);
    }
    if (onToggleSequential) {
      const status = state.sequential ? '\x1b[32mON\x1b[0m' : '\x1b[90mOFF\x1b[0m';
      shortcuts.push(`\x1b[1ms\x1b[0m: seq (${status})`);
    }
    shortcuts.push('\x1b[1mq\x1b[0m: quit');

    const relTarget = path.relative(process.cwd(), targetPath) || targetPath;
    stdout.write(
      `\n\x1b[90m[${title}] Watching for changes in ${relTarget}...\x1b[0m\n` +
      `\x1b[90mShortcuts: ${shortcuts.join('  ')}\x1b[0m\n`
    );
  }

  async function execute(reason = null) {
    if (isRunning) {
      rerunQueued = true;
      return;
    }

    isRunning = true;
    rerunQueued = false;

    clearTerminal(stdout);
    if (reason) {
      stdout.write(`\x1b[36m[${title}]\x1b[0m ${reason}\n\n`);
    }

    try {
      await runTask();
    } catch (err) {
      console.error(`\x1b[31m[${title}] Run error: ${err.message}\x1b[0m`);
    } finally {
      isRunning = false;
      printFooter();

      if (rerunQueued) {
        rerunQueued = false;
        setImmediate(() => execute('Change detected during previous run. Re-running...'));
      }
    }
  }

  return new Promise((resolve) => {
    function quit() {
      if (watcher) watcher.close();
      if (cleanupKeyboard) cleanupKeyboard();
      clearTerminal(stdout);
      stdout.write(`\x1b[90m[${title}] Watch mode stopped.\x1b[0m\n`);
      resolve(0);
    }

    function rerun() {
      execute('Manual re-run requested.');
    }

    async function toggleFuzz() {
      if (!onToggleFuzz) return;
      const msg = await onToggleFuzz();
      execute(msg || 'Toggled fuzzing mode.');
    }

    async function toggleDiff() {
      if (!onToggleDiff) return;
      const msg = await onToggleDiff();
      execute(msg || 'Toggled diff comparison mode.');
    }

    async function toggleChanged() {
      if (!onToggleChanged) return;
      const msg = await onToggleChanged();
      execute(msg || 'Toggled Git-aware filter.');
    }

    async function toggleAll() {
      if (!onToggleAll) return;
      const msg = await onToggleAll();
      execute(msg || 'Toggled all functions filter.');
    }

    async function pick() {
      if (!onPick) return;
      if (cleanupKeyboard) {
        cleanupKeyboard();
        cleanupKeyboard = null;
      }
      try {
        await onPick();
      } finally {
        cleanupKeyboard = initKeyboard();
        execute('Updated function selection.');
      }
    }

    function toggleSequential() {
      const msg = onToggleSequential();
      execute(msg || 'Toggled sequential mode.');
    }

    function initKeyboard() {
      return setupWatchKeyboard({
        onRerun: rerun,
        onQuit: quit,
        onPick: onPick ? pick : null,
        onToggleFuzz: onToggleFuzz ? toggleFuzz : null,
        onToggleDiff: onToggleDiff ? toggleDiff : null,
        onToggleChanged: onToggleChanged ? toggleChanged : null,
        onToggleAll: onToggleAll ? toggleAll : null,
        onToggleSequential: onToggleSequential ? toggleSequential : null,
        stdin,
        stdout
      });
    }

    cleanupKeyboard = initKeyboard();

    watcher = createFileWatcher({
      watchPaths,
      onChange: (changedFile) => {
        const rel = path.relative(process.cwd(), changedFile) || changedFile;
        execute(`File changed: \x1b[1m${rel}\x1b[0m at ${new Date().toLocaleTimeString()}`);
      }
    });

    // Initial run
    execute();
  });
}
