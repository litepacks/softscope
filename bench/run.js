import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_SCRIPT = path.resolve(__dirname, 'target.js');
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');

function parseLoopDuration(stdout) {
  const match = stdout.match(/Loop duration:\s*([\d.]+)ms/);
  return match ? parseFloat(match[1]) : 0;
}

async function runBenchmark() {
  console.log('Running Softscope overhead benchmark (1,000,000 function calls)...\n');

  // Warmup
  await execFileAsync(process.execPath, [TARGET_SCRIPT]);

  // 1. Normal execution
  console.log('1. Measuring uninstrumented baseline (node bench/target.js)...');
  const normalRuns = [];
  for (let i = 0; i < 3; i++) {
    const { stdout } = await execFileAsync(process.execPath, [TARGET_SCRIPT]);
    normalRuns.push(parseLoopDuration(stdout));
  }
  const avgNormal = normalRuns.reduce((a, b) => a + b, 0) / normalRuns.length;
  console.log(`   Baseline avg loop time: ${avgNormal.toFixed(2)}ms\n`);

  // 2. Softscope execution
  console.log('2. Measuring instrumented execution (softscope bench/target.js)...');
  const softscopeRuns = [];
  for (let i = 0; i < 3; i++) {
    const { stdout } = await execFileAsync(process.execPath, [SOFTSCOPE_BIN, TARGET_SCRIPT]);
    softscopeRuns.push(parseLoopDuration(stdout));
  }
  const avgSoftscope = softscopeRuns.reduce((a, b) => a + b, 0) / softscopeRuns.length;
  console.log(`   Softscope avg loop time: ${avgSoftscope.toFixed(2)}ms\n`);

  // 3. Comparison
  const totalOverheadMs = avgSoftscope - avgNormal;
  const perCallOverheadNs = (totalOverheadMs / 1_000_000) * 1_000_000; // ms to ns

  console.log('───────────────────────────────────────────────────────');
  console.log('Benchmark Results:');
  console.log(`Baseline average:         ${avgNormal.toFixed(2)} ms`);
  console.log(`Softscope average:        ${avgSoftscope.toFixed(2)} ms`);
  console.log(`Total overhead (1M calls): ${totalOverheadMs.toFixed(2)} ms`);
  console.log(`Overhead per call:        ${perCallOverheadNs.toFixed(1)} ns / call`);
  console.log('───────────────────────────────────────────────────────');
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
