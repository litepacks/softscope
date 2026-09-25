import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCliArgs } from '../src/config.js';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve('bin/softscope.js');

test('Pin & Diff Config: parses flags and subcommands correctly', () => {
  // 1. --pin flag
  const optsPin = parseCliArgs(['bench/run.js', '--pin']);
  assert.equal(optsPin.pin, true);
  assert.ok(optsPin.saveBaseline.endsWith('.softscope/last-pin.json'));
  assert.deepEqual(optsPin.command, ['bench/run.js']);

  // 2. --diff flag
  const optsDiff = parseCliArgs(['bench/run.js', '--diff']);
  assert.equal(optsDiff.diff, true);
  assert.ok(optsDiff.compare.endsWith('.softscope/last-pin.json'));
  assert.deepEqual(optsDiff.command, ['bench/run.js']);

  // 3. pin subcommand
  const optsSubPin = parseCliArgs(['pin', 'auto-bench', 'src/math.js']);
  assert.equal(optsSubPin.pin, true);
  assert.ok(optsSubPin.saveBaseline.endsWith('.softscope/last-pin.json'));
  assert.deepEqual(optsSubPin.command, ['auto-bench', 'src/math.js']);

  // 4. diff subcommand
  const optsSubDiff = parseCliArgs(['diff', 'auto-bench', 'src/math.js']);
  assert.equal(optsSubDiff.diff, true);
  assert.ok(optsSubDiff.compare.endsWith('.softscope/last-pin.json'));
  assert.deepEqual(optsSubDiff.command, ['auto-bench', 'src/math.js']);

  // 5. diff with two json files aliases to compare
  const optsDiffCompare = parseCliArgs(['diff', 'base.json', 'curr.json']);
  assert.deepEqual(optsDiffCompare.command, ['compare', 'base.json', 'curr.json']);

  // 6. lonely pin/diff
  const optsLonelyPin = parseCliArgs(['pin']);
  assert.deepEqual(optsLonelyPin.command, ['pin']);

  const optsLonelyDiff = parseCliArgs(['diff']);
  assert.deepEqual(optsLonelyDiff.command, ['diff']);
});

test('CLI: pin and diff shortcuts work seamlessly for standard runs', async () => {
  const pinDir = path.resolve('.softscope');
  const pinFile = path.join(pinDir, 'last-pin.json');

  // Clean before test
  if (fs.existsSync(pinFile)) {
    fs.unlinkSync(pinFile);
  }

  // 1. softscope pin fixtures/simple/index.js
  const pinRes = await execFileAsync(process.execPath, [CLI_PATH, 'pin', 'fixtures/simple/index.js']);
  assert.ok(fs.existsSync(pinFile), 'pin file should be created');
  assert.ok(pinRes.stdout.includes('Pinned baseline saved') || pinRes.stderr.includes('Pinned baseline saved') || pinRes.stdout.includes('Softscope report'));

  // 2. softscope diff fixtures/simple/index.js
  const diffRes = await execFileAsync(process.execPath, [CLI_PATH, 'diff', 'fixtures/simple/index.js']);
  assert.ok(diffRes.stdout.includes('Performance comparison') || diffRes.stdout.includes('Overview'));

  // Clean up
  if (fs.existsSync(pinFile)) {
    fs.unlinkSync(pinFile);
  }
});

test('CLI: auto-bench --save-baseline and --compare report throughput deltas', async () => {
  const tmpBase = path.resolve('scratch_autobench_base.json');
  if (fs.existsSync(tmpBase)) fs.unlinkSync(tmpBase);

  try {
    // 1. Save auto-bench baseline
    await execFileAsync(process.execPath, [
      CLI_PATH,
      'auto-bench',
      'fixtures/autobench/math.js',
      '--filter', 'add',
      '--iterations', '500',
      '--save-baseline', tmpBase
    ]);

    assert.ok(fs.existsSync(tmpBase), 'baseline file should be created');
    const baseContent = JSON.parse(fs.readFileSync(tmpBase, 'utf-8'));
    assert.equal(baseContent.type, 'softscope-autobench');
    assert.ok(baseContent.functions.some(f => f.name === 'add'));

    // 2. Compare against baseline with Markdown output
    const compRes = await execFileAsync(process.execPath, [
      CLI_PATH,
      'auto-bench',
      'fixtures/autobench/math.js',
      '--filter', 'add',
      '--iterations', '500',
      '--compare', tmpBase,
      '--md'
    ]);

    assert.ok(compRes.stdout.includes('Softscope Auto-Bench Performance Comparison'));
    assert.ok(compRes.stdout.includes('| `add` |'));

    // 3. Standalone compare with two auto-bench JSON files
    const compareRes = await execFileAsync(process.execPath, [
      CLI_PATH,
      'compare',
      tmpBase,
      tmpBase
    ]);

    assert.ok(compareRes.stdout.includes('Auto-Bench Performance Comparison'));
    assert.ok(compareRes.stdout.includes('add'));
  } finally {
    if (fs.existsSync(tmpBase)) fs.unlinkSync(tmpBase);
  }
});

test('CLI: lonely pin and diff commands display clear usage', async () => {
  await assert.rejects(
    async () => {
      await execFileAsync(process.execPath, [CLI_PATH, 'pin']);
    },
    (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes('pin requires a target file or command'));
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await execFileAsync(process.execPath, [CLI_PATH, 'diff']);
    },
    (err) => {
      assert.equal(err.code, 1);
      assert.ok(err.stderr.includes('diff requires a target file or command'));
      return true;
    }
  );
});
