import readline from 'node:readline';

/**
 * Interactive function picker using native readline and ANSI escape codes.
 * Zero external dependencies.
 */
export async function promptFunctionPicker(functions, {
  title = 'Select functions to benchmark',
  stdout = process.stdout,
  stdin = process.stdin
} = {}) {
  if (!stdin.isTTY || !stdout.isTTY || !Array.isArray(functions) || functions.length === 0) {
    return functions;
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const selected = new Set();
    const maxVisible = 12;
    let linesRendered = 0;

    // Setup raw mode
    readline.emitKeypressEvents(stdin);
    const wasRaw = Boolean(stdin.isRaw);
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();

    // Hide cursor
    stdout.write('\x1b[?25l');

    function render() {
      // Clear previously rendered lines
      if (linesRendered > 0) {
        stdout.write(`\x1b[${linesRendered}A\r\x1b[0J`);
      }

      const total = functions.length;
      const startIndex = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, total - maxVisible)));
      const endIndex = Math.min(total, startIndex + maxVisible);

      const buffer = [];
      buffer.push(`\x1b[1;36m? ${title}\x1b[0m \x1b[90m(↑/↓ navigate, Space toggle, 'a' all, Enter run, 'q' cancel)\x1b[0m`);

      if (startIndex > 0) {
        buffer.push(`  \x1b[90m↑ ... (${startIndex} more above)\x1b[0m`);
      }

      for (let i = startIndex; i < endIndex; i++) {
        const fn = functions[i];
        const isCurrent = i === cursor;
        const keyName = fn.exportName || fn.name;
        const isChecked = selected.has(keyName);

        const pointer = isCurrent ? '\x1b[1;36m❯\x1b[0m' : ' ';
        const checkbox = isChecked ? '\x1b[1;32m[x]\x1b[0m' : '\x1b[90m[ ]\x1b[0m';
        const fnName = isCurrent ? `\x1b[1;37m${fn.name}\x1b[0m` : `\x1b[37m${fn.name}\x1b[0m`;
        const alias = fn.exportName && fn.exportName !== fn.name ? ` \x1b[90m(export: ${fn.exportName})\x1b[0m` : '';
        const params = fn.params && fn.params.length > 0
          ? ` \x1b[90m(${fn.params.map(p => p.name).join(', ')})\x1b[0m`
          : ' \x1b[90m()\x1b[0m';

        buffer.push(`${pointer} ${checkbox} ${fnName}${params}${alias}`);
      }

      if (endIndex < total) {
        buffer.push(`  \x1b[90m↓ ... (${total - endIndex} more below)\x1b[0m`);
      }

      const countStr = selected.size > 0
        ? `\x1b[32m${selected.size} selected\x1b[0m`
        : '\x1b[90mnone selected (Enter will select current)\x1b[0m';
      buffer.push(`  \x1b[90mTotal: ${total} functions | ${countStr}\x1b[0m`);

      const text = buffer.join('\n') + '\n';
      linesRendered = buffer.length;
      stdout.write(text);
    }

    function cleanup() {
      stdin.removeListener('keypress', handleKey);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(wasRaw);
      }
      stdin.pause();
      // Show cursor
      stdout.write('\x1b[?25h');
    }

    function finish(result) {
      cleanup();
      // Clear picker UI from terminal
      if (linesRendered > 0) {
        stdout.write(`\x1b[${linesRendered}A\r\x1b[0J`);
      }
      resolve(result);
    }

    function handleKey(str, key) {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
        finish(null);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + functions.length) % functions.length;
        render();
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % functions.length;
        render();
        return;
      }

      if (key.name === 'space') {
        const fn = functions[cursor];
        const keyName = fn.exportName || fn.name;
        if (selected.has(keyName)) {
          selected.delete(keyName);
        } else {
          selected.add(keyName);
        }
        render();
        return;
      }

      if (key.name === 'a') {
        if (selected.size === functions.length) {
          selected.clear();
        } else {
          for (const fn of functions) {
            selected.add(fn.exportName || fn.name);
          }
        }
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (selected.size === 0) {
          // Default to the item under cursor if nothing explicitly checked
          finish([functions[cursor]]);
        } else {
          const chosen = functions.filter(f => selected.has(f.exportName || f.name));
          finish(chosen);
        }
      }
    }

    stdin.on('keypress', handleKey);
    render();
  });
}
