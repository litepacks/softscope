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
  onPick = null
}) {
  let isRunning = false;
  let rerunQueued = false;
  let cleanupKeyboard = null;
  let watcher = null;

  function printFooter() {
    const pickHint = onPick ? ', p: pick functions' : '';
    process.stdout.write(
      `\n\x1b[90m[${title}] Watching for changes in ${path.relative(process.cwd(), targetPath) || targetPath}... (r: re-run${pickHint}, q: quit)\x1b[0m\n`
    );
  }

  async function execute(reason = null) {
    if (isRunning) {
      rerunQueued = true;
      return;
    }

    isRunning = true;
    rerunQueued = false;

    clearTerminal();
    if (reason) {
      process.stdout.write(`\x1b[36m[${title}]\x1b[0m ${reason}\n\n`);
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
      clearTerminal();
      process.stdout.write(`\x1b[90m[${title}] Watch mode stopped.\x1b[0m\n`);
      resolve(0);
    }

    function rerun() {
      execute('Manual re-run requested.');
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
        cleanupKeyboard = setupWatchKeyboard({ onRerun: rerun, onQuit: quit, onPick: pick });
        execute('Updated function selection.');
      }
    }

    cleanupKeyboard = setupWatchKeyboard({ onRerun: rerun, onQuit: quit, onPick: onPick ? pick : null });

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
