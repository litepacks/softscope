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
