import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { analyzeModule } from './analyze.js';
import { loadSeedsFile, synthesizeSeeds } from './seeds.js';
import {
  renderAutoBenchTerminalReport,
  renderAutoBenchMarkdownReport,
  renderAutoBenchAiReport,
  renderAutoBenchJsonReport
} from './report.js';
import { createProgressReporter } from './progress.js';
import { promptFunctionPicker } from '../picker.js';
import { runWatchLoop } from '../watch.js';
import { parseStackFrame, createCodeFrame } from '../report/codeframe.js';
import { loadBaseline } from '../report/compare.js';
import {
  computeAutoBenchDelta,
  renderAutoBenchCompareTerminalReport,
  renderAutoBenchCompareMarkdownReport,
  renderAutoBenchCompareAiReport,
  renderAutoBenchCompareJsonReport
} from './compare.js';
import { recordDiscoveredCrashes } from './replay.js';
import {
  isGitRepository,
  getGitChangedFiles,
  getGitChangedLines,
  filterFunctionsByChangedLines
} from '../git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generates temporary benchmark runner code to execute candidate functions safely.
 */
function generateRunnerScript(filePath, testCases, iterations = 10000, resultsPath) {
  const targetUrl = pathToFileURL(filePath).href;

  return `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

function getHeapSpaceUsed() {
  try {
    const spaces = v8.getHeapSpaceStatistics();
    let total = 0;
    for (let i = 0; i < spaces.length; i++) {
      total += spaces[i].space_used_size;
    }
    return total;
  } catch {
    return process.memoryUsage().heapUsed;
  }
}

// Prevent console pollution, stdout interference, and premature process.exit during micro-benchmarking
const noop = () => {};
const origLog = console.log;
const origInfo = console.info;
const origWarn = console.warn;
const origError = console.error;
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origExit = process.exit.bind(process);

function mute() {
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  process.stdout.write = noop;
  process.stderr.write = noop;
  process.exit = (code) => {
    throw new Error('process.exit(' + code + ') called');
  };
}

function unmute() {
  console.log = origLog;
  console.info = origInfo;
  console.warn = origWarn;
  console.error = origError;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exit = origExit;
}

function callOrConstruct(fn, args) {
  try {
    return fn(...args);
  } catch (err) {
    if (err instanceof TypeError && err.message && err.message.includes("cannot be invoked without 'new'")) {
      return new fn(...args);
    }
    throw err;
  }
}

async function run() {
  let targetMod;
  try {
    targetMod = await import(${JSON.stringify(targetUrl)});
  } catch (importErr) {
    unmute();
    origError('[softscope-autobench-import-error]', importErr);
    process.exit(1);
  }

  // Reset collector to ignore top-level module evaluation side-effects
  if (globalThis.__softscope && globalThis.__softscope._collector) {
    globalThis.__softscope._collector.reset();
  }

  const testCases = ${JSON.stringify(testCases)};
  const targetIterations = ${iterations};
  const results = [];
  const totalCases = testCases.length;

  for (let t = 0; t < totalCases; t++) {
    const tc = testCases[t];
    origStderrWrite('__SOFTSCOPE_EVENT__' + JSON.stringify({
      type: 'start',
      index: t + 1,
      total: totalCases,
      name: tc.name,
      exportName: tc.exportName
    }) + '\\n');

    let fn = targetMod[tc.exportName];
    if (!fn && targetMod.default && typeof targetMod.default === 'object') {
      fn = targetMod.default[tc.exportName];
    }
    if (!fn && tc.exportName === 'default' && typeof targetMod.default === 'function') {
      fn = targetMod.default;
    }

    if (typeof fn !== 'function') {
      results.push({
        name: tc.name,
        exportName: tc.exportName,
        status: 'not_callable',
        error: 'Export is not a callable function'
      });
      origStderrWrite('__SOFTSCOPE_EVENT__' + JSON.stringify({
        type: 'done',
        index: t + 1,
        total: totalCases,
        name: tc.name,
        exportName: tc.exportName,
        status: 'not_callable',
        error: 'Export is not a callable function'
      }) + '\\n');
      continue;
    }

    const baselineSeed = tc.baselineSeed;
    const isAsync = tc.async;

    mute();

    // 1. Warmup
    try {
      for (let i = 0; i < 50; i++) {
        const p = callOrConstruct(fn, baselineSeed);
        if (isAsync && p && typeof p.then === 'function') {
          await p;
        }
      }
    } catch (warmupErr) {
      unmute();
      results.push({
        name: tc.name,
        exportName: tc.exportName,
        status: 'error',
        error: warmupErr.message || String(warmupErr)
      });
      origStderrWrite('__SOFTSCOPE_EVENT__' + JSON.stringify({
        type: 'done',
        index: t + 1,
        total: totalCases,
        name: tc.name,
        exportName: tc.exportName,
        status: 'error',
        error: warmupErr.message || String(warmupErr)
      }) + '\\n');
      continue;
    }

    // 2. Measure Memory Allocations (B/op)
    let bytesPerOp = 0;
    try {
      const allocBatch = isAsync ? Math.min(targetIterations, 100) : Math.min(targetIterations, 1000);
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        globalThis.gc();
      }
      const s0 = getHeapSpaceUsed();
      const s1 = getHeapSpaceUsed();
      const selfNoise = Math.max(0, s1 - s0);

      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
        globalThis.gc();
      }
      const h0 = getHeapSpaceUsed();
      if (isAsync) {
        for (let i = 0; i < allocBatch; i++) {
          const p = callOrConstruct(fn, baselineSeed);
          if (p && typeof p.then === 'function') await p;
        }
      } else {
        for (let i = 0; i < allocBatch; i++) {
          callOrConstruct(fn, baselineSeed);
        }
      }
      const h1 = getHeapSpaceUsed();
      const rawBytes = Math.max(0, h1 - h0);
      const netBytes = Math.max(0, rawBytes - selfNoise);
      const bOp = netBytes / allocBatch;
      bytesPerOp = bOp <= 10 ? 0 : Math.round(bOp * 10) / 10;
    } catch {
      bytesPerOp = 0;
    }

    // 3. Timed Measurement Loop & GC Tracking
    let gcCount = 0;
    let gcTimeMs = 0;
    let gcObs = null;
    try {
      gcObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          gcCount++;
          gcTimeMs += e.duration;
        }
      });
      gcObs.observe({ entryTypes: ['gc'] });
    } catch {}

    let iters = 0;
    const start = performance.now();

    try {
      if (isAsync) {
        const asyncIters = Math.min(targetIterations, 500);
        for (let i = 0; i < asyncIters; i++) {
          const p = callOrConstruct(fn, baselineSeed);
          if (p && typeof p.then === 'function') await p;
          iters++;
        }
      } else {
        for (let i = 0; i < targetIterations; i++) {
          callOrConstruct(fn, baselineSeed);
          iters++;
        }
      }
    } catch (loopErr) {
      // Loop execution error
    }

    const totalTimeMs = performance.now() - start;

    if (gcObs) {
      try {
        await new Promise(r => setTimeout(r, 5));
        gcObs.disconnect();
      } catch {}
    }

    const avgMs = iters > 0 ? totalTimeMs / iters : 0;
    const opsPerSec = totalTimeMs > 0 ? Math.round((iters / totalTimeMs) * 1000) : 0;

    // Sample individual min/max latency
    let minMs = Infinity;
    let maxMs = 0;
    const sampleCount = 30;
    for (let s = 0; s < sampleCount; s++) {
      try {
        const s0 = performance.now();
        const p = callOrConstruct(fn, baselineSeed);
        if (isAsync && p && typeof p.then === 'function') await p;
        const d = performance.now() - s0;
        if (d < minMs) minMs = d;
        if (d > maxMs) maxMs = d;
      } catch {
        // Ignore sampling errors
      }
    }
    if (minMs === Infinity) minMs = avgMs;

    // 3. Edge-Case Fuzzing & Latency Cliff Detection
    const cliffs = [];
    const crashes = [];

    for (const fuzzCase of tc.fuzzSeeds || []) {
      try {
        const f0 = performance.now();
        const p = callOrConstruct(fn, fuzzCase.args);
        if (p && typeof p.then === 'function') await p;
        const fDuration = performance.now() - f0;

        // Flag latency cliff if execution is > 10x average and at least 0.5ms
        if (fDuration > 10 * avgMs && fDuration >= 0.5) {
          cliffs.push({
            label: fuzzCase.label,
            seed: fuzzCase.args,
            durationMs: fDuration,
            avgMs,
            factor: Number((fDuration / Math.max(avgMs, 0.0001)).toFixed(1))
          });
        }
      } catch (fuzzErr) {
        crashes.push({
          label: fuzzCase.label,
          seed: fuzzCase.args,
          args: fuzzCase.args,
          error: fuzzErr.message || String(fuzzErr),
          stack: fuzzErr.stack || ''
        });
      }
    }

    unmute();

    results.push({
      name: tc.name,
      exportName: tc.exportName,
      status: 'ok',
      async: isAsync,
      iterations: iters,
      totalTimeMs,
      opsPerSec,
      bytesPerOp,
      gcCount,
      gcTimeMs: Number(gcTimeMs.toFixed(2)),
      avgMs,
      minMs,
      maxMs,
      baselineSeed,
      cliffs,
      crashes
    });

    origStderrWrite('__SOFTSCOPE_EVENT__' + JSON.stringify({
      type: 'done',
      index: t + 1,
      total: totalCases,
      name: tc.name,
      exportName: tc.exportName,
      status: 'ok',
      opsPerSec,
      bytesPerOp,
      avgMs,
      cliffs: cliffs.length,
      crashes: crashes.length
    }) + '\\n');
  }

  let callEdges = [];
  if (globalThis.__softscope && globalThis.__softscope._collector) {
    const snap = globalThis.__softscope._collector.getSnapshot();
    callEdges = snap.edges || [];
  }

  unmute();
  const payload = {
    functions: results,
    callEdges
  };
  fs.writeFileSync(${JSON.stringify(resultsPath)}, JSON.stringify(payload), 'utf-8');
}

run().catch((err) => {
  unmute();
  origError('[softscope-autobench-runner-error]', err);
  process.exit(1);
});
`;
}

