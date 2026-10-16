import { sessionManager, als } from './context.js';

/**
 * Universal setupFiles hook integration for Vitest 1.x, 2.x, and 3.x.
 * Works seamlessly across both sequential and concurrent test runs.
 */
let vitestHooks = null;
try {
  vitestHooks = await import('vitest');
} catch {
  // Silent fallback when vitest is not in worker scope
}

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
