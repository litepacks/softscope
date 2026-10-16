import { als, sessionManager } from './context.js';

/**
 * Resolves the underlying TestRunner class from Vitest.
 * Supports Vitest 1.x, 2.x, and 3.x across different module structures.
 */
async function resolveBaseRunner() {
  try {
    const mod = await import('vitest/runners');
    if (mod.TestRunner) return mod.TestRunner;
    if (mod.VitestTestRunner) return mod.VitestTestRunner;
  } catch {}
  try {
    const mod = await import('@vitest/runner');
    if (mod.TestRunner) return mod.TestRunner;
    if (mod.VitestTestRunner) return mod.VitestTestRunner;
  } catch {}
  try {
    const mod = await import('vitest');
    if (mod.TestRunner) return mod.TestRunner;
    if (mod.VitestTestRunner) return mod.VitestTestRunner;
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

  async runTest(test) {
    // Skip if test is intentionally disabled or ignored
    if (test?.mode === 'skip' || test?.mode === 'todo') {
      return super.runTest ? super.runTest(test) : undefined;
    }

    const session = sessionManager.createSession(test);

    return als.run(session, async () => {
      try {
        if (super.runTest) {
          await super.runTest(test);
        } else if (typeof test?.fn === 'function') {
          await test.fn();
        }
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
}

export default SoftscopeTestRunner;
