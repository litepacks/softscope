import { AsyncLocalStorage } from 'node:async_hooks';
import { CallStack } from '../runtime/stack.js';

export const als = new AsyncLocalStorage();

/**
 * Worker-wide registry of instrumented function metadata.
 * Populated via __softscope.registerFile(filePath, functions).
 */
export const fileRegistry = new Map(); // id -> FunctionMetadata

/**
 * Global counters for unattributed or out-of-session calls.
 */
export const globalStats = {
  unattributedCalls: 0,
  lateCalls: 0
};

export class TestSession {
  /**
   * @param {Object} params
   * @param {string} params.testId
   * @param {string} params.testName
   * @param {string} params.filePath
   * @param {string} [params.projectName='']
   * @param {number} [params.retry=0]
   * @param {number} [params.repeat=0]
   */
  constructor({ testId, testName, filePath, projectName = '', retry = 0, repeat = 0 }) {
    this.sessionId = `sess_${process.pid}_${testId}_${retry}_${Math.random().toString(36).slice(2, 8)}`;
    this.testId = testId;
    this.testName = testName;
    this.filePath = filePath;
    this.projectName = projectName;
    this.retry = retry;
    this.repeat = repeat;

    // Stable baseline key across runs
    const projectPrefix = projectName ? `${projectName}::` : '';
    this.baselineKey = `${projectPrefix}${filePath} > ${testName}`;

    this.state = 'active'; // 'active' | 'closed'
    this.startedAt = performance.now();
    this.endedAt = null;
    this.lateCallsCount = 0;

    // Aggregated metrics per function id
    this.metrics = new Map(); // id -> ScopedMetric
    this.stack = new CallStack();
  }

  isActive() {
    return this.state === 'active';
  }

  enter(id, args) {
    if (!this.isActive()) {
      this.lateCallsCount++;
      globalStats.lateCalls++;
      return;
    }

    const now = performance.now();
    let m = this.metrics.get(id);
    if (!m) {
      m = {
        id,
        calls: 0,
        totalDurationMs: 0,
        selfDurationMs: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
        errors: 0
      };
      this.metrics.set(id, m);
    }

    this.stack.enter(id, now);
  }

  exit(id, isError = false) {
    if (!this.isActive()) {
      return;
    }

    const now = performance.now();
    const res = this.stack.exit(id, now);
    const m = this.metrics.get(id);
    if (m) {
      m.calls++;
      m.totalDurationMs += res.duration;
      m.selfDurationMs += res.selfTime;
      if (res.duration < m.minDurationMs) {
        m.minDurationMs = res.duration;
      }
      if (res.duration > m.maxDurationMs) {
        m.maxDurationMs = res.duration;
      }
      if (isError) {
        m.errors++;
      }
    }
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.endedAt = performance.now();
    this.stack.reset();
  }

  serialize(registry = fileRegistry) {
    const durationMs = this.endedAt ? (this.endedAt - this.startedAt) : 0;
    const metricList = [];

    for (const m of this.metrics.values()) {
      const meta = registry.get(m.id) || {};
      const avgDurationMs = m.calls > 0 ? m.totalDurationMs / m.calls : 0;
      const minDurationMs = m.minDurationMs === Infinity ? 0 : m.minDurationMs;

      metricList.push({
        id: m.id,
        name: meta.name || `fn#${m.id}`,
        file: meta.file || this.filePath,
        line: meta.line || 0,
        column: meta.column || 0,
        calls: m.calls,
        totalDurationMs: Number(m.totalDurationMs.toFixed(3)),
        selfDurationMs: Number(m.selfDurationMs.toFixed(3)),
        avgDurationMs: Number(avgDurationMs.toFixed(3)),
        minDurationMs: Number(minDurationMs.toFixed(3)),
        maxDurationMs: Number(m.maxDurationMs.toFixed(3)),
        errors: m.errors
      });
    }

    return {
      sessionId: this.sessionId,
      testId: this.testId,
      testName: this.testName,
      file: this.filePath,
      projectName: this.projectName,
      retry: this.retry,
      repeat: this.repeat,
      baselineKey: this.baselineKey,
      durationMs: Number(durationMs.toFixed(3)),
      lateCallsCount: this.lateCallsCount,
      metrics: metricList
    };
  }
}

/**
 * Worker-level session coordinator.
 */
export class SessionManager {
  constructor() {
    this.activeSessions = new Map(); // sessionId -> TestSession
  }

  init() {
    if (globalThis.__softscope && globalThis.__softscope._isVitest) {
      return;
    }

    globalThis.__softscope = {
      _isVitest: true,
      enter: (id, args) => {
        const session = als.getStore();
        if (session) {
          session.enter(id, args);
        } else {
          globalStats.unattributedCalls++;
        }
      },
      exit: (id, isError) => {
        const session = als.getStore();
        if (session) {
          session.exit(id, isError);
        }
      },
      registerFile: (file, fns) => {
        if (Array.isArray(fns)) {
          for (const fn of fns) {
            fileRegistry.set(fn.id, fn);
          }
        }
      },
      _sessionManager: this,
      _als: als,
      _registry: fileRegistry
    };
  }

  /**
   * Constructs a TestSession from a Vitest Task object.
   * Handles suite hierarchy for full test names and relative file paths.
   */
  createSession(task) {
    const testId = String(task.id || task.name || Math.random());
    const fullTestName = getTaskFullName(task);
    const filePath = getTaskFilePath(task);
    const projectName = (task.file && task.file.projectName) || (task.suite && task.suite.file && task.suite.file.projectName) || '';
    const retry = Number(task.retry || 0);
    const repeat = Number(task.repeat || 0);

    const session = new TestSession({
      testId,
      testName: fullTestName,
      filePath,
      projectName,
      retry,
      repeat
    });

    this.activeSessions.set(session.sessionId, session);
    return session;
  }

  getActiveSession() {
    return als.getStore() || null;
  }
}

export function getTaskFullName(task) {
  if (!task) return 'anonymous test';
  const parts = [];
  let current = task;
  while (current) {
    if (current.name && current.name !== '') {
      parts.unshift(current.name);
    }
    current = current.suite;
  }
  return parts.join(' > ') || task.name || 'anonymous test';
}

export function getTaskFilePath(task) {
  let file = task.file || (task.suite && task.suite.file);
  if (file && typeof file === 'object') {
    return file.filepath || file.name || 'unknown';
  }
  if (typeof file === 'string') {
    return file;
  }
  return 'unknown';
}

export const sessionManager = new SessionManager();
