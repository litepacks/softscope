import { register } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeCollector } from '../runtime/collector.js';
import { setupSession } from '../runtime/session.js';
import { createFilter } from '../instrument/filter.js';
import { createFunctionRegistry } from '../instrument/registry.js';
import { transformSource } from '../instrument/transform.js';

// 1. Initialize global collector in the current process
if (!globalThis.__softscope) {
  let initialConfig = {};
  try {
    if (process.env.SOFTSCOPE_CONFIG) {
      initialConfig = JSON.parse(process.env.SOFTSCOPE_CONFIG);
    }
  } catch {
    initialConfig = {};
  }

  const collector = new RuntimeCollector();
  if (initialConfig.captureSeeds) {
    collector.captureSeeds = true;
  }
  setupSession(collector);

  globalThis.__softscope = {
    enter: (id, args) => collector.enter(id, args),
    exit: (id, isError) => collector.exit(id, isError),
    registerFile: (file, fns) => collector.registerFile(file, fns),
    _collector: collector
  };
}

// 2. Register ESM hook
try {
  register('./hooks.mjs', import.meta.url);
} catch (err) {
  // If register is not available or already registered, proceed
}

// 3. Register CommonJS hooks
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

const cjsRegistry = createFunctionRegistry();

function hookCjsExtension(ext) {
  const originalHandler = Module._extensions[ext] || Module._extensions['.js'];
  if (!originalHandler) return;

  Module._extensions[ext] = function softscopeCjsExtension(module, filename) {
    if (!filter(filename)) {
      return originalHandler(module, filename);
    }

    try {
      const source = fs.readFileSync(filename, 'utf-8');

      // Idempotency check: don't double instrument
      if (source.includes('__softscope.enter')) {
        return originalHandler(module, filename);
      }

      const relPath = path.relative(projectRoot, filename);
      const transformed = transformSource(source, filename, relPath, cjsRegistry, {
        strict: Boolean(config.strict),
        captureSeeds: Boolean(config.captureSeeds)
      });

      module._compile(transformed.code, filename);
    } catch (err) {
      if (config.strict) throw err;
      return originalHandler(module, filename);
    }
  };
}

hookCjsExtension('.js');
hookCjsExtension('.cjs');
