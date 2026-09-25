import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { formatBytes, formatBytesPerOp } from '../src/report/format.js';
import {
  computeAutoBenchDelta,
  renderAutoBenchCompareTerminalReport,
  renderAutoBenchCompareMarkdownReport,
  renderAutoBenchCompareAiReport
} from '../src/autobench/compare.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');

function runCli(args, opts = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.SOFTSCOPE_SESSION_DIR;
  delete cleanEnv.SOFTSCOPE_CONFIG;
  delete cleanEnv.SOFTSCOPE_IPC_SOCKET;
  delete cleanEnv.SOFTSCOPE_LIVE;

  return execFileAsync(process.execPath, [SOFTSCOPE_BIN, ...args], {
    env: cleanEnv,
    ...opts
  });
}

test('Formatters: formatBytes and formatBytesPerOp handle edge cases correctly', () => {
  // formatBytes
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(-2048), '-2.0 KB');

  // formatBytesPerOp
  assert.equal(formatBytesPerOp(undefined), '0 B/op');
  assert.equal(formatBytesPerOp(null), '0 B/op');
  assert.equal(formatBytesPerOp(0), '0 B/op');
  assert.equal(formatBytesPerOp(0.0), '0 B/op');
  assert.equal(formatBytesPerOp(48), '48 B/op');
  assert.equal(formatBytesPerOp(4.5), '4.5 B/op');
  assert.equal(formatBytesPerOp(1024), '1.0 KB/op');
  assert.equal(formatBytesPerOp(2560), '2.5 KB/op');
  assert.equal(formatBytesPerOp(1048576), '1.0 MB/op');
  assert.equal(formatBytesPerOp(-32), '-32 B/op');
});

