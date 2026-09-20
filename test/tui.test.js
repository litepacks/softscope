import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTui } from '../src/report/tui.js';
import { parseCliArgs } from '../src/config.js';

function createMockStream(isTTY = true, columns = 100, rows = 30) {
  const emitter = new EventEmitter();
  emitter.isTTY = isTTY;
  emitter.columns = columns;
  emitter.rows = rows;
  emitter.written = [];
  emitter.write = (chunk) => {
    emitter.written.push(String(chunk));
    return true;
  };
  emitter.resume = () => {};
  emitter.pause = () => {};
  emitter.setRawMode = () => {};
  return emitter;
}

test('TUI Config: parses --tui flag correctly', () => {
  const opt = parseCliArgs(['--tui', 'bench/run.js']);
  assert.equal(opt.tui, true);
  assert.equal(opt.live, true);
  assert.deepEqual(opt.command, ['bench/run.js']);
});

test('TUI Engine: state transitions, logs, and updates', () => {
  const mockStdout = createMockStream();
  const mockStdin = createMockStream();

  const tui = createTui({
    stdout: mockStdout,
    stdin: mockStdin,
    targetCommand: 'node test.js'
  });

  const state = tui.getState();
  assert.equal(state.status, 'running');
  assert.equal(state.activeTab, 0);

  // 1. Append logs
  tui.appendLog('First line', 'stdout');
  tui.appendLog('Warning line', 'stderr');
  assert.equal(state.logs.length, 2);
  assert.ok(state.logs[0].includes('First line'));
  assert.ok(state.logs[1].includes('[err]') && state.logs[1].includes('Warning line'));

  // 2. Receive heartbeat update
  tui.update({
    pid: 9999,
    totalCalls: 1500,
    filesObserved: 3,
    functionsDiscovered: 12,
    functionsExecuted: 8,
    runtimeReach: { executedPercent: 66.7, notExecutedPercent: 33.3 },
    hot: [{ name: 'fastMath', calls: 1000, totalDurationMs: 12.5 }]
  });

  assert.equal(state.pid, 9999);
  assert.equal(state.liveStats.totalCalls, 1500);

  // 3. Finish execution
  tui.finish({
    durationMs: 450,
    totalFunctionCalls: 1500,
    functions: [
      { name: 'fastMath', file: 'math.js', line: 5, calls: 1000, totalDurationMs: 12.5, selfDurationMs: 12.5, avgDurationMs: 0.01 },
      { name: 'slowIo', file: 'io.js', line: 20, calls: 500, totalDurationMs: 80.0, selfDurationMs: 30.0, avgDurationMs: 0.16 }
    ],
    edges: [
      { callerName: 'main', calleeName: 'fastMath', calls: 1000 }
    ],
    files: [
      { file: 'math.js', functionsDiscovered: 5, functionsExecuted: 4, calls: 1000, totalTimeMs: 12.5 }
    ]
  }, 0);

  assert.equal(state.status, 'completed');
  assert.equal(state.exitCode, 0);
  assert.equal(state.durationMs, 450);

  tui.close();
});

test('TUI Engine: keyboard tab switching and sorting', () => {
  const mockStdout = createMockStream();
  const mockStdin = createMockStream();

  const tui = createTui({
    stdout: mockStdout,
    stdin: mockStdin,
    targetCommand: 'bench.js'
  });

  const state = tui.getState();

  // Test direct tab number keys
  tui.handleKeypress('2', { name: '2' });
  assert.equal(state.activeTab, 1, 'Key 2 should switch to Functions tab');

  tui.handleKeypress('3', { name: '3' });
  assert.equal(state.activeTab, 2, 'Key 3 should switch to Call Graph tab');

  tui.handleKeypress('5', { name: '5' });
  assert.equal(state.activeTab, 4, 'Key 5 should switch to Logs tab');

  // Test Tab cycling
  tui.handleKeypress('', { name: 'tab', shift: false });
  assert.equal(state.activeTab, 0, 'Tab from 5 should cycle to 0');

  // Test sort cycling with 's'
  assert.equal(state.sortBy, 'total');
  tui.handleKeypress('s', { name: 's' });
  assert.equal(state.sortBy, 'self');
  tui.handleKeypress('s', { name: 's' });
  assert.equal(state.sortBy, 'calls');
  tui.handleKeypress('s', { name: 's' });
  assert.equal(state.sortBy, 'avg');

  // Test Arrow navigation
  tui.handleKeypress('2', { name: '2' }); // Functions tab
  tui.finish({
    functions: [
      { name: 'fn1', calls: 10 },
      { name: 'fn2', calls: 20 },
      { name: 'fn3', calls: 30 }
    ]
  });

  tui.handleKeypress('', { name: 'down' });
  assert.equal(state.selectedIndices[1], 1);
  tui.handleKeypress('', { name: 'down' });
  assert.equal(state.selectedIndices[1], 2);
  tui.handleKeypress('', { name: 'up' });
  assert.equal(state.selectedIndices[1], 1);

  // Test Enter to toggle function details modal
  tui.handleKeypress('', { name: 'enter' });
  assert.ok(state.selectedFunction, 'Enter should open modal');
  assert.equal(state.selectedFunction.name, 'fn2');

  tui.handleKeypress('', { name: 'escape' });
  assert.equal(state.selectedFunction, null, 'Escape should close modal');

  tui.close();
});

test('TUI Renderer: renders all tabs without exceptions', () => {
  const mockStdout = createMockStream();
  const mockStdin = createMockStream();

  const tui = createTui({
    stdout: mockStdout,
    stdin: mockStdin
  });

  tui.finish({
    durationMs: 300,
    filesObserved: 2,
    functionsDiscovered: 10,
    functionsExecuted: 8,
    totalFunctionCalls: 100,
    runtimeReach: { executedPercent: 80.0, notExecutedPercent: 20.0 },
    functions: [
      { name: 'calc', file: 'calc.js', line: 1, calls: 50, totalDurationMs: 10, selfDurationMs: 5, avgDurationMs: 0.2, minDurationMs: 0.1, maxDurationMs: 0.5 }
    ],
    edges: [
      { callerName: 'main', calleeName: 'calc', calls: 50 }
    ],
    files: [
      { file: 'calc.js', functionsDiscovered: 5, functionsExecuted: 4, calls: 50, totalTimeMs: 10 }
    ]
  });

  // Render tabs 0..4
  for (let tab = 0; tab < 5; tab++) {
    const lines = tui.renderTabContent(tab, 80, 20);
    assert.ok(Array.isArray(lines));
    assert.ok(lines.length > 0);
  }

  tui.close();
});
