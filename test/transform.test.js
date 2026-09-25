import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunctionRegistry } from '../src/instrument/registry.js';
import { transformSource } from '../src/instrument/transform.js';

test('Transformation: preserves semantics of sync functions, returns, and arrows', () => {
  const code = `
function add(a, b) {
  return a + b;
}

const multiply = (a, b) => a * b;

const nested = () => x => x * 2;
`;

  const registry = createFunctionRegistry();
  const { code: transformed, transformed: ok, functions } = transformSource(
    code,
    'math.js',
    'math.js',
    registry
  );

  assert.equal(ok, true);
  assert.equal(functions.length, 4);

  // Test executing transformed code in a controlled environment
  const calls = [];
  const __softscope = {
    enter(id) { calls.push({ type: 'enter', id }); },
    exit(id) { calls.push({ type: 'exit', id }); },
    registerFile(file, fns) {}
  };

  const fn = new Function('__softscope', `${transformed}; return { add, multiply, nested };`);
  const scope = fn(__softscope);

  assert.equal(scope.add(2, 3), 5);
  assert.equal(scope.multiply(4, 5), 20);
  const double = scope.nested();
  assert.equal(double(7), 14);

  // Verify enter and exit matched
  assert.ok(calls.length >= 6);
  assert.equal(calls[0].type, 'enter');
  assert.equal(calls[1].type, 'exit');
});

test('Transformation: preserves directive prologue ("use strict")', () => {
  const code = `
function strictFn() {
  "use strict";
  return 42;
}
`;

  const registry = createFunctionRegistry();
  const { code: transformed } = transformSource(code, 'strict.js', 'strict.js', registry);

  assert.ok(transformed.includes('"use strict"'));
  // enter should be placed after "use strict"
  const strictIndex = transformed.indexOf('"use strict"');
  const enterIndex = transformed.indexOf('__softscope.enter');
  assert.ok(enterIndex > strictIndex, 'enter must be after "use strict" directive');
});

test('Transformation: does not wrap generators', () => {
  const code = `
function* numbers() {
  yield 1;
  yield 2;
}
`;

  const registry = createFunctionRegistry();
  const { code: transformed, functions } = transformSource(code, 'gen.js', 'gen.js', registry);

  assert.equal(functions[0].unsupported, 'generator');
  assert.ok(!transformed.includes('__softscope.enter'), 'Generators should not be wrapped');
});

test('Transformation: correctly handles empty block functions and arrow handlers', () => {
  const code = `
const noop = () => {};
function emptyFn() {}
obj.on('error', () => {});
`;

  const registry = createFunctionRegistry();
  const { code: transformed, transformed: ok, functions } = transformSource(code, 'empty.js', 'empty.js', registry);

  assert.equal(ok, true);
  assert.equal(functions.length, 3);

  // Must parse as valid JS without syntax errors
  const calls = [];
  const __softscope = {
    enter(id) { calls.push({ type: 'enter', id }); },
    exit(id) { calls.push({ type: 'exit', id }); },
    registerFile() {}
  };

  const obj = { on(evt, fn) { fn(); } };
  const fn = new Function('__softscope', 'obj', `${transformed}; return { noop, emptyFn };`);
  const scope = fn(__softscope, obj);

  scope.noop();
  scope.emptyFn();

  assert.equal(calls.length, 6);
  assert.equal(calls[0].type, 'enter');
  assert.equal(calls[1].type, 'exit');
});

test('Transformation: guarantees enter and exit balance when functions throw errors', () => {
  const code = `
function thrower() {
  throw new Error("fatal failure");
}
`;

  const registry = createFunctionRegistry();
  const { code: transformed } = transformSource(code, 'thrower.js', 'thrower.js', registry);

  const calls = [];
  const __softscope = {
    enter(id) { calls.push({ type: 'enter', id }); },
    exit(id) { calls.push({ type: 'exit', id }); },
    registerFile() {}
  };

  const fn = new Function('__softscope', `${transformed}; return { thrower };`);
  const scope = fn(__softscope);

  assert.throws(() => {
    scope.thrower();
  }, /fatal failure/);

  // Even though an error was thrown, finally must have called exit
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'enter');
  assert.equal(calls[1].type, 'exit');
});

test('Transformation: correctly instruments concise arrow functions returning object literals', () => {
  const code = `
const makeUser = (name, age) => ({ user: name, age: age * 2 });
`;

  const registry = createFunctionRegistry();
  const { code: transformed, functions } = transformSource(code, 'user.js', 'user.js', registry);

  assert.equal(functions.length, 1);

  const calls = [];
  const __softscope = {
    enter(id) { calls.push({ type: 'enter', id }); },
    exit(id) { calls.push({ type: 'exit', id }); },
    registerFile() {}
  };

  const fn = new Function('__softscope', `${transformed}; return { makeUser };`);
  const scope = fn(__softscope);

  const result = scope.makeUser('alice', 25);
  assert.deepEqual(result, { user: 'alice', age: 50 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'enter');
  assert.equal(calls[1].type, 'exit');
});

test('Transformation: preserves shebang at line 1', () => {
  const code = `#!/usr/bin/env node
function main() {
  return 100;
}
`;

  const registry = createFunctionRegistry();
  const { code: transformed } = transformSource(code, 'cli.js', 'cli.js', registry);

  assert.ok(transformed.startsWith('#!/usr/bin/env node\n'), 'Transformed code must keep shebang on line 1');
  assert.ok(transformed.includes('__softscope.enter'), 'Should still instrument functions');
});

test('Transformation: preserves this binding and semantics across class methods and constructors', () => {
  const code = `
class Calculator {
  constructor(initial = 0) {
    this.value = initial;
  }
  add(n) {
    this.value += n;
    return this.value;
  }
  static create(val) {
    return new Calculator(val);
  }
}
`;

  const registry = createFunctionRegistry();
  const { code: transformed } = transformSource(code, 'calc.js', 'calc.js', registry);

  const calls = [];
  const __softscope = {
    enter(id) { calls.push({ type: 'enter', id }); },
    exit(id) { calls.push({ type: 'exit', id }); },
    registerFile() {}
  };

  const fn = new Function('__softscope', `${transformed}; return { Calculator };`);
  const { Calculator } = fn(__softscope);

  const calc = Calculator.create(10);
  assert.equal(calc.add(5), 15);
  assert.equal(calc.value, 15);

  // create + constructor + add
  assert.ok(calls.length >= 6);
  assert.equal(calls[0].type, 'enter');
});
