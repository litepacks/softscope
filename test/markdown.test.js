import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownReport } from '../src/report/markdown.js';
import { formatDuration } from '../src/report/format.js';
import { parseCliArgs } from '../src/config.js';

test('Markdown: renders empty summary gracefully', () => {
  const emptySummary = {
    durationMs: 0,
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
    edges: []
  };

  const md = renderMarkdownReport(emptySummary);
  assert.ok(md.includes('# Softscope Report'));
  assert.ok(md.includes('## Runtime Overview'));
  assert.ok(md.includes(`| **Duration** | ${formatDuration(0)} |`));
  assert.ok(md.includes('| **Runtime reach** | 0.0% executed (0 untouched) |'));
  assert.ok(!md.includes('## Top Total Time'));
  assert.ok(!md.includes('## Call Relationships'));
  assert.ok(!md.includes('## File-Level Summary'));
});

test('Markdown: renders populated summary with tables', () => {
  const summary = {
    durationMs: 520,
    filesObserved: 2,
    functionsDiscovered: 10,
    functionsExecuted: 8,
    functionsNeverExecuted: 2,
    totalFunctionCalls: 150,
    runtimeReach: {
      executedPercent: 80.0,
      notExecutedPercent: 20.0
    },
    functions: [
      {
        id: 1,
        file: 'services/order.js',
        name: 'calculateTotal',
        line: 15,
        column: 0,
        calls: 50,
        totalDurationMs: 120.5,
        selfDurationMs: 45.2,
        avgDurationMs: 2.41,
        maxDurationMs: 10.5
      },
      {
        id: 2,
        file: 'utils/math.js',
        name: 'round',
        line: 5,
        column: 0,
        calls: 100,
        totalDurationMs: 15.0,
        selfDurationMs: 15.0,
        avgDurationMs: 0.15,
        maxDurationMs: 0.5
      }
    ],
    edges: [
      {
        callerName: 'calculateTotal',
        calleeName: 'round',
        calls: 50
      }
    ],
    files: [
      {
        file: 'services/order.js',
        functionsDiscovered: 5,
        functionsExecuted: 4,
        calls: 50,
        totalTimeMs: 120.5
      },
      {
        file: 'utils/math.js',
        functionsDiscovered: 5,
        functionsExecuted: 4,
        calls: 100,
        totalTimeMs: 15.0
      }
    ]
  };

  // Without --files
  const mdWithoutFiles = renderMarkdownReport(summary);
  assert.ok(mdWithoutFiles.includes('# Softscope Report'));
  assert.ok(mdWithoutFiles.includes('## Runtime Overview'));
  assert.ok(mdWithoutFiles.includes('| **Duration** | 520ms |'));
  assert.ok(mdWithoutFiles.includes('| **Files observed** | 2 |'));
  assert.ok(mdWithoutFiles.includes('| **Functions discovered** | 10 |'));
  assert.ok(mdWithoutFiles.includes('| **Functions executed** | 8 |'));
  assert.ok(mdWithoutFiles.includes('| **Function calls** | 150 |'));
  assert.ok(mdWithoutFiles.includes('| **Runtime reach** | 80.0% executed (2 untouched) |'));

  assert.ok(mdWithoutFiles.includes('## Top Total Time'));
  assert.ok(mdWithoutFiles.includes(`| \`calculateTotal\` | \`services/order.js:15\` | 50 | ${formatDuration(120.5)} | ${formatDuration(45.2)} | ${formatDuration(2.41)} | ${formatDuration(10.5)} |`));
  assert.ok(mdWithoutFiles.includes('## Most Called'));
  assert.ok(mdWithoutFiles.includes(`| \`round\` | \`utils/math.js:5\` | 100 | ${formatDuration(15.0)} | ${formatDuration(15.0)} | ${formatDuration(0.15)} |`));

  assert.ok(mdWithoutFiles.includes('## Call Relationships'));
  assert.ok(mdWithoutFiles.includes('| `calculateTotal` | `round` | x50 |'));

  // Should not have file summary by default
  assert.ok(!mdWithoutFiles.includes('## File-Level Summary'));

  // With --files
  const mdWithFiles = renderMarkdownReport(summary, { files: true });
  assert.ok(mdWithFiles.includes('## File-Level Summary'));
  assert.ok(mdWithFiles.includes(`| \`services/order.js\` | 5 | 4 | 80.0% | 50 | ${formatDuration(120.5)} |`));
  assert.ok(mdWithFiles.includes(`| \`utils/math.js\` | 5 | 4 | 80.0% | 100 | ${formatDuration(15.0)} |`));
});

test('Config: parses --md and --markdown flags correctly', () => {
  const opt1 = parseCliArgs(['--md', 'app.js']);
  assert.equal(opt1.md, true);
  assert.deepEqual(opt1.command, ['app.js']);

  const opt2 = parseCliArgs(['--markdown', 'app.js']);
  assert.equal(opt2.md, true);
  assert.deepEqual(opt2.command, ['app.js']);
});
