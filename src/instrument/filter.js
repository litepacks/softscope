import path from 'node:path';
import picomatch from 'picomatch';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EXTENSIONS } from '../config.js';

// Resolve softscope directory so softscope never instruments itself
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_ROOT = path.resolve(__dirname, '..', '..');
const SOFTSCOPE_SRC = path.resolve(__dirname, '..');
const SOFTSCOPE_BIN = path.resolve(SOFTSCOPE_ROOT, 'bin');

export function createFilter(options = {}) {
  const {
    projectRoot = process.cwd(),
    include = [],
    exclude = [],
    includeNodeModules = false
  } = options;

  const resolvedRoot = path.resolve(projectRoot);
  const includeMatchers = include.length > 0
    ? include.map(pat => picomatch(pat, { dot: true }))
    : null;
  const excludeMatchers = exclude.length > 0
    ? exclude.map(pat => picomatch(pat, { dot: true }))
    : null;

  return function shouldInstrument(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;

    // Convert file:// URL if given
    let normalized = filePath;
    if (normalized.startsWith('file://')) {
      try {
        normalized = fileURLToPath(normalized);
      } catch {
        return false;
      }
    }

    normalized = path.resolve(normalized);

    // 1. Never instrument softscope itself (internal source or bin or installed module)
    if (
      normalized === SOFTSCOPE_SRC ||
      normalized.startsWith(SOFTSCOPE_SRC + path.sep) ||
      normalized === SOFTSCOPE_BIN ||
      normalized.startsWith(SOFTSCOPE_BIN + path.sep) ||
      normalized.includes(path.sep + 'node_modules' + path.sep + 'softscope' + path.sep) ||
      normalized.includes('softscope-autobench-runner')
    ) {
      return false;
    }

    // 2. Check extension
    const ext = path.extname(normalized);
    if (!DEFAULT_EXTENSIONS.has(ext)) {
      return false;
    }

    // 3. Exclude generated files (.d.ts, .map, .min.js, .bundle.js, *.generated.*)
    if (
      normalized.endsWith('.d.ts') ||
      normalized.endsWith('.d.mts') ||
      normalized.endsWith('.d.cts') ||
      normalized.includes('.generated.') ||
      normalized.endsWith('.min.js') ||
      normalized.endsWith('.bundle.js')
    ) {
      return false;
    }

    // 4. Must be inside project root (unless includeNodeModules is explicitly enabled and matches)
    if (!normalized.startsWith(resolvedRoot + path.sep) && normalized !== resolvedRoot) {
      return false;
    }

    // 5. Exclude node_modules unless requested
    if (!includeNodeModules && normalized.includes(path.sep + 'node_modules' + path.sep)) {
      return false;
    }

    // Relative path for glob matching
    const relPath = path.relative(resolvedRoot, normalized);

    // 6. Check exclude globs
    if (excludeMatchers) {
      for (const matcher of excludeMatchers) {
        if (matcher(relPath) || matcher(normalized)) {
          return false;
        }
      }
    }

    // 7. Check include globs (if provided)
    if (includeMatchers) {
      let matched = false;
      for (const matcher of includeMatchers) {
        if (matcher(relPath) || matcher(normalized)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  };
}
