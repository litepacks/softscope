export function renderJsonReport(summary) {
  const payload = {
    version: 1,
    runtime: {
      durationMs: summary.durationMs,
      filesObserved: summary.filesObserved,
      functionsDiscovered: summary.functionsDiscovered,
      functionsExecuted: summary.functionsExecuted,
      functionCalls: summary.totalFunctionCalls,
      runtimeReach: {
        executedPercent: Number(summary.runtimeReach.executedPercent.toFixed(1)),
        notExecutedPercent: Number(summary.runtimeReach.notExecutedPercent.toFixed(1))
      }
    },
    files: summary.files.map(f => ({
      file: f.file,
      loadCount: f.loadCount,
      firstSeen: f.firstSeen,
      lastSeen: f.lastSeen,
      functionsDiscovered: f.functionsDiscovered,
      functionsExecuted: f.functionsExecuted,
      calls: f.calls,
      totalTimeMs: Number(f.totalTimeMs.toFixed(2))
    })),
    functions: summary.functions.map(fn => ({
      id: fn.id,
      file: fn.file,
      name: fn.name,
      line: fn.line,
      column: fn.column,
      type: fn.type,
      async: fn.async,
      calls: fn.calls,
      totalDurationMs: Number(fn.totalDurationMs.toFixed(2)),
      selfDurationMs: Number(fn.selfDurationMs.toFixed(2)),
      avgDurationMs: Number(fn.avgDurationMs.toFixed(2)),
      minDurationMs: Number(fn.minDurationMs.toFixed(2)),
      maxDurationMs: Number(fn.maxDurationMs.toFixed(2)),
      errors: fn.errors,
      maxConcurrent: fn.maxConcurrent
    })),
    edges: summary.edges.map(e => ({
      caller: e.caller,
      callee: e.callee,
      callerName: e.callerName,
      calleeName: e.calleeName,
      calls: e.calls
    }))
  };

  return JSON.stringify(payload, null, 2);
}