function findProjectRoot(targetFile, fallbackRoot) {
  let currentDir = path.dirname(path.resolve(targetFile));
  const root = path.parse(currentDir).root;
  while (currentDir && currentDir !== root) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return fallbackRoot || process.cwd();
}

function findTsRunner(targetFile, projectRoot) {
  let currentDir = path.dirname(targetFile);
  const root = path.parse(currentDir).root;
  while (currentDir && currentDir !== root) {
    const candidate = path.join(currentDir, 'node_modules', '.bin', 'tsx');
    if (fs.existsSync(candidate)) {
      return { executable: candidate, args: [] };
    }
    currentDir = path.dirname(currentDir);
  }

  const rootCandidate = path.join(projectRoot || process.cwd(), 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(rootCandidate)) {
    return { executable: rootCandidate, args: [] };
  }

  const args = [];
  if (/\.(ts|mts|cts)$/.test(targetFile)) {
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    const nodeMinor = parseInt(process.versions.node.split('.')[1], 10);
    if (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)) {
      args.push('--experimental-strip-types');
    }
  }

  return {
    executable: process.execPath,
    args
  };
}

let activeBenchChild = null;

export async function executeAutoBenchSingle(targetFile, options, pickedFunctions = null) {
  // If a child is still running from a previous debounce/change, kill it cleanly
  if (activeBenchChild && !activeBenchChild.killed) {
    try {
      activeBenchChild.kill('SIGTERM');
    } catch {}
    activeBenchChild = null;
  }

  // 1. Analyze target module
  let analysis;
  try {
    analysis = analyzeModule(targetFile, { all: Boolean(options.all) });
  } catch (err) {
    console.error(`[softscope] Analysis failed: ${err.message}`);
    return 1;
  }

  // Apply picked functions, git-changed filter, or explicit filter
  if (pickedFunctions && pickedFunctions.length > 0) {
    const pickedKeys = new Set(pickedFunctions.map(f => f.exportName || f.name));
    analysis.functions = analysis.functions.filter(f => pickedKeys.has(f.exportName || f.name));
  }

  if (options.changed) {
    const targetProjectRoot = findProjectRoot(targetFile, options.projectRoot);
    if (!isGitRepository(targetProjectRoot)) {
      console.warn(`[softscope] Target is not inside a Git repository.`);
      return 1;
    }

    const changedLines = getGitChangedLines(targetFile, {
      projectRoot: targetProjectRoot,
      staged: options.staged,
      since: options.since
    });

    if (changedLines !== null && changedLines.size === 0) {
      console.log(`[softscope] ✔ No changes detected in ${path.relative(process.cwd(), targetFile)} since ${options.since || (options.staged ? 'staged' : 'last commit')}.`);
      return 0;
    }

    const beforeCount = analysis.functions.length;
    analysis.functions = filterFunctionsByChangedLines(analysis.functions, changedLines);

    if (analysis.functions.length === 0) {
      console.log(`[softscope] ✔ No functions modified in ${path.relative(process.cwd(), targetFile)} (Git changes affected non-function lines).`);
      return 0;
    }

    const refLabel = options.since || (options.staged ? 'staged' : 'HEAD');
    console.log(`[softscope] 🔀 Git-aware filter: Selected ${analysis.functions.length} of ${beforeCount} function(s) modified since ${refLabel}.`);
  }

  if (options.filter) {
    const pattern = options.filter.trim();
    const isGlob = pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
    const matcher = isGlob ? picomatch(pattern, { nocase: true }) : null;

    analysis.functions = analysis.functions.filter(fn => {
      if (matcher) {
        return matcher(fn.name) || matcher(fn.exportName);
      }
      const lowerP = pattern.toLowerCase();
      return (
        fn.name.toLowerCase().includes(lowerP) ||
        fn.exportName.toLowerCase().includes(lowerP)
      );
    });

    if (analysis.functions.length === 0) {
      console.warn(`[softscope] No functions matched filter "${options.filter}".`);
      return 0;
    }
  }

  if (analysis.functions.length === 0) {
    console.warn(`[softscope] No callable exported functions discovered in ${path.relative(process.cwd(), targetFile)}.`);
    return 0;
  }

  // 2. Load seeds
  const seedsFile = options.seeds || (fs.existsSync(path.resolve(process.cwd(), 'seeds.json')) ? 'seeds.json' : null);
  const seedsMap = loadSeedsFile(seedsFile);

  // 3. Synthesize test cases
  const testCases = analysis.functions.map(fn => {
    const { baselineSeed, fuzzSeeds } = synthesizeSeeds(fn, seedsMap, {
      fuzz: options.fuzz !== false
    });
    return {
      name: fn.name,
      exportName: fn.exportName,
      async: fn.async,
      baselineSeed,
      fuzzSeeds
    };
  });

  const targetProjectRoot = findProjectRoot(targetFile, options.projectRoot);

  if (options.sequential) {
    return executeAutoBenchSequential(targetFile, options, testCases, analysis, targetProjectRoot);
  }

  // 4. Generate and run temporary harness script
  const iterations = options.iterations || 10000;
  const tmpRunnerPath = path.join(
    os.tmpdir(),
    `softscope-autobench-runner-${process.pid}-${Date.now()}.mjs`
  );
  const tmpResultsPath = path.join(
    os.tmpdir(),
    `softscope-autobench-results-${process.pid}-${Date.now()}.json`
  );

  const runnerScript = generateRunnerScript(targetFile, testCases, iterations, tmpResultsPath);
  fs.writeFileSync(tmpRunnerPath, runnerScript, 'utf-8');

  let exitCode = 0;

  const registerPath = path.resolve(__dirname, '..', 'loader', 'register.js');
  const registerUrl = pathToFileURL(registerPath).href;

  const existingNodeOptions = process.env.NODE_OPTIONS || '';
  const alreadyImported = existingNodeOptions.includes('register.js') || existingNodeOptions.includes(registerUrl);
  let nodeOptions = alreadyImported
    ? existingNodeOptions
    : existingNodeOptions
      ? `${existingNodeOptions} --import=${registerUrl}`
      : `--import=${registerUrl}`;

  if (!nodeOptions.includes('--expose-gc')) {
    nodeOptions = `--expose-gc ${nodeOptions}`.trim();
  }

  const childEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    SOFTSCOPE_CONFIG: JSON.stringify({
      ...options,
      projectRoot: targetProjectRoot,
      include: options.include || [],
      exclude: options.exclude || [],
      includeNodeModules: Boolean(options.includeNodeModules)
    })
  };

  const progressReporter = createProgressReporter({
    total: testCases.length,
    isTTY: Boolean(process.stderr && process.stderr.isTTY),
    enabled: options.progress !== false && !options.json && !options.ai && !options.md,
    sequential: false
  });

  try {
    const runner = findTsRunner(targetFile, targetProjectRoot);
    const child = spawn(runner.executable, [...runner.args, tmpRunnerPath], {
      cwd: targetProjectRoot,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    activeBenchChild = child;

    let stderrOutput = '';
    let stderrBuffer = '';

    child.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString('utf-8');
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('__SOFTSCOPE_EVENT__')) {
          try {
            const ev = JSON.parse(line.slice('__SOFTSCOPE_EVENT__'.length));
            if (ev.type === 'start') {
              progressReporter.onStart(ev.index, ev.name);
            } else if (ev.type === 'done') {
              progressReporter.onDone(ev.index, ev.name, ev);
            }
          } catch {}
        } else {
          stderrOutput += line + '\n';
        }
      }
    });

    exitCode = await new Promise(resolve => {
      child.on('close', code => {
        if (activeBenchChild === child) activeBenchChild = null;
        resolve(code || 0);
      });
      child.on('error', () => {
        if (activeBenchChild === child) activeBenchChild = null;
        resolve(1);
      });
    });

    if (stderrBuffer && stderrBuffer.startsWith('__SOFTSCOPE_EVENT__')) {
      try {
        const ev = JSON.parse(stderrBuffer.slice('__SOFTSCOPE_EVENT__'.length));
        if (ev.type === 'done') progressReporter.onDone(ev.index, ev.name, ev);
      } catch {}
    } else if (stderrBuffer) {
      stderrOutput += stderrBuffer;
    }

    if (exitCode !== 0 && stderrOutput) {
      process.stderr.write(stderrOutput);
    }
  } finally {
    progressReporter.finish();
    try {
      if (fs.existsSync(tmpRunnerPath)) {
        fs.unlinkSync(tmpRunnerPath);
      }
    } catch {
      // Ignore
    }
  }

  if (exitCode !== 0) {
    console.error('[softscope] Auto-benchmark execution failed.');
    try {
      if (fs.existsSync(tmpResultsPath)) fs.unlinkSync(tmpResultsPath);
    } catch {}
    return exitCode;
  }

  let parsedPayload = {};
  try {
    if (!fs.existsSync(tmpResultsPath)) {
      throw new Error('Results file was not created by the benchmark runner');
    }
    const rawData = fs.readFileSync(tmpResultsPath, 'utf-8');
    parsedPayload = JSON.parse(rawData);
  } catch (err) {
    console.error(`[softscope] Failed to parse benchmark results: ${err.message}`);
    return 1;
  } finally {
    try {
      if (fs.existsSync(tmpResultsPath)) fs.unlinkSync(tmpResultsPath);
    } catch {}
  }

  const fnResults = Array.isArray(parsedPayload) ? parsedPayload : (parsedPayload.functions || []);
  const callEdges = parsedPayload.callEdges || [];

  return finishAndRenderAutoBench(targetFile, options, fnResults, callEdges, iterations);
}

