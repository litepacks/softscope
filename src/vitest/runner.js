import { als, sessionManager } from './context.js';

/**
 * Resolves the underlying TestRunner class from Vitest.
 * Supports Vitest 1.x, 2.x, and 3.x across different module structures.
 */
async function resolveBaseRunner() {
  try {
    const mod = await import('vitest/runners');
    if (mod.TestRunner) return mod.TestRunner;
  } catch {}
  try {
    const mod = await import('vitest');
    if (mod.TestRunner) return mod.TestRunner;
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
      return super.runTest(test);
    }

    const session = sessionManager.createSession(test);

    return als.run(session, async () => {
      try {
        await super.runTest(test);
      } finally {
        try {
          session.close();
          if (!test.meta) {
            test.meta = {};
          }
          // Attach serialized performance metrics for Vitest reporter RPC transfer
          test.meta.softscope = session.serialize();
        } catch (cleanupErr) {
          // Never mask real test assertions or worker crash errors
          console.error('[softscope] Error finalizing test session metrics:', cleanupErr);
        }
      }
    });
  }
}

export default SoftscopeTestRunner;
