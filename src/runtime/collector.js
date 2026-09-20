const perf = globalThis.performance || { now: () => Date.now() };
import { CallStack } from './stack.js';

export class RuntimeCollector {
  constructor(initialCapacity = 2048) {
    this.capacity = initialCapacity;
    this.calls = new Uint32Array(this.capacity);
    this.totalTime = new Float64Array(this.capacity);
    this.selfTime = new Float64Array(this.capacity);
    this.minTime = new Float64Array(this.capacity);
    this.minTime.fill(Infinity);
    this.maxTime = new Float64Array(this.capacity);
    this.inFlight = new Uint32Array(this.capacity);
    this.maxConcurrent = new Uint32Array(this.capacity);
    this.errors = new Uint32Array(this.capacity);

    this.stack = new CallStack();
    this.edges = new Map(); // "caller->callee" -> count
    this.files = new Map(); // filePath -> fileStats
    this.metadata = new Map(); // id -> FunctionMetadata
    this.startTime = Date.now();
  }

  _ensureCapacity(id) {
    if (id < this.capacity) return;

    let newCapacity = this.capacity * 2;
    while (id >= newCapacity) {
      newCapacity *= 2;
    }

    const newCalls = new Uint32Array(newCapacity);
    const newTotal = new Float64Array(newCapacity);
    const newSelf = new Float64Array(newCapacity);
    const newMin = new Float64Array(newCapacity);
    newMin.fill(Infinity);
    const newMax = new Float64Array(newCapacity);
    const newInFlight = new Uint32Array(newCapacity);
    const newMaxConcurrent = new Uint32Array(newCapacity);
    const newErrors = new Uint32Array(newCapacity);

    newCalls.set(this.calls);
    newTotal.set(this.totalTime);
    newSelf.set(this.selfTime);
    newMin.set(this.minTime);
    newMax.set(this.maxTime);
    newInFlight.set(this.inFlight);
    newMaxConcurrent.set(this.maxConcurrent);
    newErrors.set(this.errors);

    this.capacity = newCapacity;
    this.calls = newCalls;
    this.totalTime = newTotal;
    this.selfTime = newSelf;
    this.minTime = newMin;
    this.maxTime = newMax;
    this.inFlight = newInFlight;
    this.maxConcurrent = newMaxConcurrent;
    this.errors = newErrors;
  }

  registerFile(filePath, functions = []) {
    const now = Date.now();
    let stats = this.files.get(filePath);

    if (!stats) {
      stats = {
        file: filePath,
        loadCount: 1,
        firstSeen: now,
        lastSeen: now,
        functionsDiscovered: functions.length,
        functionsExecuted: 0
      };
      this.files.set(filePath, stats);
    } else {
      stats.loadCount++;
      stats.lastSeen = now;
      if (functions.length > 0) {
        stats.functionsDiscovered = functions.length;
      }
    }

    for (const fn of functions) {
      this._ensureCapacity(fn.id);
      this.metadata.set(fn.id, fn);
    }
  }

  enter(id) {
    this._ensureCapacity(id);
    const now = performance.now();

    this.inFlight[id]++;
    if (this.inFlight[id] > this.maxConcurrent[id]) {
      this.maxConcurrent[id] = this.inFlight[id];
    }

    const callerId = this.stack.enter(id, now);
    if (callerId !== null) {
      const edgeKey = `${callerId}->${id}`;
      this.edges.set(edgeKey, (this.edges.get(edgeKey) || 0) + 1);
    }
  }

  exit(id, isError = false) {
    const now = performance.now();
    if (id < this.capacity && this.inFlight[id] > 0) {
      this.inFlight[id]--;
    }

    if (isError && id < this.capacity) {
      this.errors[id]++;
    }

    const res = this.stack.exit(id, now);
    const duration = res.duration;
    const self = res.selfTime;

    this.calls[id]++;
    this.totalTime[id] += duration;
    this.selfTime[id] += self;

    if (duration > this.maxTime[id]) {
      this.maxTime[id] = duration;
    }
    if (duration < this.minTime[id]) {
      this.minTime[id] = duration;
    }
  }

  getActiveCount() {
    let total = 0;
    for (let i = 1; i < this.capacity; i++) {
      total += this.inFlight[i];
    }
    return total;
  }

