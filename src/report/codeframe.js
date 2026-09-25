import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extracts source location (file, line, column) from an error stack trace.
 */
export function parseStackFrame(stack, preferredFile = null) {
  if (!stack || typeof stack !== 'string') return null;

  const lines = stack.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;

    // Filter out node internals and softscope runners
    if (
      trimmed.includes('node:') ||
      trimmed.includes('softscope-autobench-runner') ||
      trimmed.includes('node_modules')
    ) {
      continue;
    }

    // Match patterns like:
    // at tokenize (file:///path/to/my project/file.ts:83:24)
    // at /path/to/my project/file.ts:83:24
    let match = trimmed.match(/\((?:file:\/\/)?([^)]+?):(\d+):(\d+)\)$/);
    if (!match) {
      match = trimmed.match(/(?:at\s+)?(?:file:\/\/)?(.*?):(\d+):(\d+)$/);
    }
    if (match) {
      let filePath = match[1].trim();
      const lineNum = parseInt(match[2], 10);
      const colNum = parseInt(match[3], 10);

      if (filePath.startsWith('file://')) {
        try {
          filePath = fileURLToPath(filePath);
        } catch {
          // Keep as-is
        }
      }

      if (fs.existsSync(filePath)) {
        return {
          filePath: path.resolve(filePath),
          line: lineNum,
          column: colNum
        };
      }
    }
  }

  // Fallback: if preferredFile exists and is given
  if (preferredFile && fs.existsSync(preferredFile)) {
    return {
      filePath: path.resolve(preferredFile),
      line: 1,
      column: 1
    };
  }

  return null;
}

/**
 * Generates an ANSI-highlighted code frame snippet around a specific line and column.
 */
export function createCodeFrame(filePath, line, column = 1, options = {}) {
  const {
    linesBefore = 2,
    linesAfter = 2,
    message = '',
    color = true
  } = options;

  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }

  if (!content || content.length === 0) return '';

  const allLines = content.split('\n');
  const totalLines = allLines.length;
  if (totalLines === 0) return '';

  const targetLine = Math.max(1, Math.min(line, totalLines));
  const startLine = Math.max(1, targetLine - linesBefore);
  const endLine = Math.min(totalLines, targetLine + linesAfter);

  const gutterWidth = String(endLine).length;
  const result = [];

  for (let i = startLine; i <= endLine; i++) {
    const rawLine = allLines[i - 1] || '';
    const lineContent = rawLine.replace(/\r$/, '');
    const isTarget = i === targetLine;
    const lineNumStr = String(i).padStart(gutterWidth, ' ');

    if (isTarget) {
      const marker = color ? '\x1b[1;31m>\x1b[0m' : '>';
      const gutter = color ? `\x1b[1;37m${lineNumStr}\x1b[0m` : lineNumStr;
      const bar = color ? '\x1b[90m|\x1b[0m' : '|';
      result.push(`  ${marker} ${gutter} ${bar} ${lineContent}`);

      // Render caret pointer directly underneath the error column
      if (column > 0) {
        const caretIndent = ' '.repeat(Math.max(0, column - 1));
        const caret = color ? '\x1b[1;31m^\x1b[0m' : '^';
        const emptyGutter = ' '.repeat(gutterWidth);
        const errDesc = message ? (color ? ` \x1b[31m${message}\x1b[0m` : ` ${message}`) : '';
        result.push(`    ${emptyGutter} ${bar} ${caretIndent}${caret}${errDesc}`);
      }
    } else {
      const marker = ' ';
      const gutter = color ? `\x1b[90m${lineNumStr}\x1b[0m` : lineNumStr;
      const bar = color ? '\x1b[90m|\x1b[0m' : '|';
      result.push(`  ${marker} ${gutter} ${bar} ${lineContent}`);
    }
  }

  return result.join('\n');
}
