import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { sessionManager, als } from './context.js';
import { resolveVitestModule } from './resolver.js';
import { createFilter } from '../instrument/filter.js';
import { createFunctionRegistry } from '../instrument/registry.js';
import { transformSource } from '../instrument/transform.js';

/**
 * Universal setupFiles hook integration for Vitest 1.x, 2.x, 3.x, and 4.x.
 * Works seamlessly across both sequential and concurrent test runs.
 */
const vitestHooks = await resolveVitestModule('vitest');

// In Node worker environments (e.g. pool: 'forks' or CommonJS test files requiring local modules),
// hook Module._extensions so require() calls are transparently instrumented
const projectRoot = process.env.SOFTSCOPE_PROJECT_ROOT || process.cwd();
const filter = createFilter({ projectRoot });
const cjsRegistry = createFunctionRegistry();

function hookCjsExtension(ext) {
  const originalHandler = Module._extensions[ext] || Module._extensions['.js'];
  if (!originalHandler) return;

  Module._extensions[ext] = function softscopeVitestCjsExtension(module, filename) {
    if (
      !filter(filename) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
      /(global[-_]?setup|vitest\.setup|setup-files?)\.[cm]?[jt]sx?$/i.test(filename)
    ) {
      return originalHandler(module, filename);
    }

    try {
      const source = fs.readFileSync(filename, 'utf-8');
      if (source.includes('__softscope.enter')) {
        return originalHandler(module, filename);
      }

      const relPath = path.relative(projectRoot, filename).replace(/\\/g, '/');
      const transformed = transformSource(source, filename, relPath, cjsRegistry, {
        strict: false
      });

      if (!transformed.transformed) {
        return originalHandler(module, filename);
      }

      module._compile(transformed.code, filename);
    } catch {
      return originalHandler(module, filename);
    }
  };
}

hookCjsExtension('.js');
hookCjsExtension('.cjs');

function attachMeta(target, data) {
  if (!target) return;
  try {
    if (typeof target.meta === 'function') {
      const m = target.meta();
      if (m && typeof m === 'object') {
        m.softscope = data;
      }
      target.meta.softscope = data;
    } else {
      if (!target.meta) target.meta = {};
      target.meta.softscope = data;
    }
  } catch {}
}

if (vitestHooks && typeof vitestHooks.beforeEach === 'function') {
  sessionManager.init();

  vitestHooks.beforeEach(async (context) => {
    const task = context?.task || context;
    if (!task) return;

    // If an active session is already running (e.g. via SoftscopeTestRunner),
    // do not create a duplicate session or clobber ALS
    const currentSession = sessionManager.getActiveSession();
    if (currentSession && currentSession.isActive()) {
      return;
    }

    const session = sessionManager.createSession(task);
    als.enterWith(session);

    // Prefer onTestFinished when available (Vitest 1.4+ and 2.x/3.x)
    if (typeof vitestHooks.onTestFinished === 'function') {
      vitestHooks.onTestFinished(() => {
        if (!session.isActive()) return;
        session.close();
        if (sessionManager.currentActiveSession === session) {
          sessionManager.currentActiveSession = null;
        }
        const serialized = session.serialize();
        attachMeta(task, serialized);
        if (context && context !== task) {
          attachMeta(context, serialized);
        }
        als.enterWith(null);
      });
    }
  });

  if (typeof vitestHooks.afterEach === 'function') {
    vitestHooks.afterEach(async (context) => {
      const task = context?.task || context;
      const session = sessionManager.getActiveSession();
      if (session && session.isActive()) {
        session.close();
        if (sessionManager.currentActiveSession === session) {
          sessionManager.currentActiveSession = null;
        }
        const serialized = session.serialize();
        attachMeta(task, serialized);
        if (context && context !== task) {
          attachMeta(context, serialized);
        }
        als.enterWith(null);
      }
    });
  }
}