test('Auto-Bench Memory: CLI measures allocations per operation (B/op) and distinguishes zero-alloc from allocating functions', async () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-alloc-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const testFile = path.join(tmpDir, 'alloc-target.js');
    fs.writeFileSync(testFile, `
      export function zeroAllocMath(a = 10, b = 20) {
        return (a + b) | 0;
      }

      export function allocatingObject(name = 'item') {
        return {
          id: 1,
          name: typeof name === 'string' ? name : 'UNKNOWN',
          tags: ['alpha', 'beta', 'gamma'],
          meta: { active: true, timestamp: Date.now() }
        };
      }
    `, 'utf-8');

    // 1. JSON output check
    const { stdout: jsonOut } = await runCli(['auto-bench', testFile, '--iterations', '500', '--json']);
    const results = JSON.parse(jsonOut);

    assert.equal(results.type, 'softscope-autobench');
    assert.equal(results.functions.length, 2);
    assert.ok('avgBytesPerOp' in results, 'Results should contain avgBytesPerOp');
    assert.ok('totalGcCycles' in results, 'Results should contain totalGcCycles');

    const zeroFn = results.functions.find(f => f.name === 'zeroAllocMath');
    const allocFn = results.functions.find(f => f.name === 'allocatingObject');

    assert.ok(zeroFn, 'zeroAllocMath should be benchmarked');
    assert.ok(allocFn, 'allocatingObject should be benchmarked');

    assert.equal(zeroFn.status, 'ok');
    assert.equal(allocFn.status, 'ok');

    // zeroAllocMath should have 0 B/op
    assert.equal(zeroFn.bytesPerOp, 0, 'zeroAllocMath should allocate 0 B/op');
    // allocatingObject should allocate substantial bytes per op (> 100 bytes)
    assert.ok(allocFn.bytesPerOp > 100, `allocatingObject should have >100 B/op (actual: ${allocFn.bytesPerOp})`);

    // 2. Terminal report output check
    const { stdout: termOut } = await runCli(['auto-bench', testFile, '--iterations', '500']);
    assert.ok(termOut.includes('Alloc / op'), 'Terminal table should have Alloc / op column');
    assert.ok(termOut.includes('Avg Alloc/Op:'), 'Overview should show Avg Alloc/Op');
    assert.ok(termOut.includes('Total GC Cycles:'), 'Overview should show Total GC Cycles');
    assert.ok(termOut.includes('0 B/op'), 'Terminal table should display 0 B/op for zeroAllocMath');

    // 3. Markdown report output check
    const { stdout: mdOut } = await runCli(['auto-bench', testFile, '--iterations', '500', '--md']);
    assert.ok(mdOut.includes('| Alloc / op |'), 'Markdown table should have Alloc / op header');
    assert.ok(mdOut.includes('- **Avg Alloc/Op**:'), 'Markdown summary should list Avg Alloc/Op');
    assert.ok(mdOut.includes('- **Total GC Cycles**:'), 'Markdown summary should list Total GC Cycles');
    assert.ok(mdOut.includes('0 B/op'), 'Markdown table should contain 0 B/op');

    // 4. AI report output check
    const { stdout: aiOut } = await runCli(['auto-bench', testFile, '--iterations', '500', '--ai']);
    assert.ok(aiOut.includes('TOTAL_GC_CYCLES:'), 'AI profile should list TOTAL_GC_CYCLES');
    assert.ok(aiOut.includes('AVG_ALLOC_PER_OP:'), 'AI profile should list AVG_ALLOC_PER_OP');
    assert.ok(aiOut.includes('alloc: 0 B/op'), 'AI profile throughput should show alloc: 0 B/op');
    assert.ok(aiOut.includes('## MEMORY & GC ALLOCATION HAZARDS'), 'AI profile should flag high allocation functions');
    assert.ok(aiOut.includes('allocatingObject'), 'AI profile should highlight allocatingObject in hazards');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test('Auto-Bench Compare: computeAutoBenchDelta tracks allocation changes and renders Alloc Delta', () => {
  const baseline = {
    type: 'softscope-autobench',
    targetFile: 'src/parser.js',
    iterations: 1000,
    totalCrashes: 0,
    totalCliffs: 0,
    avgBytesPerOp: 160,
    functions: [
      {
        name: 'tokenize',
        status: 'ok',
        opsPerSec: 1000000,
        bytesPerOp: 160,
        gcCount: 0,
        avgMs: 0.001,
        minMs: 0.0005,
        maxMs: 0.01,
        crashes: [],
        cliffs: []
      }
    ]
  };

  const current = {
    type: 'softscope-autobench',
    targetFile: 'src/parser.js',
    iterations: 1000,
    totalCrashes: 0,
    totalCliffs: 0,
    avgBytesPerOp: 0,
    functions: [
      {
        name: 'tokenize',
        status: 'ok',
        opsPerSec: 1800000, // +80% throughput
        bytesPerOp: 0,       // Zero-alloc refactor! (-160 B/op)
        gcCount: 0,
        avgMs: 0.00055,
        minMs: 0.0003,
        maxMs: 0.008,
        crashes: [],
        cliffs: []
      }
    ]
  };

  const delta = computeAutoBenchDelta(baseline, current, { threshold: 10 });

  assert.equal(delta.overview.avgAllocBase, 160);
  assert.equal(delta.overview.avgAllocCurr, 0);

  const comp = delta.comparisons.find(c => c.name === 'tokenize');
  assert.ok(comp);
  assert.equal(comp.base.bytesPerOp, 160);
  assert.equal(comp.current.bytesPerOp, 0);
  assert.equal(comp.diff.bytesPerOp, -160); // 160 bytes reduced per op!

  // Terminal report
  const termReport = renderAutoBenchCompareTerminalReport(delta);
  assert.ok(termReport.includes('Alloc Delta'), 'Terminal compare should have Alloc Delta column');
  assert.ok(termReport.includes('-160 B/op 🚀'), 'Terminal compare should highlight allocation drop with rocket');

  // Markdown report
  const mdReport = renderAutoBenchCompareMarkdownReport(delta);
  assert.ok(mdReport.includes('Alloc Delta'), 'Markdown compare should have Alloc Delta column');
  assert.ok(mdReport.includes('-160 B/op 🚀'), 'Markdown compare should display allocation drop with rocket');

  // AI report
  const aiReport = renderAutoBenchCompareAiReport(delta);
  assert.ok(aiReport.includes('alloc=-160 B/op'), 'AI profile should include alloc delta');
});