/**
 * Executes candidate functions sequentially one-by-one with isolated subprocesses and timeout watchdog.
 */
async function executeAutoBenchSequential(targetFile, options, testCases, analysis, targetProjectRoot) {
  const timeoutMs = options.timeout || 5000;
  const iterations = options.iterations || 10000;
  const registerPath = path.resolve(__dirname, '..', 'loader', 'register.js');
  const registerUrl = pathToFileURL(registerPath).href;

  const existingNodeOptions = process.env.NODE_OPTIONS || '';
  const alreadyImported = existingNodeOptions.includes('register.js') || existingNodeOptions.includes(registerUrl);
  let nodeOptions = alreadyImported
    ? existingNodeOptions
    : existingNodeOptions
      ? `${existingNodeOptions} --import=${registerUrl}`
      : `--import=${registerUrl}`;

  if (!nodeOptions.includes('--expose-gc')) {
    nodeOptions = `--expose-gc ${nodeOptions}`.trim();
  }

  const childEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    SOFTSCOPE_CONFIG: JSON.stringify({
      ...options,
      projectRoot: targetProjectRoot,
      include: options.include || [],
      exclude: options.exclude || [],
      includeNodeModules: Boolean(options.includeNodeModules)
    })
  };

  const progressReporter = createProgressReporter({
    total: testCases.length,
    isTTY: Boolean(process.stderr && process.stderr.isTTY),
    enabled: options.progress !== false && !options.json && !options.ai && !options.md,
    sequential: true
  });

  if (!options.json && !options.ai && !options.md) {
    console.log(`\n\x1b[1;36m▶ Sequential Auto-Bench\x1b[0m \x1b[2m(${testCases.length} functions, ${timeoutMs}ms timeout per function)\x1b[0m\n`);
  }

  const fnResults = [];
  const allCallEdges = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    progressReporter.onStart(i + 1, tc.name);

    const tmpRunnerPath = path.join(
      os.tmpdir(),
      `softscope-autobench-seq-${process.pid}-${i}-${Date.now()}.mjs`
    );
    const tmpResultsPath = path.join(
      os.tmpdir(),
      `softscope-autobench-seq-res-${process.pid}-${i}-${Date.now()}.json`
    );

    const runnerScript = generateRunnerScript(targetFile, [tc], iterations, tmpResultsPath);
    fs.writeFileSync(tmpRunnerPath, runnerScript, 'utf-8');

    let exitCode = 0;
    let timedOut = false;
    let stderrOutput = '';
    let runnerChild = null;

    try {
      const runner = findTsRunner(targetFile, targetProjectRoot);
      runnerChild = spawn(runner.executable, [...runner.args, tmpRunnerPath], {
        cwd: targetProjectRoot,
        env: childEnv,
        stdio: ['ignore', 'ignore', 'pipe']
      });

      activeBenchChild = runnerChild;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          runnerChild.kill('SIGKILL');
        } catch {}
      }, timeoutMs);

      runnerChild.stderr.on('data', chunk => {
        const text = chunk.toString('utf-8');
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.startsWith('__SOFTSCOPE_EVENT__')) {
            stderrOutput += line + '\n';
          }
        }
      });

      exitCode = await new Promise(resolve => {
        runnerChild.on('close', code => {
          clearTimeout(timer);
          if (activeBenchChild === runnerChild) activeBenchChild = null;
          resolve(code || 0);
        });
        runnerChild.on('error', () => {
          clearTimeout(timer);
          if (activeBenchChild === runnerChild) activeBenchChild = null;
          resolve(1);
        });
      });
    } finally {
      try {
        if (fs.existsSync(tmpRunnerPath)) fs.unlinkSync(tmpRunnerPath);
      } catch {}
    }

    if (timedOut) {
      const timeoutRes = {
        name: tc.name,
        exportName: tc.exportName,
        status: 'timeout',
        error: `Execution timed out (> ${timeoutMs}ms)`,
        iterations: 0,
        totalTimeMs: timeoutMs,
        opsPerSec: 0,
        bytesPerOp: 0,
        gcCount: 0,
        gcTimeMs: 0,
        avgMs: timeoutMs,
        minMs: timeoutMs,
        maxMs: timeoutMs,
        baselineSeed: tc.baselineSeed,
        cliffs: [],
        crashes: []
      };
      fnResults.push(timeoutRes);
      progressReporter.onDone(i + 1, tc.name, { status: 'timeout', timedOut: true });
    } else if (exitCode !== 0 || !fs.existsSync(tmpResultsPath)) {
      const errRes = {
        name: tc.name,
        exportName: tc.exportName,
        status: 'error',
        error: stderrOutput.trim() || 'Execution failed',
        iterations: 0,
        totalTimeMs: 0,
        opsPerSec: 0,
        bytesPerOp: 0,
        gcCount: 0,
        gcTimeMs: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        baselineSeed: tc.baselineSeed,
        cliffs: [],
        crashes: []
      };
      fnResults.push(errRes);
      progressReporter.onDone(i + 1, tc.name, { status: 'error', error: stderrOutput.trim() });
    } else {
      try {
        const rawData = fs.readFileSync(tmpResultsPath, 'utf-8');
        const parsed = JSON.parse(rawData);
        const fns = parsed.functions || [];
        if (fns.length > 0) {
          const fn = fns[0];
          fnResults.push(fn);
          progressReporter.onDone(i + 1, tc.name, {
            status: fn.status,
            opsPerSec: fn.opsPerSec,
            bytesPerOp: fn.bytesPerOp,
            avgMs: fn.avgMs,
            cliffs: fn.cliffs ? fn.cliffs.length : 0,
            crashes: fn.crashes ? fn.crashes.length : 0
          });
        }
        if (parsed.callEdges) {
          allCallEdges.push(...parsed.callEdges);
        }
      } catch (err) {
        fnResults.push({
          name: tc.name,
          exportName: tc.exportName,
          status: 'error',
          error: err.message
        });
        progressReporter.onDone(i + 1, tc.name, { status: 'error', error: err.message });
      } finally {
        try {
          if (fs.existsSync(tmpResultsPath)) fs.unlinkSync(tmpResultsPath);
        } catch {}
      }
    }
  }

  progressReporter.finish();

  return finishAndRenderAutoBench(targetFile, options, fnResults, allCallEdges, iterations);
}

