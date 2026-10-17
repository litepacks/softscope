import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolves and imports a Vitest module either from standard import paths
 * or relative to the project root (process.cwd()) when softscope is linked via file: or npm link.
 *
 * @param {string} specifier - Module specifier, e.g. 'vitest' or 'vitest/runners'
 * @param {string} [cwd=process.cwd()] - Current working directory
 * @returns {Promise<any|null>}
 */
export async function resolveVitestModule(specifier = 'vitest', cwd = process.cwd()) {
  // 1. Try standard dynamic import (works when softscope is inside project node_modules)
  try {
    return await import(specifier);
  } catch {}

  // 2. Try resolving relative to project directory (works when softscope is linked or file: reference)
  try {
    const req = createRequire(path.join(cwd, 'package.json'));

    if (specifier === 'vitest') {
      const pkgPath = req.resolve('vitest/package.json');
      const pkgDir = path.dirname(pkgPath);
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const importEntry = pkgJson.exports?.['.']?.import?.default || './dist/index.js';
      const fullPath = path.resolve(pkgDir, importEntry);
      return await import(pathToFileURL(fullPath).href);
    } else if (specifier === 'vitest/runners') {
      const runnersPath = req.resolve('vitest/runners');
      return await import(pathToFileURL(runnersPath).href);
    } else {
      const resolved = req.resolve(specifier);
      return await import(pathToFileURL(resolved).href);
    }
  } catch {}

  return null;
}
