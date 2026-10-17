import { als, sessionManager } from './context.js';
import { resolveVitestModule } from './resolver.js';

/**
 * Resolves the underlying TestRunner class from Vitest.
 * Supports Vitest 1.x, 2.x, and 3.x across different module structures.
 */
async function resolveBaseRunner() {
  try {
    const mod = await resolveVitestModule('vitest/runners');
    if (mod && mod.VitestTestRunner) return mod.VitestTestRunner;
    if (mod && mod.TestRunner) return mod.TestRunner;
  } catch {}
  try {
    const mod = await resolveVitestModule('@vitest/runner');
    if (mod && mod.VitestTestRunner) return mod.VitestTestRunner;
    if (mod && mod.TestRunner) return mod.TestRunner;
  } catch {}
  try {
    const mod = await resolveVitestModule('vitest');
    if (mod && mod.VitestTestRunner) return mod.VitestTestRunner;
    if (mod && mod.TestRunner) return mod.TestRunner;
  } catch {}

  // Fallback runner when executed in mock or custom harness environments
  return class FallbackTestRunner {
    constructor(config) {
      this.config = config;
    }
    async runTest(test) {
      if (typeof test?.fn === 'function') {
        await test.fn();
      }
    }
  };
}

const BaseRunner = await resolveBaseRunner();

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

/**
 * Custom Vitest TestRunner that wraps each test execution in an
 * isolated AsyncLocalStorage session for function performance profiling.
 */
export class SoftscopeTestRunner extends BaseRunner {
  constructor(config) {
    super(config);
    sessionManager.init();
  }

  async _runWithSession(test, executeFn) {
    // Skip if test is intentionally disabled or ignored
    if (test?.mode === 'skip' || test?.mode === 'todo') {
      return executeFn();
    }

    const session = sessionManager.createSession(test);

    return als.run(session, async () => {
      try {
        return await executeFn();
      } finally {
        try {
          session.close();
          const serialized = session.serialize();
          const currentMeta = typeof test.meta === 'function' ? test.meta() : test.meta;
          const existingData = currentMeta?.softscope;
          // Only attach if serialized has metrics, or if no metrics exist yet
          if (serialized.metrics.length > 0 || !existingData || !existingData.metrics || existingData.metrics.length === 0) {
            attachMeta(test, serialized);
          }
        } catch (cleanupErr) {
          // Never mask real test assertions or worker crash errors
          console.error('[softscope] Error finalizing test session metrics:', cleanupErr);
        }
      }
    });
  }

  async runTask(test) {
    return this._runWithSession(test, async () => {
      if (super.runTask) {
        return await super.runTask(test);
      }
      const fn = typeof this.getTestFn === 'function' ? this.getTestFn(test) : test?.fn;
      if (typeof fn === 'function') {
        return await fn();
      }
    });
  }

  async runTest(test) {
    return this._runWithSession(test, async () => {
      if (super.runTest) {
        return await super.runTest(test);
      }
      if (super.runTask) {
        return await super.runTask(test);
      }
      if (typeof test?.fn === 'function') {
        return await test.fn();
      }
    });
  }
}

export default SoftscopeTestRunner;