/**
 * Post-processes and renders the final auto-bench report (Terminal, Markdown, AI, or JSON).
 */
export async function finishAndRenderAutoBench(targetFile, options, fnResults, callEdges, iterations) {
  // Parse error locations and generate source code frames for unhandled crashes
  for (const fn of fnResults) {
    if (fn.crashes) {
      for (const crash of fn.crashes) {
        if (crash.stack) {
          const frame = parseStackFrame(crash.stack, targetFile);
          if (frame) {
            crash.file = frame.filePath;
            crash.line = frame.line;
            crash.column = frame.column;
            crash.codeFrame = createCodeFrame(frame.filePath, frame.line, frame.column, {
              message: crash.error,
              color: false
            });
            crash.coloredCodeFrame = createCodeFrame(frame.filePath, frame.line, frame.column, {
              message: crash.error,
              color: true
            });
          }
        }
      }
    }
  }

  const callableFns = fnResults.filter(f => f.status === 'ok');
  const totalGcs = callableFns.reduce((acc, f) => acc + (f.gcCount || 0), 0);
  const avgAllocPerOp = callableFns.length > 0
    ? callableFns.reduce((acc, f) => acc + (f.bytesPerOp || 0), 0) / callableFns.length
    : 0;

  const results = {
    targetFile: path.relative(process.cwd(), targetFile),
    iterations,
    functions: fnResults,
    callEdges,
    totalCrashes: fnResults.reduce((acc, f) => acc + (f.crashes ? f.crashes.length : 0), 0),
    totalCliffs: fnResults.reduce((acc, f) => acc + (f.cliffs ? f.cliffs.length : 0), 0),
    totalGcCycles: totalGcs,
    avgBytesPerOp: Math.round(avgAllocPerOp * 10) / 10
  };

  // Record crashes if any occurred for instant replay
  if (results.totalCrashes > 0) {
    try {
      recordDiscoveredCrashes(targetFile, fnResults, options);
    } catch {
      // Ignore crash recording error
    }
  }

  // 5. Save baseline if requested
  if (options.saveBaseline) {
    try {
      const jsonBaseline = renderAutoBenchJsonReport(results);
      fs.mkdirSync(path.dirname(options.saveBaseline), { recursive: true });
      fs.writeFileSync(options.saveBaseline, jsonBaseline, 'utf-8');
      if (options.pin) {
        console.log(`[softscope] 📌 Pinned baseline saved to ${path.relative(process.cwd(), options.saveBaseline) || options.saveBaseline}`);
      }
    } catch (err) {
      console.error(`[softscope] Failed to save baseline to ${options.saveBaseline}: ${err.message}`);
    }
  }

  // 6. If comparison requested
  let compareDelta = null;
  if (options.compare) {
    try {
      const baselineData = loadBaseline(options.compare);
      compareDelta = computeAutoBenchDelta(baselineData, results, {
        threshold: options.failOnRegression != null ? options.failOnRegression : 10
      });
    } catch (err) {
      console.error(`[softscope] Comparison failed: ${err.message}`);
    }
  }

  // 7. Output to file if requested
  if (options.output) {
    let fileContent;
    if (compareDelta) {
      if (options.ai || options.output.endsWith('.ai') || options.output.endsWith('.llm')) {
        fileContent = renderAutoBenchCompareAiReport(compareDelta, options);
      } else if (options.md || options.output.endsWith('.md')) {
        fileContent = renderAutoBenchCompareMarkdownReport(compareDelta, options);
      } else {
        fileContent = renderAutoBenchCompareJsonReport(compareDelta);
      }
    } else {
      if (options.ai || options.output.endsWith('.ai') || options.output.endsWith('.llm')) {
        fileContent = renderAutoBenchAiReport(results, options);
      } else if (options.md || options.output.endsWith('.md')) {
        fileContent = renderAutoBenchMarkdownReport(results, options);
      } else {
        fileContent = renderAutoBenchJsonReport(results);
      }
    }

    try {
      fs.writeFileSync(options.output, fileContent, 'utf-8');
    } catch (err) {
      console.error(`[softscope] Failed to write report to ${options.output}: ${err.message}`);
    }
  }

  // 8. Output to stdout
  if (compareDelta) {
    if (options.json) {
      process.stdout.write(renderAutoBenchCompareJsonReport(compareDelta) + '\n');
    } else if (options.ai) {
      process.stdout.write('\n' + renderAutoBenchCompareAiReport(compareDelta, options) + '\n');
    } else if (options.md) {
      process.stdout.write('\n' + renderAutoBenchCompareMarkdownReport(compareDelta, options) + '\n');
    } else {
      process.stdout.write('\n' + renderAutoBenchCompareTerminalReport(compareDelta, options) + '\n');
    }

    if (options.failOnRegression != null && compareDelta.thresholdBreached) {
      return 1;
    }
    return 0;
  }

  if (options.json) {
    process.stdout.write(renderAutoBenchJsonReport(results) + '\n');
  } else if (options.ai) {
    process.stdout.write('\n' + renderAutoBenchAiReport(results, options) + '\n');
  } else if (options.md) {
    process.stdout.write('\n' + renderAutoBenchMarkdownReport(results, options) + '\n');
  } else {
    process.stdout.write('\n' + renderAutoBenchTerminalReport(results, options) + '\n');
  }

  return 0;
}

