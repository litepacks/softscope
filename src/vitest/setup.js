import { sessionManager, als } from './context.js';

/**
 * Alternative setupFiles hook integration.
 * Note: While setupFiles works cleanly for sequential tests, for full test.concurrent
 * isolation, the custom SoftscopeTestRunner (configured via softscopeVitest() plugin)
 * is strongly recommended as Node.js AsyncLocalStorage requires enclosing execution blocks.
 */
let vitestHooks = null;
try {
  vitestHooks = await import('vitest');
} catch {
  // Silent fallback when vitest is not in worker scope
}

if (vitestHooks && typeof vitestHooks.beforeEach === 'function') {
  sessionManager.init();

  vitestHooks.beforeEach(async (context) => {
    const task = context.task;
    if (!task) return;
    const session = sessionManager.createSession(task);
    als.enterWith(session);
  });

  if (typeof vitestHooks.afterEach === 'function') {
    vitestHooks.afterEach(async (context) => {
      const task = context.task;
      const session = sessionManager.getActiveSession();
      if (session) {
        session.close();
        if (task) {
          if (!task.meta) task.meta = {};
          task.meta.softscope = session.serialize();
        }
      }
      als.enterWith(null);
    });
  }
}
