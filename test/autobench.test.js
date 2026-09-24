import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../src/config.js';
import { analyzeModule } from '../src/autobench/analyze.js';
import { synthesizeSeeds, loadSeedsFile } from '../src/autobench/seeds.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function runCli(args, opts = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.SOFTSCOPE_SESSION_DIR;
  delete cleanEnv.SOFTSCOPE_CONFIG;
  delete cleanEnv.SOFTSCOPE_IPC_SOCKET;
  delete cleanEnv.SOFTSCOPE_LIVE;
  delete cleanEnv.SOFTSCOPE_CAPTURE_SEEDS;

  return execFileAsync(process.execPath, [SOFTSCOPE_BIN, ...args], {
    env: cleanEnv,
    ...opts
  });
}

test('Auto-Bench Config: parses --capture-seeds, --seeds, --fuzz, --no-fuzz, --iterations, --all', () => {
  const opts = parseCliArgs([
    'auto-bench',
    'src/math.js',
    '--capture-seeds',
    'my-seeds.json',
    '--seeds',
    'prev-seeds.json',
    '--no-fuzz',
    '--iterations',
    '5000',
    '--all'
  ]);

  assert.ok(opts.captureSeeds.endsWith('my-seeds.json'));
  assert.ok(opts.seeds.endsWith('prev-seeds.json'));
  assert.equal(opts.fuzz, false);
  assert.equal(opts.iterations, 5000);
  assert.equal(opts.all, true);
});

test('Auto-Bench AST: accurately discovers exported functions and default parameters', () => {
  const fixturePath = path.join(FIXTURES_DIR, 'autobench', 'math.js');
  const analysis = analyzeModule(fixturePath);

  assert.equal(analysis.functions.length, 4);

  const addFn = analysis.functions.find(f => f.name === 'add');
  assert.ok(addFn);
  assert.equal(addFn.params.length, 2);
  assert.equal(addFn.params[0].hasDefault, true);
  assert.equal(addFn.params[0].defaultValue, 1);
  assert.equal(addFn.params[1].defaultValue, 2);

  const formatFn = analysis.functions.find(f => f.name === 'formatName');
  assert.ok(formatFn);
  assert.equal(formatFn.params[0].name, 'user');
});

test('Auto-Bench Seeds: synthesizes baseline seeds and generates edge-case mutations', () => {
  const fnInfo = {
    name: 'calculate',
    params: [
      { name: 'amount', hasDefault: true, defaultValue: 100 },
      { name: 'tag', hasDefault: false, tsType: 'string' }
    ]
  };

  const { baselineSeed, fuzzSeeds } = synthesizeSeeds(fnInfo, new Map(), { fuzz: true });

  assert.deepEqual(baselineSeed, [100, 'benchmark']);
  assert.ok(fuzzSeeds.length >= 8);

  // Check number mutations exist in fuzz seeds
  const hasZero = fuzzSeeds.some(s => s.args[0] === 0);
  const hasNegative = fuzzSeeds.some(s => s.args[0] === -1);
  const hasEmptyStr = fuzzSeeds.some(s => s.args[1] === '');

  assert.ok(hasZero);
  assert.ok(hasNegative);
  assert.ok(hasEmptyStr);
});

test('CLI: auto-bench benchmarks functions and detects edge-case crashes and latency cliffs', async () => {
  const fixturePath = path.join(FIXTURES_DIR, 'autobench', 'math.js');
  const { stdout } = await runCli(['auto-bench', fixturePath, '--iterations', '500']);

  assert.ok(stdout.includes('Auto-Benchmark & Robustness Overview'));
  assert.ok(stdout.includes('Throughput & Latency'));
  assert.ok(stdout.includes('add'));
  assert.ok(stdout.includes('multiply'));

  // Assert crash was discovered for formatName (null/missing name)
  assert.ok(stdout.includes('Unhandled Crashes Discovered'));
  assert.ok(stdout.includes('formatName'));

  // Assert latency cliff was discovered for processTokens (long string)
  assert.ok(stdout.includes('Latency Cliffs Discovered'));
  assert.ok(stdout.includes('processTokens'));
});

test('CLI: auto-bench formats reports as Markdown and AI profile', async () => {
  const fixturePath = path.join(FIXTURES_DIR, 'autobench', 'math.js');

  // Markdown
  const { stdout: mdOut } = await runCli(['auto-bench', fixturePath, '--iterations', '100', '--md']);
  assert.ok(mdOut.includes('# Softscope Auto-Benchmark & Robustness Report'));
  assert.ok(mdOut.includes('## Throughput & Latency'));
  assert.ok(mdOut.includes('## 🔴 Unhandled Crashes'));

  // AI Profile
  const { stdout: aiOut } = await runCli(['auto-bench', fixturePath, '--iterations', '100', '--ai']);
  assert.ok(aiOut.includes('# Softscope AI Auto-Bench & Edge-Case Profile'));
  assert.ok(aiOut.includes('## THROUGHPUT SUMMARY'));
  assert.ok(aiOut.includes('## CRITICAL BUGS (UNHANDLED CRASHES)'));
});

