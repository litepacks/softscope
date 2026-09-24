import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { analyzeModule } from './analyze.js';
import { loadSeedsFile, synthesizeSeeds } from './seeds.js';
import {
  renderAutoBenchTerminalReport,
  renderAutoBenchMarkdownReport,
  renderAutoBenchAiReport,
  renderAutoBenchJsonReport
} from './report.js';

/**
 * Generates temporary benchmark runner code to execute candidate functions safely.
 */
function generateRunnerScript(filePath, testCases, iterations = 10000) {
  const targetUrl = pathToFileURL(filePath).href;

  return `
import { pathToFileURL } from 'node:url';

async function run() {
  const targetMod = await import(${JSON.stringify(targetUrl)});
  const testCases = ${JSON.stringify(testCases)};
  const targetIterations = ${iterations};
  const results = [];

  for (const tc of testCases) {
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
      continue;
    }

    const baselineSeed = tc.baselineSeed;
    const isAsync = tc.async;

    // 1. Warmup
    try {
      for (let i = 0; i < 50; i++) {
        const p = fn(...baselineSeed);
        if (isAsync && p && typeof p.then === 'function') {
          await p;
        }
      }
    } catch (warmupErr) {
      // If baseline seed itself fails
      results.push({
        name: tc.name,
        exportName: tc.exportName,
        status: 'error',
        error: warmupErr.message || String(warmupErr)
      });
      continue;
    }

    // 2. Timed Measurement Loop
    let iters = 0;
    const start = performance.now();

    if (isAsync) {
      const asyncIters = Math.min(targetIterations, 500);
      for (let i = 0; i < asyncIters; i++) {
        await fn(...baselineSeed);
        iters++;
      }
    } else {
      for (let i = 0; i < targetIterations; i++) {
        fn(...baselineSeed);
        iters++;
      }
    }

    const totalTimeMs = performance.now() - start;
    const avgMs = iters > 0 ? totalTimeMs / iters : 0;
    const opsPerSec = totalTimeMs > 0 ? Math.round((iters / totalTimeMs) * 1000) : 0;

    // Sample individual min/max latency
    let minMs = Infinity;
    let maxMs = 0;
    const sampleCount = 30;
    for (let s = 0; s < sampleCount; s++) {
      const s0 = performance.now();
      const p = fn(...baselineSeed);
      if (isAsync && p && typeof p.then === 'function') await p;
      const d = performance.now() - s0;
      if (d < minMs) minMs = d;
      if (d > maxMs) maxMs = d;
    }
    if (minMs === Infinity) minMs = avgMs;

    // 3. Edge-Case Fuzzing & Latency Cliff Detection
    const cliffs = [];
    const crashes = [];

    for (const fuzzCase of tc.fuzzSeeds || []) {
      try {
        const f0 = performance.now();
        const p = fn(...fuzzCase.args);
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
          error: fuzzErr.message || String(fuzzErr)
        });
      }
    }

    results.push({
      name: tc.name,
      exportName: tc.exportName,
      status: 'ok',
      async: isAsync,
      iterations: iters,
      totalTimeMs,
      opsPerSec,
      avgMs,
      minMs,
      maxMs,
      baselineSeed,
      cliffs,
      crashes
    });
  }

  process.stdout.write(JSON.stringify(results));
}

run().catch((err) => {
  console.error('[softscope-autobench-runner-error]', err);
  process.exit(1);
});
`;
}

/**
 * Main entry point for auto-benchmarking a module.
 */
export async function runAutoBench(options) {
  const args = options.command.slice(1);
  if (args.length === 0) {
    console.error('[softscope] Error: auto-bench requires a target file.');
    console.error('Usage: softscope auto-bench <file> [options]');
    return 1;
  }

  const targetFile = path.resolve(options.projectRoot || process.cwd(), args[0]);

  // 1. Analyze target module
  let analysis;
  try {
    analysis = analyzeModule(targetFile, { all: Boolean(options.all) });
  } catch (err) {
    console.error(`[softscope] Analysis failed: ${err.message}`);
    return 1;
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

  // 4. Generate and run temporary harness script
  const iterations = options.iterations || 10000;
  const runnerScript = generateRunnerScript(targetFile, testCases, iterations);

  const tmpRunnerPath = path.join(
    os.tmpdir(),
    `softscope-autobench-${process.pid}-${Date.now()}.mjs`
  );
  fs.writeFileSync(tmpRunnerPath, runnerScript, 'utf-8');

  let rawOutput = '';
  let exitCode = 0;

  try {
    const child = spawn(process.execPath, [tmpRunnerPath], {
      cwd: options.projectRoot || process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', chunk => {
      rawOutput += chunk.toString('utf-8');
    });

    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
    });

    exitCode = await new Promise(resolve => {
      child.on('close', code => resolve(code || 0));
      child.on('error', () => resolve(1));
    });
  } finally {
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
    return exitCode;
  }

  let fnResults = [];
  try {
    fnResults = JSON.parse(rawOutput);
  } catch (err) {
    console.error(`[softscope] Failed to parse benchmark results: ${err.message}`);
    return 1;
  }

  const results = {
    targetFile: path.relative(process.cwd(), targetFile),
    iterations,
    functions: fnResults,
    totalCrashes: fnResults.reduce((acc, f) => acc + (f.crashes ? f.crashes.length : 0), 0),
    totalCliffs: fnResults.reduce((acc, f) => acc + (f.cliffs ? f.cliffs.length : 0), 0)
  };

  // 5. Output to file if requested
  if (options.output) {
    let fileContent;
    if (options.ai || options.output.endsWith('.ai') || options.output.endsWith('.llm')) {
      fileContent = renderAutoBenchAiReport(results, options);
    } else if (options.md || options.output.endsWith('.md')) {
      fileContent = renderAutoBenchMarkdownReport(results, options);
    } else {
      fileContent = renderAutoBenchJsonReport(results);
    }

    try {
      fs.writeFileSync(options.output, fileContent, 'utf-8');
    } catch (err) {
      console.error(`[softscope] Failed to write report to ${options.output}: ${err.message}`);
    }
  }

  // 6. Output to stdout
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
