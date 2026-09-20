import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeCollector } from '../src/runtime/collector.js';

test('RuntimeCollector: accurately calculates self time and call graph edges', async () => {
  const collector = new RuntimeCollector();

  collector.registerFile('src/service.js', [
    { id: 1, file: 'src/service.js', name: 'parentFn', line: 1, column: 1, type: 'FunctionDeclaration' },
    { id: 2, file: 'src/service.js', name: 'childFn', line: 5, column: 1, type: 'FunctionDeclaration' }
  ]);

  // Simulate parent calling child
  collector.enter(1); // parent starts
  await new Promise(r => setTimeout(r, 10)); // parent self work ~10ms

  collector.enter(2); // child starts
  await new Promise(r => setTimeout(r, 20)); // child work ~20ms
  collector.exit(2);  // child ends

  await new Promise(r => setTimeout(r, 10)); // parent self work ~10ms
  collector.exit(1);  // parent ends

  const snapshot = collector.getSnapshot();
  const parent = snapshot.functions.find(f => f.id === 1);
  const child = snapshot.functions.find(f => f.id === 2);

  assert.equal(parent.calls, 1);
  assert.equal(child.calls, 1);

  // Child total time should be roughly >= 20ms
  assert.ok(child.totalDurationMs >= 15, `Child duration expected >= 15ms, got ${child.totalDurationMs}`);

  // Parent total time should be >= child total time + 15ms (~40ms)
  assert.ok(parent.totalDurationMs >= child.totalDurationMs + 10, 'Parent total time should include child');

  // Parent self time must NOT include child duration (should be ~20ms, noticeably less than total)
  assert.ok(parent.selfDurationMs < parent.totalDurationMs, 'Parent self time must be less than total time');
  assert.ok(
    parent.selfDurationMs <= parent.totalDurationMs - (child.totalDurationMs * 0.8),
    'Parent self time must subtract nested child time'
  );

  // Call graph edge
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.edges[0].callerName, 'parentFn');
  assert.equal(snapshot.edges[0].calleeName, 'childFn');
  assert.equal(snapshot.edges[0].calls, 1);
});

test('RuntimeCollector: handles errors and in-flight tracking', () => {
  const collector = new RuntimeCollector();
  collector.registerFile('src/err.js', [
    { id: 1, file: 'src/err.js', name: 'failingFn', line: 1, column: 1, type: 'FunctionDeclaration' }
  ]);

  assert.equal(collector.getActiveCount(), 0);
  collector.enter(1);
  assert.equal(collector.getActiveCount(), 1);
  collector.exit(1, true); // exited with error

  assert.equal(collector.getActiveCount(), 0);
  const snapshot = collector.getSnapshot();
  const fn = snapshot.functions.find(f => f.id === 1);
  assert.equal(fn.calls, 1);
  assert.equal(fn.errors, 1);
});
