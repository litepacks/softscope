export function mergeSessionSnapshots(snapshots, overallDurationMs = 0) {
  if (!snapshots || snapshots.length === 0) {
    return {
      durationMs: overallDurationMs,
      filesObserved: 0,
      functionsDiscovered: 0,
      functionsExecuted: 0,
      functionsNeverExecuted: 0,
      totalFunctionCalls: 0,
      runtimeReach: {
        executedPercent: 0,
        notExecutedPercent: 0
      },
      files: [],
      functions: [],
      edges: [],
      topTotalTime: [],
      topSelfTime: [],
      mostCalled: [],
      slowestSingleCalls: []
    };
  }

  const fileMap = new Map(); // file -> { file, loadCount, firstSeen, lastSeen, functionsDiscovered, functionsExecuted, calls, totalTimeMs }
  const functionMap = new Map(); // key (file:name:line:col) -> aggregated function
  const edgeMap = new Map(); // callerName:calleeName -> calls

  let totalCalls = 0;

  for (const snap of snapshots) {
    totalCalls += snap.totalCalls || 0;

    // Aggregate files
    if (snap.files) {
      for (const f of snap.files) {
        let entry = fileMap.get(f.file);
        if (!entry) {
          entry = {
            file: f.file,
            loadCount: f.loadCount,
            firstSeen: f.firstSeen,
            lastSeen: f.lastSeen,
            functionsDiscovered: f.functionsDiscovered,
            functionsExecuted: 0,
            calls: 0,
            totalTimeMs: 0
          };
          fileMap.set(f.file, entry);
        } else {
          entry.loadCount += f.loadCount;
          entry.firstSeen = Math.min(entry.firstSeen, f.firstSeen);
          entry.lastSeen = Math.max(entry.lastSeen, f.lastSeen);
          entry.functionsDiscovered = Math.max(entry.functionsDiscovered, f.functionsDiscovered);
        }
      }
    }

    // Aggregate functions
    if (snap.functions) {
      for (const fn of snap.functions) {
        // Unique key for deduplication across reloads/workers
        const key = `${fn.file}:${fn.name}:${fn.line}:${fn.column}`;
        let entry = functionMap.get(key);
        if (!entry) {
          entry = {
            id: fn.id,
            file: fn.file,
            name: fn.name,
            line: fn.line,
            column: fn.column,
            type: fn.type,
            async: fn.async,
            generator: fn.generator,
            unsupported: fn.unsupported,
            calls: fn.calls,
            totalDurationMs: fn.totalDurationMs,
            selfDurationMs: fn.selfDurationMs,
            minDurationMs: fn.minDurationMs || 0,
            maxDurationMs: fn.maxDurationMs || 0,
            errors: fn.errors || 0,
            maxConcurrent: fn.maxConcurrent || 0
          };
          functionMap.set(key, entry);
        } else {
          entry.calls += fn.calls;
          entry.totalDurationMs += fn.totalDurationMs;
          entry.selfDurationMs += fn.selfDurationMs;
          if (fn.calls > 0) {
            entry.minDurationMs = entry.minDurationMs === 0 ? fn.minDurationMs : Math.min(entry.minDurationMs, fn.minDurationMs);
            entry.maxDurationMs = Math.max(entry.maxDurationMs, fn.maxDurationMs);
          }
          entry.errors += (fn.errors || 0);
          entry.maxConcurrent = Math.max(entry.maxConcurrent, fn.maxConcurrent || 0);
        }
      }
    }

    // Aggregate edges
    if (snap.edges) {
      for (const e of snap.edges) {
        const edgeKey = `${e.callerName}->${e.calleeName}`;
        let edge = edgeMap.get(edgeKey);
        if (!edge) {
          edge = {
            callerName: e.callerName,
            calleeName: e.calleeName,
            calls: e.calls
          };
          edgeMap.set(edgeKey, edge);
        } else {
          edge.calls += e.calls;
        }
      }
    }
  }

  const allFunctions = Array.from(functionMap.values());
  for (const fn of allFunctions) {
    fn.avgDurationMs = fn.calls > 0 ? fn.totalDurationMs / fn.calls : 0;
  }

  // Update file totals from functions
  const fileExecutedFns = new Map();
  for (const fn of allFunctions) {
    let fEntry = fileMap.get(fn.file);
    if (!fEntry) {
      fEntry = {
        file: fn.file,
        loadCount: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        functionsDiscovered: 0,
        functionsExecuted: 0,
        calls: 0,
        totalTimeMs: 0
      };
      fileMap.set(fn.file, fEntry);
    }
    fEntry.calls += fn.calls;
    fEntry.totalTimeMs += fn.totalDurationMs;

    if (fn.calls > 0) {
      let count = fileExecutedFns.get(fn.file) || 0;
      fileExecutedFns.set(fn.file, count + 1);
    }
  }

  for (const [filePath, fEntry] of fileMap.entries()) {
    fEntry.functionsExecuted = fileExecutedFns.get(filePath) || 0;
  }

  const functionsDiscovered = allFunctions.length;
  let functionsExecuted = 0;
  for (const fn of allFunctions) {
    if (fn.calls > 0) functionsExecuted++;
  }
  const functionsNeverExecuted = Math.max(0, functionsDiscovered - functionsExecuted);

  const executedPercent = functionsDiscovered > 0
    ? (functionsExecuted / functionsDiscovered) * 100
    : 0;
  const notExecutedPercent = functionsDiscovered > 0
    ? (functionsNeverExecuted / functionsDiscovered) * 100
    : 0;

  const files = Array.from(fileMap.values()).sort((a, b) => a.file.localeCompare(b.file));
  const edges = Array.from(edgeMap.values()).sort((a, b) => b.calls - a.calls);

  return {
    durationMs: overallDurationMs,
    filesObserved: files.length,
    functionsDiscovered,
    functionsExecuted,
    functionsNeverExecuted,
    totalFunctionCalls: totalCalls,
    runtimeReach: {
      executedPercent,
      notExecutedPercent
    },
    files,
    functions: allFunctions,
    edges
  };
}
