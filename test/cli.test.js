import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

// Provide clean environment isolated from parent Softscope sessions
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

test('CLI: executes simple fixture and prints report', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout, stderr } = await runCli([file]);

  assert.ok(
    stdout.includes('Calculator result: 64'),
    `Should output program stdout. Actual STDOUT: [${stdout}] STDERR: [${stderr}]`
  );
  assert.ok(stdout.includes('Softscope report'), 'Should include Softscope report');
  assert.ok(stdout.includes('Runtime reach'), 'Should include Runtime reach');
  assert.ok(stdout.includes('Top total time'), 'Should include Top total time');
  assert.ok(stdout.includes('Most called'), 'Should include Most called');
});

test('CLI: --json flag outputs valid JSON version 1 schema', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout } = await runCli([file, '--json']);

  const jsonStart = stdout.indexOf('{');
  assert.ok(jsonStart !== -1, 'Should contain JSON output');

  const jsonText = stdout.slice(jsonStart);
  const data = JSON.parse(jsonText);

  assert.equal(data.version, 1);
  assert.ok(data.runtime.filesObserved >= 1);
  assert.ok(data.functions.length >= 10);
  assert.ok(data.runtime.runtimeReach.executedPercent > 0);
  assert.ok(data.edges.length > 0);
});

test('CLI: --output writes report to file', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const outFile = path.join(FIXTURES_DIR, 'simple', `test-output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);

  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  await runCli([file, '--output', outFile]);

  assert.ok(fs.existsSync(outFile), 'Output file should exist');
  const content = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  assert.equal(content.version, 1);
  assert.ok(content.runtime.functionsExecuted > 0);

  fs.unlinkSync(outFile);
});

test('CLI: --files displays file-level breakdown', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout } = await runCli([file, '--files']);

  assert.ok(stdout.includes('File-level summary'));
  assert.ok(stdout.includes('fixtures/simple/index.js'));
  assert.ok(stdout.includes('functions'));
  assert.ok(stdout.includes('executed'));
});

test('CLI: propagates child process error exit codes', async () => {
  const file = path.join(FIXTURES_DIR, 'error', 'index.js');

  try {
    await runCli([file, '--fatal']);
    assert.fail('Expected process to exit with non-zero code');
  } catch (err) {
    assert.equal(err.code, 1, 'Should propagate exit code 1');
    assert.ok(err.stdout.includes('Softscope report'), 'Report should still be printed on fatal exit');
  }
});

test('CLI: --md flag outputs valid Markdown report to stdout', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout, stderr } = await runCli([file, '--md']);

  assert.ok(
    stdout.includes('Calculator result: 64'),
    `Should output program stdout. Actual STDOUT: [${stdout}] STDERR: [${stderr}]`
  );
  assert.ok(stdout.includes('# Softscope Report'), 'Should include Markdown H1 title');
  assert.ok(stdout.includes('## Runtime Overview'), 'Should include Runtime Overview section');
  assert.ok(stdout.includes('| **Duration** |'), 'Should format metrics in Markdown table');
  assert.ok(stdout.includes('## Top Total Time'), 'Should include Top Total Time section');
  assert.ok(stdout.includes('## Most Called'), 'Should include Most Called section');
});

test('CLI: --output with .md extension writes Markdown report to file', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const outFile = path.join(FIXTURES_DIR, 'simple', `test-output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);

  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  await runCli([file, '--output', outFile]);

  assert.ok(fs.existsSync(outFile), 'Output markdown file should exist');
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.startsWith('# Softscope Report'));
  assert.ok(content.includes('## Runtime Overview'));
  assert.ok(content.includes('## Top Total Time'));

  fs.unlinkSync(outFile);
});

test('CLI: --tui flag degrades gracefully in non-TTY environment', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout, stderr } = await runCli([file, '--tui']);

  assert.ok(
    stdout.includes('Calculator result: 64'),
    `Should output program stdout. Actual STDOUT: [${stdout}] STDERR: [${stderr}]`
  );
  assert.ok(stdout.includes('Softscope report'), 'Should fallback to standard terminal report');
});

test('CLI: --ai flag outputs structured AI profile to stdout', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout, stderr } = await runCli([file, '--ai']);

  assert.ok(
    stdout.includes('Calculator result: 64'),
    `Should output program stdout. Actual STDOUT: [${stdout}] STDERR: [${stderr}]`
  );
  assert.ok(stdout.includes('# Softscope AI Profile'), 'Should include AI profile title');
  assert.ok(stdout.includes('## Critical Bottlenecks (Top Self-Time)'), 'Should include bottlenecks');
  assert.ok(stdout.includes('## Untouched Code (0 runtime calls)'), 'Should include untouched code');
  assert.ok(stdout.includes('neverCalledHelper'), 'Should list untouched function name');
  assert.ok(stdout.includes('## Actionable Directives for AI Agent'), 'Should include directives');
});

test('CLI: --llm alias outputs structured AI profile to stdout', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const { stdout } = await runCli([file, '--llm']);

  assert.ok(stdout.includes('# Softscope AI Profile'), 'Should include AI profile title');
  assert.ok(stdout.includes('## Actionable Directives for AI Agent'), 'Should include directives');
});

test('CLI: --output with .ai extension writes AI profile to file', async () => {
  const file = path.join(FIXTURES_DIR, 'simple', 'index.js');
  const outFile = path.join(FIXTURES_DIR, 'simple', `test-output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ai`);

  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

  await runCli([file, '--output', outFile]);

  assert.ok(fs.existsSync(outFile), 'Output .ai file should exist');
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.ok(content.startsWith('# Softscope AI Profile'));
  assert.ok(content.includes('## Critical Bottlenecks'));
  assert.ok(content.includes('## Actionable Directives'));

  fs.unlinkSync(outFile);
});