  getHotFunctions(limit = 5) {
    const list = [];
    for (const [id, meta] of this.metadata.entries()) {
      const callCount = this.calls[id];
      if (callCount > 0) {
        list.push({
          id,
          name: meta.name,
          file: meta.file,
          line: meta.line,
          column: meta.column,
          calls: callCount,
          totalDurationMs: this.totalTime[id],
          selfDurationMs: this.selfTime[id]
        });
      }
    }
    list.sort((a, b) => b.calls - a.calls);
    return list.slice(0, limit);
  }

  getSnapshot() {
    const executedFunctionsMap = new Map(); // file -> Set of executed fn IDs
    let totalFunctionCalls = 0;

    const functions = [];
    for (const [id, meta] of this.metadata.entries()) {
      const callCount = this.calls[id];
      totalFunctionCalls += callCount;

      if (callCount > 0) {
        let set = executedFunctionsMap.get(meta.file);
        if (!set) {
          set = new Set();
          executedFunctionsMap.set(meta.file, set);
        }
        set.add(id);
      }

      const totalMs = this.totalTime[id];
      const selfMs = this.selfTime[id];
      const minMs = this.minTime[id] === Infinity ? 0 : this.minTime[id];
      const maxMs = this.maxTime[id];
      const avgMs = callCount > 0 ? totalMs / callCount : 0;

      functions.push({
        id,
        file: meta.file,
        name: meta.name,
        line: meta.line,
        column: meta.column,
        type: meta.type,
        async: meta.async,
        generator: meta.generator,
        unsupported: meta.unsupported,
        calls: callCount,
        totalDurationMs: totalMs,
        selfDurationMs: selfMs,
        avgDurationMs: avgMs,
        minDurationMs: minMs,
        maxDurationMs: maxMs,
        errors: this.errors[id],
        maxConcurrent: this.maxConcurrent[id],
        currentlyActive: this.inFlight[id]
      });
    }

    const files = [];
    for (const [filePath, stats] of this.files.entries()) {
      const executedSet = executedFunctionsMap.get(filePath);
      const executedCount = executedSet ? executedSet.size : 0;

      let fileCalls = 0;
      let fileTotalMs = 0;
      for (const fn of functions) {
        if (fn.file === filePath) {
          fileCalls += fn.calls;
          fileTotalMs += fn.totalDurationMs;
        }
      }

      files.push({
        file: stats.file,
        loadCount: stats.loadCount,
        firstSeen: stats.firstSeen,
        lastSeen: stats.lastSeen,
        functionsDiscovered: stats.functionsDiscovered,
        functionsExecuted: executedCount,
        calls: fileCalls,
        totalTimeMs: fileTotalMs
      });
    }

    const edges = [];
    for (const [key, count] of this.edges.entries()) {
      const [callerStr, calleeStr] = key.split('->');
      const callerId = parseInt(callerStr, 10);
      const calleeId = parseInt(calleeStr, 10);
      const callerMeta = this.metadata.get(callerId);
      const calleeMeta = this.metadata.get(calleeId);

      edges.push({
        caller: callerId,
        callee: calleeId,
        callerName: callerMeta ? callerMeta.name : `fn#${callerId}`,
        calleeName: calleeMeta ? calleeMeta.name : `fn#${calleeId}`,
        calls: count
      });
    }

    const totalDiscovered = functions.length;
    let totalExecuted = 0;
    for (const fn of functions) {
      if (fn.calls > 0) totalExecuted++;
    }

    const currentPid = typeof process !== 'undefined' && process && process.pid ? process.pid : 1;

    return {
      pid: currentPid,
      threadId: 0,
      startTime: this.startTime,
      durationMs: Date.now() - this.startTime,
      totalCalls: totalFunctionCalls,
      totalDiscovered,
      totalExecuted,
      files,
      functions,
      edges
    };
  }

  reset() {
    this.calls.fill(0);
    this.totalTime.fill(0);
    this.selfTime.fill(0);
    this.minTime.fill(Infinity);
    this.maxTime.fill(0);
    this.inFlight.fill(0);
    this.maxConcurrent.fill(0);
    this.errors.fill(0);
    this.edges.clear();
    this.stack = new CallStack(this.stack.capacity);
    this.startTime = Date.now();
  }
}
