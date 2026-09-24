import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFilter } from '../instrument/filter.js';
import { createFunctionRegistry } from '../instrument/registry.js';
import { transformSource } from '../instrument/transform.js';

let config = {};
try {
  if (process.env.SOFTSCOPE_CONFIG) {
    config = JSON.parse(process.env.SOFTSCOPE_CONFIG);
  }
} catch {
  config = {};
}

const projectRoot = config.projectRoot ? path.resolve(config.projectRoot) : process.cwd();
const filter = createFilter({
  projectRoot,
  include: config.include || [],
  exclude: config.exclude || [],
  includeNodeModules: Boolean(config.includeNodeModules)
});

const registry = createFunctionRegistry();

export async function load(url, context, nextLoad) {
  let result;
  try {
    result = await nextLoad(url, context);
  } catch (err) {
    throw err;
  }

  // Only handle file: protocol
  if (!url.startsWith('file://')) {
    return result;
  }

  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return result;
  }

  // Check filter
  if (!filter(filePath)) {
    return result;
  }

  // Only instrument JavaScript/TypeScript formats
  if (result.format && result.format !== 'module' && result.format !== 'commonjs') {
    return result;
  }

  // Let CommonJS modules be loaded by Node's standard CJS loader and Module._extensions
  // in register.js. In Node 20, returning a string source for 'commonjs' forces Node to use
  // loadCJSModule (translators.js), which breaks nested synchronous require() calls on packages
  // that have "type": "module" with "exports.require" (e.g. htmlparser2) with ERR_VM_MODULE_LINK_FAILURE.
  if (result.format === 'commonjs') {
    return result;
  }

  let source = result.source;
  if (source === undefined || source === null) {
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return result;
    }
  } else if (Buffer.isBuffer(source)) {
    source = source.toString('utf-8');
  }

  // Idempotency check: don't double instrument
  if (typeof source === 'string' && source.includes('__softscope.enter')) {
    return result;
  }

  const relativePath = path.relative(projectRoot, filePath);
  const transformed = transformSource(source, filePath, relativePath, registry, {
    strict: Boolean(config.strict),
    captureSeeds: Boolean(config.captureSeeds)
  });

  return {
    format: result.format || 'module',
    source: transformed.code,
    shortCircuit: true
  };
}
