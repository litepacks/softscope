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

test('RuntimeCollector: dynamically grows TypedArray buffers and preserves data under stress', () => {
  // Start with very small capacity (4) to force multiple reallocations
  const collector = new RuntimeCollector(4);

  collector.registerFile('stress.js', [
    { id: 2, file: 'stress.js', name: 'earlyFn', line: 1, column: 1, type: 'FunctionDeclaration' },
    { id: 100, file: 'stress.js', name: 'midFn', line: 10, column: 1, type: 'FunctionDeclaration' },
    { id: 2000, file: 'stress.js', name: 'largeFn', line: 20, column: 1, type: 'FunctionDeclaration' }
  ]);

  assert.ok(collector.capacity >= 2001, 'Capacity should have expanded past 2000');

  // Verify earlier registered function still works
  collector.enter(2);
  collector.exit(2);

  collector.enter(100);
  collector.exit(100);

  collector.enter(2000);
  collector.exit(2000);

  const snapshot = collector.getSnapshot();
  const early = snapshot.functions.find(f => f.id === 2);
  const mid = snapshot.functions.find(f => f.id === 100);
  const large = snapshot.functions.find(f => f.id === 2000);

  assert.equal(early.calls, 1);
  assert.equal(mid.calls, 1);
  assert.equal(large.calls, 1);
  assert.ok(early.totalDurationMs >= 0);
  assert.ok(mid.totalDurationMs >= 0);
  assert.ok(large.totalDurationMs >= 0);
});

test('CallStack: handles deep recursion exceeding initial stack capacity', async () => {
  const { CallStack } = await import('../src/runtime/stack.js');
  // Initial capacity 8 to force multiple growths
  const stack = new CallStack(8);

  const depth = 400;
  for (let i = 1; i <= depth; i++) {
    const callerId = stack.enter(i, 1000 + i);
    if (i === 1) {
      assert.equal(callerId, null);
    } else {
      assert.equal(callerId, i - 1);
    }
  }

  assert.equal(stack.depth, depth);
  assert.ok(stack.capacity >= depth);

  // Unwind stack in reverse
  for (let i = depth; i >= 1; i--) {
    const res = stack.exit(i, 2000 + i);
    assert.equal(res.found, true);
    assert.ok(res.duration >= 0);
  }

  assert.equal(stack.depth, 0);
});

test('CallStack: handles out-of-order interleaved exits and underflow gracefully', async () => {
  const { CallStack } = await import('../src/runtime/stack.js');
  const stack = new CallStack(16);

  // Underflow test on empty stack
  const underflow = stack.exit(999, 100);
  assert.equal(underflow.found, false);
  assert.equal(underflow.duration, 0);

  // Enter A (1), enter B (2), enter C (3)
  stack.enter(1, 100);
  stack.enter(2, 110);
  stack.enter(3, 120);

  // Exit B out-of-order while C and A are active
  const exitB = stack.exit(2, 130);
  assert.equal(exitB.found, true);
  assert.equal(exitB.duration, 20); // 130 - 110
  assert.equal(stack.depth, 2);

  // Attempt to exit an ID that does not exist in stack
  const missingExit = stack.exit(999, 140);
  assert.equal(missingExit.found, false);
  assert.equal(stack.depth, 2);

  // Exit C
  const exitC = stack.exit(3, 150);
  assert.equal(exitC.found, true);
  assert.equal(stack.depth, 1);

  // Exit A
  const exitA = stack.exit(1, 160);
  assert.equal(exitA.found, true);
  assert.equal(stack.depth, 0);
});

test('safeSerializeArgs: sanitizes circular refs, throwing getters, BigInt, and deep objects', async () => {
  const { safeSerializeArgs } = await import('../src/runtime/collector.js');

  // Primitives
  assert.deepEqual(safeSerializeArgs([1, 'hello', true, null, undefined]), [1, 'hello', true, null, undefined]);

  // BigInt and Symbol
  const sym = Symbol('foo');
  const serialized = safeSerializeArgs([42n, sym]);
  assert.equal(serialized[0], '42n');
  assert.equal(serialized[1], 'Symbol(foo)');

  // Function
  assert.deepEqual(safeSerializeArgs([function test() {}]), ['[Function]']);

  // Circular reference
  const circularObj = { name: 'root' };
  circularObj.self = circularObj;
  const serializedCircular = safeSerializeArgs([circularObj]);
  assert.equal(serializedCircular[0].name, 'root');
  assert.ok(serializedCircular[0].self !== undefined);

  // Object with throwing getter
  const evilObj = {};
  Object.defineProperty(evilObj, 'boom', {
    get() { throw new Error('getter detonation'); }
  });
  const serializedEvil = safeSerializeArgs([evilObj]);
  assert.ok(serializedEvil[0] === '[Unserializable Object]' || typeof serializedEvil[0] === 'object');

  // Large array truncated to 20 elements
  const bigArray = Array.from({ length: 50 }, (_, i) => i);
  const serializedArray = safeSerializeArgs([bigArray]);
  assert.equal(serializedArray[0].length, 20);
});

test('RuntimeCollector: reset clears all metrics, stack, and edges cleanly', () => {
  const collector = new RuntimeCollector();
  collector.registerFile('test.js', [
    { id: 1, file: 'test.js', name: 'fn1', line: 1, column: 1, type: 'FunctionDeclaration' }
  ]);

  collector.enter(1);
  collector.exit(1, true); // error = true
  assert.equal(collector.calls[1], 1);
  assert.equal(collector.errors[1], 1);

  collector.reset();

  assert.equal(collector.calls[1], 0);
  assert.equal(collector.errors[1], 0);
  assert.equal(collector.totalTime[1], 0);
  assert.equal(collector.selfTime[1], 0);
  assert.equal(collector.minTime[1], Infinity);
  assert.equal(collector.maxTime[1], 0);
  assert.equal(collector.inFlight[1], 0);
  assert.equal(collector.stack.depth, 0);
  assert.equal(collector.edges.size, 0);
});