/**
 * Main entry point for auto-benchmarking a module.
 */
export async function runAutoBench(options) {
  if (options.diff && !fs.existsSync(options.compare)) {
    console.error(`[softscope] Error: No pinned baseline found at ${path.relative(process.cwd(), options.compare) || options.compare}.`);
    console.error('Run with --pin first (e.g. softscope pin auto-bench <target>).');
    return 1;
  }
  const args = options.command.slice(1);
  if (args.length === 0) {
    if (options.changed) {
      const projectRoot = options.projectRoot || process.cwd();
      if (!isGitRepository(projectRoot)) {
        console.error('[softscope] Error: --changed requires a Git repository.');
        return 1;
      }

      const changedFiles = getGitChangedFiles({
        projectRoot,
        staged: options.staged,
        since: options.since
      });

      const refLabel = options.since || (options.staged ? 'staged' : 'HEAD');
      if (changedFiles.length === 0) {
        console.log(`[softscope] ✔ No changed code files detected in Git repository since ${refLabel}.`);
        return 0;
      }

      if (changedFiles.length === 1) {
        console.log(`[softscope] 🔀 Git-aware: auto-targeting changed file ${path.relative(process.cwd(), changedFiles[0])}`);
        return executeAutoBenchSingle(changedFiles[0], options, null);
      }

      console.log(`[softscope] 🔀 Git-aware: detected ${changedFiles.length} changed code file(s):`);
      for (const cf of changedFiles) {
        console.log(`  • ${path.relative(process.cwd(), cf)}`);
      }

      let overallCode = 0;
      for (const cf of changedFiles) {
        console.log(`\n\x1b[1;36m▶ Auto-Bench: ${path.relative(process.cwd(), cf)}\x1b[0m`);
        const code = await executeAutoBenchSingle(cf, options, null);
        if (code !== 0) overallCode = code;
      }
      return overallCode;
    }

    console.error('[softscope] Error: auto-bench requires a target file.');
    console.error('Usage: softscope auto-bench <file> [options] (or softscope auto-bench --changed)');
    return 1;
  }

  const targetFile = path.resolve(options.projectRoot || process.cwd(), args[0]);
  if (!fs.existsSync(targetFile)) {
    console.error(`[softscope] Target file not found: ${targetFile}`);
    return 1;
  }

  let pickedFunctions = null;
  if (options.pick && process.stdin.isTTY) {
    try {
      const initialAnalysis = analyzeModule(targetFile, { all: Boolean(options.all) });
      const picked = await promptFunctionPicker(initialAnalysis.functions, {
        title: `Select functions to benchmark in ${path.basename(targetFile)}`
      });
      if (!picked || picked.length === 0) {
        console.log('[softscope] No functions selected. Exiting.');
        return 0;
      }
      pickedFunctions = picked;
    } catch (err) {
      console.error(`[softscope] Analysis failed: ${err.message}`);
      return 1;
    }
  }

  if (options.watch) {
    const targetProjectRoot = findProjectRoot(targetFile, options.projectRoot);
    const watchPaths = [targetFile, path.dirname(targetFile), targetProjectRoot];

    return runWatchLoop({
      title: 'auto-bench',
      targetPath: targetFile,
      watchPaths,
      runTask: async () => {
        return executeAutoBenchSingle(targetFile, options, pickedFunctions);
      },
      getState: () => ({
        fuzz: options.fuzz !== false,
        diff: Boolean(options.diff),
        changed: Boolean(options.changed),
        all: Boolean(options.all),
        sequential: Boolean(options.sequential)
      }),
      onToggleFuzz: () => {
        options.fuzz = options.fuzz === false ? true : false;
        return `Toggled fuzzing: ${options.fuzz ? '\x1b[32mON\x1b[0m (edge-case & boundary testing)' : '\x1b[33mOFF\x1b[0m (pure throughput mode)'}`;
      },
      onToggleDiff: () => {
        if (!options.diff) {
          options.diff = true;
          options.compare = path.resolve(options.projectRoot || process.cwd(), '.softscope/last-pin.json');
          if (!fs.existsSync(options.compare)) {
            options.saveBaseline = options.compare;
          }
          return `Toggled baseline diff: \x1b[32mON\x1b[0m (comparing against .softscope/last-pin.json)`;
        } else {
          options.diff = false;
          options.compare = null;
          return `Toggled baseline diff: \x1b[33mOFF\x1b[0m`;
        }
      },
      onToggleChanged: () => {
        options.changed = !options.changed;
        return `Toggled Git-aware filter: ${options.changed ? '\x1b[32mON\x1b[0m (only modified functions)' : '\x1b[33mOFF\x1b[0m (all target functions)'}`;
      },
      onToggleAll: () => {
        options.all = !options.all;
        return `Toggled all functions: ${options.all ? '\x1b[32mON\x1b[0m (including unexported functions)' : '\x1b[33mOFF\x1b[0m (exported only)'}`;
      },
      onToggleSequential: () => {
        options.sequential = !options.sequential;
        return `Toggled sequential execution: ${options.sequential ? '\x1b[32mON\x1b[0m (isolated function-by-function)' : '\x1b[33mOFF\x1b[0m (batch mode)'}`;
      },
      onPick: process.stdin.isTTY ? async () => {
        try {
          const freshAnalysis = analyzeModule(targetFile, { all: Boolean(options.all) });
          const repicked = await promptFunctionPicker(freshAnalysis.functions, {
            title: `Select functions to benchmark in ${path.basename(targetFile)}`
          });
          if (repicked && repicked.length > 0) {
            pickedFunctions = repicked;
          }
        } catch (err) {
          console.error(`[softscope] Function discovery error: ${err.message}`);
        }
      } : null
    });
  }

  return executeAutoBenchSingle(targetFile, options, pickedFunctions);
}
