import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, createSourceLocator } from '../src/instrument/parse.js';
import { createFunctionRegistry } from '../src/instrument/registry.js';

test('OXC Parser & Registry: discovers all function types with contextual names', () => {
  const code = `
function getUser(id) { return id; }
const findUser = (name) => name;
const authService = {
  login() {},
  get token() {},
  set token(t) {}
};
class OrderManager {
  constructor() {}
  processOrder() {}
  static cancelOrder() {}
}
users.map(u => u.id);
router.get('/orders', (req, res) => {});
setTimeout(function timeoutHandler() {}, 100);
(() => {})();
module.exports = function(req, res) {};
function* numberGenerator() { yield 1; }
`;

  const { ast, errors } = parseSource('test.js', code);
  assert.equal(errors.length, 0, 'Should parse without errors');

  const locator = createSourceLocator(code);
  const registry = createFunctionRegistry();
  const functions = registry.discoverFunctions(ast, 'test.js', locator);

  assert.ok(functions.length >= 12, `Expected at least 12 functions, found ${functions.length}`);

  const nameMap = new Map(functions.map(f => [f.name, f]));

  // 1. FunctionDeclaration
  assert.ok(nameMap.has('getUser'), 'Should find getUser');
  assert.equal(nameMap.get('getUser').type, 'FunctionDeclaration');

  // 2. ArrowFunction
  assert.ok(nameMap.has('findUser'), 'Should find findUser');
  assert.equal(nameMap.get('findUser').type, 'ArrowFunctionExpression');

  // 3. Object methods & accessors
  assert.ok(nameMap.has('login'), 'Should find login');
  assert.ok(nameMap.has('get token'), 'Should find get token');
  assert.ok(nameMap.has('set token'), 'Should find set token');

  // 4. Class methods & constructor
  assert.ok(nameMap.has('OrderManager.constructor'), 'Should find OrderManager.constructor');
  assert.ok(nameMap.has('OrderManager.processOrder'), 'Should find OrderManager.processOrder');
  assert.ok(nameMap.has('OrderManager.cancelOrder'), 'Should find OrderManager.cancelOrder');

  // 5. Callbacks
  assert.ok(nameMap.has('users.map callback'), 'Should name users.map callback');
  assert.ok(nameMap.has('router.get callback'), 'Should name router.get callback');

  // 6. Assignment
  assert.ok(nameMap.has('module.exports handler'), 'Should name module.exports handler');

  // 7. Generator
  assert.ok(nameMap.has('numberGenerator'), 'Should find numberGenerator');
  assert.equal(nameMap.get('numberGenerator').generator, true);
  assert.equal(nameMap.get('numberGenerator').unsupported, 'generator');
});