test('CLI: --capture-seeds records real runtime arguments for replay', async () => {
  const tmpSeeds = path.join(os.tmpdir(), `softscope-seeds-${Date.now()}.json`);
  const fixturePath = path.join(FIXTURES_DIR, 'simple', 'index.js');

  try {
    const { stdout } = await runCli([fixturePath, '--capture-seeds', tmpSeeds]);
    assert.ok(fs.existsSync(tmpSeeds), 'Seeds JSON should be written');

    const seedsContent = JSON.parse(fs.readFileSync(tmpSeeds, 'utf-8'));
    assert.equal(seedsContent.version, 1);
    assert.equal(seedsContent.type, 'softscope-seeds');
    assert.ok(seedsContent.seeds.length > 0);

    const addSeed = seedsContent.seeds.find(s => s.name === 'add');
    assert.ok(addSeed, 'Should have captured seeds for add function');
    assert.ok(addSeed.calls.length > 0);

    // Verify loadSeedsFile can read it
    const seedsMap = loadSeedsFile(tmpSeeds);
    assert.ok(seedsMap.has('add'));
    assert.ok(seedsMap.get('add').length > 0);

  } finally {
    try {
      if (fs.existsSync(tmpSeeds)) fs.unlinkSync(tmpSeeds);
    } catch {
      // Ignore
    }
  }
});

test('Auto-Bench AST: discovers re-exports, barrel files, and class constructors', () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-barrel-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const subPath = path.join(tmpDir, 'sub.js');
    fs.writeFileSync(subPath, `
      export function subFn(x = 10) { return x * 2; }
      export class SubClass { constructor(name = "test") { this.name = name; } }
    `, 'utf-8');

    const barrelPath = path.join(tmpDir, 'index.js');
    fs.writeFileSync(barrelPath, `
      export { subFn as aliasedFn, SubClass } from './sub.js';
      export function localFn() { return 1; }
    `, 'utf-8');

    const analysis = analyzeModule(barrelPath);
    assert.equal(analysis.functions.length, 3);

    const aliased = analysis.functions.find(f => f.exportName === 'aliasedFn');
    assert.ok(aliased, 'Should discover re-exported function with alias');
    assert.equal(aliased.params[0].defaultValue, 10);

    const cls = analysis.functions.find(f => f.exportName === 'SubClass');
    assert.ok(cls, 'Should discover re-exported class');
    assert.equal(cls.isClass, true);
    assert.equal(cls.params[0].defaultValue, 'test');

    const local = analysis.functions.find(f => f.exportName === 'localFn');
    assert.ok(local, 'Should discover local function');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});

test('Auto-Bench Config: parses --filter, --fn, and --match flags correctly', () => {
  const opt1 = parseCliArgs(['auto-bench', 'src/math.js', '--filter', 'compute']);
  assert.equal(opt1.filter, 'compute');

  const opt2 = parseCliArgs(['auto-bench', 'src/math.js', '--fn', 'add*']);
  assert.equal(opt2.filter, 'add*');

  const opt3 = parseCliArgs(['auto-bench', 'src/math.js', '--match', 'parse']);
  assert.equal(opt3.filter, 'parse');
});

test('CLI: auto-bench filters functions and extracts call graph relationships', async () => {
  const fixturePath = path.join(FIXTURES_DIR, 'simple', 'index.js');
  
  // JSON output test
  const { stdout: jsonOut } = await runCli(['auto-bench', fixturePath, '--filter', 'compute', '--json']);
  const parsed = JSON.parse(jsonOut);
  
  assert.equal(parsed.functions.length, 1);
  assert.equal(parsed.functions[0].name, 'compute');
  assert.ok(parsed.callEdges.length >= 2);

  const edgeAdd = parsed.callEdges.find(e => e.callerName === 'compute' && e.calleeName === 'add');
  const edgeMultiply = parsed.callEdges.find(e => e.callerName === 'compute' && e.calleeName === 'multiply');
  assert.ok(edgeAdd, 'Should capture caller-callee edge: compute -> add');
  assert.ok(edgeMultiply, 'Should capture caller-callee edge: compute -> multiply');
  assert.ok(edgeAdd.calls > 0);

  // Markdown output test
  const { stdout: mdOut } = await runCli(['auto-bench', fixturePath, '--filter', 'compute', '--md']);
  assert.ok(mdOut.includes('## Call Relationships (Internal Invocations)'));
  assert.ok(mdOut.includes('`compute`'));
  assert.ok(mdOut.includes('`add`'));
  assert.ok(mdOut.includes('`multiply`'));
});

