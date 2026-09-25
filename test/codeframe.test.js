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

test('Codeframe: handles paths with spaces and parentheses in stack traces', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const tmpDir = path.join(os.tmpdir(), `softscope space test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const spaceFile = path.join(tmpDir, 'my target.js');
    fs.writeFileSync(spaceFile, 'export function boom() {\n  throw new Error("fail");\n}\n', 'utf-8');

    const stackWithParens = `Error: fail\n    at boom (${spaceFile}:2:9)\n    at node:internal/main:1:1`;
    const parsed1 = parseStackFrame(stackWithParens);
    assert.ok(parsed1, 'should parse stack trace with spaces inside parentheses');
    assert.equal(parsed1.filePath, path.resolve(spaceFile));
    assert.equal(parsed1.line, 2);
    assert.equal(parsed1.column, 9);

    const stackWithoutParens = `Error: fail\n    at ${spaceFile}:2:9`;
    const parsed2 = parseStackFrame(stackWithoutParens);
    assert.ok(parsed2, 'should parse stack trace with spaces without parentheses');
    assert.equal(parsed2.filePath, path.resolve(spaceFile));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});

test('Codeframe: handles CRLF line endings, extreme line/col boundaries, and empty files', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const tmpDir = path.join(os.tmpdir(), `softscope-crlf-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const crlfFile = path.join(tmpDir, 'crlf.js');
    fs.writeFileSync(crlfFile, 'line1\r\nline2\r\nline3\r\n', 'utf-8');

    const frame = createCodeFrame(crlfFile, 2, 3, { color: false });
    assert.ok(!frame.includes('\r'), 'Codeframe must strip carriage return characters');
    assert.ok(frame.includes('> 2 | line2'));

    // Boundary: line number <= 0 clamps to line 1
    const clampedUnder = createCodeFrame(crlfFile, -5, 1, { color: false });
    assert.ok(clampedUnder.includes('> 1 | line1'));

    // Boundary: line number > total lines clamps to last line
    const clampedOver = createCodeFrame(crlfFile, 999, 1, { color: false });
    assert.ok(clampedOver.includes('> 3 | line3') || clampedOver.includes('> 4 |'));

    // Boundary: column <= 0 does not crash or print negative indents
    const zeroCol = createCodeFrame(crlfFile, 1, 0, { color: false });
    assert.ok(zeroCol.includes('> 1 | line1'));

    // Boundary: empty file
    const emptyFile = path.join(tmpDir, 'empty.js');
    fs.writeFileSync(emptyFile, '', 'utf-8');
    const emptyFrame = createCodeFrame(emptyFile, 1, 1);
    assert.equal(emptyFrame, '');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});
