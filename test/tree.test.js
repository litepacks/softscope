import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCallTree } from '../src/report/tree.js';

test('Call Tree: handles empty or invalid edges gracefully', () => {
  assert.equal(renderCallTree([]), '');
  assert.equal(renderCallTree(null), '');
  assert.equal(renderCallTree(undefined), '');
});

test('Call Tree: builds hierarchical ASCII tree with call counts', () => {
  const edges = [
    { callerName: 'parseSql', calleeName: 'tokenizeSql', calls: 100 },
    { callerName: 'parseSql', calleeName: 'SqlParser.parse', calls: 100 },
    { callerName: 'SqlParser.parse', calleeName: 'SqlParser.current', calls: 250 }
  ];

  const plainTree = renderCallTree(edges, { color: false });
  assert.ok(plainTree.includes('parseSql'));
  assert.ok(plainTree.includes('├─ tokenizeSql (x100)'));
  assert.ok(plainTree.includes('└─ SqlParser.parse (x100)'));
  assert.ok(plainTree.includes('└─ SqlParser.current (x250)'));
});

test('Call Tree: detects recursive calls and cycles without hanging', () => {
  const recursiveEdges = [
    { callerName: 'fibonacci', calleeName: 'fibonacci', calls: 50 }
  ];

  const tree = renderCallTree(recursiveEdges, { color: false });
  assert.ok(tree.includes('fibonacci'));
  assert.ok(tree.includes('(recursive)'));

  const cycleEdges = [
    { callerName: 'fnA', calleeName: 'fnB', calls: 10 },
    { callerName: 'fnB', calleeName: 'fnA', calls: 10 }
  ];

  const cycleTree = renderCallTree(cycleEdges, { color: false });
  assert.ok(cycleTree.includes('fnA'));
  assert.ok(cycleTree.includes('(recursive)'));
});

test('Call Tree: respects rootNames filter', () => {
  const edges = [
    { callerName: 'rootA', calleeName: 'childA', calls: 5 },
    { callerName: 'rootB', calleeName: 'childB', calls: 10 }
  ];

  const filteredTree = renderCallTree(edges, { rootNames: ['rootB'], color: false });
  assert.ok(!filteredTree.includes('rootA'));
  assert.ok(filteredTree.includes('rootB'));
  assert.ok(filteredTree.includes('childB'));
});

test('Call Tree: renders diamond dependencies correctly on multiple branches', () => {
  // A calls B and C; both B and C call D
  const diamondEdges = [
    { callerName: 'A', calleeName: 'B', calls: 1 },
    { callerName: 'A', calleeName: 'C', calls: 1 },
    { callerName: 'B', calleeName: 'D', calls: 5 },
    { callerName: 'C', calleeName: 'D', calls: 10 }
  ];

  const tree = renderCallTree(diamondEdges, { color: false });
  assert.ok(tree.includes('A'));
  assert.ok(tree.includes('B'));
  assert.ok(tree.includes('C'));
  // D should appear twice (under B and under C) without being falsely marked recursive
  const matches = tree.match(/D \(x/g) || [];
  assert.equal(matches.length, 2, 'D should be rendered under both branches');
  assert.ok(!tree.includes('(recursive)'), 'Diamond dependency should not trigger recursion notice');
});

test('Call Tree: renders disconnected multi-root forests with blank lines', () => {
  const forestEdges = [
    { callerName: 'serviceA', calleeName: 'helperA', calls: 2 },
    { callerName: 'serviceB', calleeName: 'helperB', calls: 4 }
  ];

  const tree = renderCallTree(forestEdges, { color: false });
  assert.ok(tree.includes('serviceA'));
  assert.ok(tree.includes('helperA'));
  assert.ok(tree.includes('serviceB'));
  assert.ok(tree.includes('helperB'));
  assert.ok(tree.includes('\n\n'), 'Disconnected trees should be separated by blank lines');
});

test('Call Tree: truncates deep chains exceeding maxDepth safely', () => {
  // Chain: 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10
  const chainEdges = [];
  for (let i = 0; i < 10; i++) {
    chainEdges.push({ callerName: `node_${i}`, calleeName: `node_${i + 1}`, calls: 1 });
  }

  const tree = renderCallTree(chainEdges, { maxDepth: 3, color: false });
  assert.ok(tree.includes('node_0'));
  assert.ok(tree.includes('node_3'));
  assert.ok(!tree.includes('node_5'), 'Nodes beyond maxDepth must not be traversed');
});

test('Call Tree: sanitizes null, undefined, negative, or NaN calls', () => {
  const malformedEdges = [
    null,
    undefined,
    {},
    { callerName: null, calleeName: undefined, calls: -10 },
    { callerName: 'safeCaller', calleeName: 'safeCallee', calls: NaN }
  ];

  const tree = renderCallTree(malformedEdges, { color: false });
  assert.ok(tree.includes('safeCaller'));
  assert.ok(tree.includes('safeCallee (x0)'));
  assert.ok(tree.includes('anonymous'));
});
