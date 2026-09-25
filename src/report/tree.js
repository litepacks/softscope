import { formatNumber } from './format.js';

/**
 * Builds and renders a hierarchical ASCII Call Tree from caller-callee edges.
 * Handles recursion, deep nesting, and cycle detection safely.
 */
export function renderCallTree(edges, {
  rootNames = [],
  color = true,
  maxDepth = 8
} = {}) {
  if (!edges || !Array.isArray(edges) || edges.length === 0) {
    return '';
  }

  // 1. Group edges by caller: Map<callerName, Array<{ calleeName, calls }>>
  const callerMap = new Map();
  const inDegree = new Map();

  for (const edge of edges) {
    const caller = edge.callerName;
    const callee = edge.calleeName;
    const calls = edge.calls || 0;

    if (!callerMap.has(caller)) {
      callerMap.set(caller, []);
    }
    callerMap.get(caller).push({ calleeName: callee, calls });

    inDegree.set(callee, (inDegree.get(callee) || 0) + 1);
    if (!inDegree.has(caller)) {
      inDegree.set(caller, 0);
    }
  }

  // 2. Identify roots
  let roots = [];
  if (rootNames && rootNames.length > 0) {
    const rootSet = new Set(rootNames);
    roots = Array.from(callerMap.keys()).filter(name => rootSet.has(name));
  }

  if (roots.length === 0) {
    // Functions with 0 incoming calls are true roots
    roots = Array.from(callerMap.keys()).filter(name => inDegree.get(name) === 0);
  }

  // Fallback if there's a pure cycle: sort by most calls
  if (roots.length === 0) {
    roots = Array.from(callerMap.keys());
  }

  const lines = [];

  function traverseNode(nodeName, calls = null, prefix = '', isLast = true, visited = new Set(), depth = 0) {
    if (depth > maxDepth) return;

    const isRoot = depth === 0;
    const connector = isRoot ? '' : (isLast ? '└─ ' : '├─ ');
    const coloredConnector = color ? `\x1b[90m${connector}\x1b[0m` : connector;

    let nodeStr;
    if (isRoot) {
      nodeStr = color ? `\x1b[1;37m${nodeName}\x1b[0m` : nodeName;
    } else {
      nodeStr = color ? `\x1b[36m${nodeName}\x1b[0m` : nodeName;
    }

    const callsStr = (calls != null)
      ? (color ? ` \x1b[33m(x${formatNumber(calls)})\x1b[0m` : ` (x${formatNumber(calls)})`)
      : '';

    const isRecursive = visited.has(nodeName);
    const recurseNotice = isRecursive ? (color ? ' \x1b[90m(recursive)\x1b[0m' : ' (recursive)') : '';

    lines.push(`${prefix}${coloredConnector}${nodeStr}${callsStr}${recurseNotice}`);

    if (isRecursive) {
      return;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(nodeName);

    const children = callerMap.get(nodeName) || [];
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : (color ? '\x1b[90m│  \x1b[0m' : '│  '));

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childIsLast = i === children.length - 1;
      traverseNode(child.calleeName, child.calls, childPrefix, childIsLast, nextVisited, depth + 1);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (i > 0) lines.push('');
    traverseNode(root, null, '', true, new Set(), 0);
  }

  return lines.join('\n');
}
