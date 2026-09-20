import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { softscope } from '../src/vite/index.js';
import { initSoftscopeClient } from '../src/vite/client.js';

test('Vite Plugin: exports plugin factory with proper hooks and metadata', () => {
  const plugin = softscope({ position: 'bottom-left' });

  assert.equal(plugin.name, 'softscope');
  assert.equal(plugin.enforce, 'pre');
  assert.equal(typeof plugin.configResolved, 'function');
  assert.equal(typeof plugin.resolveId, 'function');
  assert.equal(typeof plugin.load, 'function');
  assert.equal(typeof plugin.transformIndexHtml, 'function');
  assert.equal(typeof plugin.transform, 'function');
});

test('Vite Plugin: resolves virtual:softscope-client module correctly', () => {
  const plugin = softscope();

  const id1 = plugin.resolveId('virtual:softscope-client');
  assert.equal(id1, '\0virtual:softscope-client');

  const id2 = plugin.resolveId('/@id/virtual:softscope-client');
  assert.equal(id2, '\0virtual:softscope-client');

  const id3 = plugin.resolveId('/virtual:softscope-client');
  assert.equal(id3, '\0virtual:softscope-client');

  const id4 = plugin.resolveId('lodash');
  assert.equal(id4, null);
});

test('Vite Plugin: loads virtual client module with configurable options', () => {
  const pluginDefault = softscope();
  const codeDefault = pluginDefault.load('\0virtual:softscope-client');
  assert.ok(codeDefault.includes('initSoftscopeClient'));
  assert.ok(codeDefault.includes('"overlay":true'));
  assert.ok(codeDefault.includes('"position":"bottom-right"'));

  const pluginCustom = softscope({ overlay: false, position: 'top-left', openHotkey: 'alt+k' });
  const codeCustom = pluginCustom.load('\0virtual:softscope-client');
  assert.ok(codeCustom.includes('"overlay":false'));
  assert.ok(codeCustom.includes('"position":"top-left"'));
  assert.ok(codeCustom.includes('"openHotkey":"alt+k"'));
});

test('Vite Plugin: injects script tag into index.html unless overlay is disabled', () => {
  const pluginWithOverlay = softscope();
  const tags = pluginWithOverlay.transformIndexHtml();
  assert.ok(Array.isArray(tags));
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tag, 'script');
  assert.equal(tags[0].attrs.src, '/@id/virtual:softscope-client');
  assert.equal(tags[0].injectTo, 'head-prepend');

  const pluginNoOverlay = softscope({ overlay: false });
  const noTags = pluginNoOverlay.transformIndexHtml();
  assert.equal(noTags, undefined);
});

test('Vite Plugin: instruments application files with virtual import and sourcemap', () => {
  const root = path.resolve('/tmp/test-vite-project');
  const plugin = softscope();
  plugin.configResolved({ root });

  const filePath = path.join(root, 'src', 'calculator.ts');
  const sourceCode = `
export function compute(a: number, b: number): number {
  return a * b + 10;
}

export const renderValue = (val: number) => val.toString();
`;

  const result = plugin.transform(sourceCode, filePath);
  assert.ok(result);
  assert.equal(typeof result.code, 'string');
  assert.ok(result.map, 'Source map should be generated');

  // Verify virtual import was injected
  assert.ok(result.code.includes('import __softscope from "virtual:softscope-client";'));
  // Verify file registration
  assert.ok(result.code.includes('globalThis.__softscope?.registerFile?.'));
  assert.ok(result.code.includes('"src/calculator.ts"'));
  // Verify function enter and exit hooks
  assert.ok(result.code.includes('__softscope.enter(1)'));
  assert.ok(result.code.includes('__softscope.exit(1)'));
  assert.ok(result.code.includes('__softscope.enter(2)'));
  assert.ok(result.code.includes('__softscope.exit(2)'));
});

test('Vite Plugin: filters excluded files, node_modules, and internal modules', () => {
  const root = path.resolve('/tmp/test-vite-project');
  const plugin = softscope({
    exclude: ['**/ignored/**']
  });
  plugin.configResolved({ root });

  // Excluded by path pattern
  const ignoredFile = path.join(root, 'src', 'ignored', 'worker.js');
  assert.equal(plugin.transform('function x() {}', ignoredFile), null);

  // Excluded by node_modules
  const nodeModuleFile = path.join(root, 'node_modules', 'react', 'index.js');
  assert.equal(plugin.transform('function x() {}', nodeModuleFile), null);

  // Excluded virtual modules
  assert.equal(plugin.transform('export default {}', '\0virtual:foo'), null);
  assert.equal(plugin.transform('export default {}', 'virtual:softscope-client'), null);
});

test('Browser Client: collects runtime metrics, AI diagnostic profile, and supports reset', () => {
  const client = initSoftscopeClient({ overlay: false });

  // Simulate registering a file with 2 functions
  client.registerFile('src/services/api.ts', [
    { id: 101, file: 'src/services/api.ts', name: 'fetchUser', line: 10, column: 1, type: 'FunctionDeclaration' },
    { id: 102, file: 'src/services/api.ts', name: 'parsePayload', line: 25, column: 1, type: 'FunctionDeclaration' }
  ]);

  // Simulate executing functions
  client.enter(101);
  client.enter(102);
  client.exit(102);
  client.exit(101);

  const snapshot = client.getSnapshot();
  assert.equal(snapshot.totalCalls, 2);
  assert.equal(snapshot.totalDiscovered, 2);
  assert.equal(snapshot.totalExecuted, 2);

  // Check AI Profile output
  const aiProfile = client.getAiProfile();
  assert.ok(aiProfile.includes('# Softscope AI Profile (Browser)'));
  assert.ok(aiProfile.includes('fetchUser'));
  assert.ok(aiProfile.includes('Actionable Directives for AI Agent'));

  // Test reset
  client.reset();
  const resetSnapshot = client.getSnapshot();
  assert.equal(resetSnapshot.totalCalls, 0);
  assert.equal(resetSnapshot.totalExecuted, 0);
});
