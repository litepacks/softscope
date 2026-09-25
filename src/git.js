import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const SUPPORTED_CODE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx'
]);

/**
 * Checks whether a given directory is inside a Git working tree.
 */
export function isGitRepository(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8'
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Gets the root directory of the current Git repository.
 */
export function getGitRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8'
    });
    const root = out.trim();
    return fs.existsSync(root) ? fs.realpathSync(root) : root;
  } catch {
    return null;
  }
}

/**
 * Returns a list of absolute file paths for code files changed in Git.
 */
export function getGitChangedFiles(options = {}) {
  const cwd = options.projectRoot || process.cwd();
  if (!isGitRepository(cwd)) {
    return [];
  }

  const gitRoot = getGitRoot(cwd) || (fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd);
  const changedPaths = new Set();

  try {
    let diffArgs = ['diff', '--name-only'];
    if (options.staged) {
      diffArgs.push('--cached');
    } else if (options.since) {
      diffArgs.push(options.since);
    } else {
      diffArgs.push('HEAD');
    }

    const diffOutput = execFileSync('git', diffArgs, {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8'
    });

    for (const rel of diffOutput.split('\n')) {
      const trimmed = rel.trim();
      if (!trimmed) continue;
      const absPath = path.resolve(gitRoot, trimmed);
      const ext = path.extname(absPath).toLowerCase();
      if (SUPPORTED_CODE_EXTENSIONS.has(ext) && fs.existsSync(absPath)) {
        changedPaths.add(fs.realpathSync(absPath));
      }
    }
  } catch {
    // If HEAD is unborn or diff fails, try empty tree or git status
  }

  // Also include untracked/added files from git status (unless --staged is requested without untracked)
  if (!options.staged) {
    try {
      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: gitRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8'
      });

      for (const line of statusOutput.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const statusCode = line.slice(0, 2);
        const rel = line.slice(3).trim();
        // Untracked (??) or Added (A ) or Modified ( M / M )
        if (statusCode.includes('?') || statusCode.includes('A') || statusCode.includes('M')) {
          const absPath = path.resolve(gitRoot, rel);
          const ext = path.extname(absPath).toLowerCase();
          if (SUPPORTED_CODE_EXTENSIONS.has(ext) && fs.existsSync(absPath)) {
            changedPaths.add(fs.realpathSync(absPath));
          }
        }
      }
    } catch {
      // Ignore git status errors
    }
  }

  return Array.from(changedPaths);
}

/**
 * Returns a Set of 1-indexed line numbers modified in the working copy of filePath.
 * If the file is completely untracked / newly added, returns null (indicating all lines are changed).
 */
export function getGitChangedLines(filePath, options = {}) {
  const cwd = options.projectRoot || process.cwd();
  if (!isGitRepository(cwd)) {
    return null;
  }

  const gitRoot = getGitRoot(cwd) || (fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd);
  const absFile = path.resolve(cwd, filePath);
  const realFile = fs.existsSync(absFile) ? fs.realpathSync(absFile) : absFile;
  const relFile = path.relative(gitRoot, realFile);

  // 1. Check if untracked via git status
  try {
    const statusOut = execFileSync('git', ['status', '--porcelain', '--', relFile], {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8'
    });
    const trimmed = statusOut.trim();
    if (trimmed.startsWith('??')) {
      // Untracked file: all lines are considered changed
      return null;
    }
  } catch {
    // Continue
  }

  // 2. Run git diff with -U0 (zero context lines) to get exact hunks
  let diffArgs = ['diff', '-U0'];
  if (options.staged) {
    diffArgs.push('--cached');
  } else if (options.since) {
    diffArgs.push(options.since);
  } else {
    diffArgs.push('HEAD');
  }
  diffArgs.push('--', relFile);

  let diffOutput = '';
  try {
    diffOutput = execFileSync('git', diffArgs, {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8'
    });
  } catch {
    // If HEAD is unborn or error, treat file as untracked (all changed)
    return null;
  }

  if (!diffOutput.trim()) {
    // No changes in file
    return new Set();
  }

  const changedLines = new Set();
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

  for (const line of diffOutput.split('\n')) {
    const match = line.match(hunkRegex);
    if (!match) continue;

    const newStart = parseInt(match[1], 10);
    const newLines = match[2] !== undefined ? parseInt(match[2], 10) : 1;

    if (newLines === 0) {
      // Deletion at newStart: mark newStart line as affected
      changedLines.add(Math.max(1, newStart));
    } else {
      for (let i = 0; i < newLines; i++) {
        changedLines.add(newStart + i);
      }
    }
  }

  return changedLines;
}

/**
 * Filters a list of analyzed candidate functions to only those whose source ranges
 * overlap with modified Git line numbers.
 *
 * @param {Array} functions - Array of function objects with { name, line, endLine }
 * @param {Set<number>|null} changedLines - Set of 1-indexed changed line numbers, or null for all lines
 * @returns {Array} Filtered list of functions
 */
export function filterFunctionsByChangedLines(functions, changedLines) {
  if (!Array.isArray(functions)) return [];
  if (changedLines === null) {
    // All lines in file are new/changed
    return [...functions];
  }

  return functions.filter(fn => {
    const start = fn.line || 1;
    const end = fn.endLine || fn.line || 1;

    for (let l = start; l <= end; l++) {
      if (changedLines.has(l)) {
        return true;
      }
    }
    return false;
  });
}
