import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStackFrame, createCodeFrame } from '../src/report/codeframe.js';

const __filename = fileURLToPath(import.meta.url);

test('Codeframe: parseStackFrame parses stack trace frames accurately', () => {
  assert.equal(parseStackFrame(null), null);
  assert.equal(parseStackFrame(''), null);
  assert.equal(parseStackFrame(123), null);

  const fixtureFile = path.resolve('fixtures/autobench/math.js');
  const sampleStack = `Error: Cannot read properties of null (reading 'toUpperCase')
    at formatName (${fixtureFile}:18:11)
    at runBenchmark (node:internal/modules/cjs/loader:123:45)
    at file:///softscope-autobench-runner.js:50:10`;

  const parsed = parseStackFrame(sampleStack);
  assert.ok(parsed, 'should parse user stack frame');
  assert.equal(parsed.filePath, fixtureFile);
  assert.equal(parsed.line, 18);
  assert.equal(parsed.column, 11);

  // Fallback to preferredFile when file doesn't exist
  const fallback = parseStackFrame('Error at nonexistent.js:99:99', fixtureFile);
  assert.ok(fallback);
  assert.equal(fallback.filePath, fixtureFile);
});

test('Codeframe: createCodeFrame generates code snippet with gutter and caret', () => {
  const nonExistent = createCodeFrame('/non/existent/path.js', 10, 5);
  assert.equal(nonExistent, '');

  const fixtureFile = path.resolve('fixtures/autobench/math.js');
  const frame = createCodeFrame(fixtureFile, 18, 11, {
    linesBefore: 1,
    linesAfter: 1,
    color: false,
    message: 'Cannot read properties of null'
  });

  assert.ok(frame.includes('> 18 |'), 'should contain line 18 with marker');
  assert.ok(frame.includes('^ Cannot read properties of null'), 'should contain caret pointer and message');
  assert.ok(frame.includes('name.toUpperCase()'), 'should include target code');
});
