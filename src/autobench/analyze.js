import fs from 'node:fs';
import path from 'node:path';
import { parseSource, createSourceLocator } from '../instrument/parse.js';

function extractParamInfo(paramNode) {
  if (!paramNode) return { name: 'arg', hasDefault: false };

  let name = 'arg';
  let hasDefault = false;
  let defaultValue = undefined;
  let tsType = null;

  if (paramNode.type === 'Identifier') {
    name = paramNode.name;
    if (paramNode.typeAnnotation && paramNode.typeAnnotation.typeAnnotation) {
      tsType = resolveTsType(paramNode.typeAnnotation.typeAnnotation);
    }
  } else if (paramNode.type === 'AssignmentPattern') {
    hasDefault = true;
    if (paramNode.left && paramNode.left.type === 'Identifier') {
      name = paramNode.left.name;
      if (paramNode.left.typeAnnotation && paramNode.left.typeAnnotation.typeAnnotation) {
        tsType = resolveTsType(paramNode.left.typeAnnotation.typeAnnotation);
      }
    }
    if (paramNode.right) {
      if (paramNode.right.type === 'Literal') {
        defaultValue = paramNode.right.value;
      } else if (paramNode.right.type === 'ArrayExpression') {
        defaultValue = (paramNode.right.elements || [])
          .filter(el => el && el.type === 'Literal')
          .map(el => el.value);
      } else if (paramNode.right.type === 'ObjectExpression') {
        const obj = {};
        for (const prop of paramNode.right.properties || []) {
          const k = prop.key ? (prop.key.name || prop.key.value) : null;
          if (k && prop.value && prop.value.type === 'Literal') {
            obj[k] = prop.value.value;
          }
        }
        defaultValue = obj;
      }
    }
  } else if (paramNode.type === 'RestElement') {
    name = paramNode.argument ? paramNode.argument.name : 'rest';
  }

  return { name, hasDefault, defaultValue, tsType };
}

function resolveTsType(typeNode) {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case 'TSNumberKeyword':
      return 'number';
    case 'TSStringKeyword':
      return 'string';
    case 'TSBooleanKeyword':
      return 'boolean';
    case 'TSArrayType':
      return 'array';
    case 'TSTypeLiteral':
      return 'object';
    default:
      return null;
  }
}

/**
 * Resolves a module specifier to an existing file path on disk.
 * Handles TypeScript extension mapping (.js -> .ts/.tsx) and barrel directory indexes.
 */
export function resolveModuleFile(baseDir, specifier) {
  if (!specifier || !specifier.startsWith('.')) {
    return null;
  }

  const directPath = path.resolve(baseDir, specifier);

  // 1. Exact file match
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  // 2. Map .js / .mjs / .cjs to TypeScript source equivalents (.ts / .tsx / .mts / .cts)
  const ext = path.extname(specifier);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const withoutExt = directPath.slice(0, -ext.length);
    for (const tsExt of ['.ts', '.tsx', '.mts', '.cts']) {
      const candidate = withoutExt + tsExt;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  // 3. Try appending extensions if none provided
  for (const candidateExt of ['.ts', '.tsx', '.js', '.mjs', '.jsx']) {
    const candidate = directPath + candidateExt;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  // 4. Directory index resolution (e.g. ./io -> ./io/index.ts)
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    for (const indexName of ['index.ts', 'index.tsx', 'index.js', 'index.mjs']) {
      const candidate = path.join(directPath, indexName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return null;
}

function analyzeModuleInternal(resolved, options = {}, visited = new Set()) {
  if (visited.has(resolved) || !fs.existsSync(resolved)) {
    return [];
  }
  visited.add(resolved);

  let code;
  try {
    code = fs.readFileSync(resolved, 'utf-8');
  } catch {
    return [];
  }

  let ast;
  try {
    const parsed = parseSource(resolved, code);
    ast = parsed.ast;
  } catch {
    return [];
  }

  if (!ast || !ast.body) {
    return [];
  }

  const locator = createSourceLocator(code);

  const exportMap = new Map(); // localName -> exportName
  let defaultExportName = null;
  const topLevelFunctions = new Map(); // name -> FunctionInfo
  const reExportedFunctions = []; // functions brought in via export ... from '...'

  const fileDir = path.dirname(resolved);
  const body = ast.body || [];

  for (const node of body) {
    // 1. ExportNamedDeclaration
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === 'FunctionDeclaration' && decl.id) {
          const fnName = decl.id.name;
          exportMap.set(fnName, fnName);
          topLevelFunctions.set(fnName, {
            node: decl,
            name: fnName,
            exportName: fnName,
            isClass: false
          });
        } else if (decl.type === 'ClassDeclaration' && decl.id) {
          const clsName = decl.id.name;
          exportMap.set(clsName, clsName);
          const ctor = (decl.body?.body || []).find(m => m.type === 'MethodDefinition' && m.kind === 'constructor');
          topLevelFunctions.set(clsName, {
            node: ctor ? ctor.value : decl,
            name: clsName,
            exportName: clsName,
            isClass: true
          });
        } else if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations || []) {
            if (d.id && d.id.name && d.init) {
              if (d.init.type === 'FunctionExpression' || d.init.type === 'ArrowFunctionExpression') {
                const fnName = d.id.name;
                exportMap.set(fnName, fnName);
                topLevelFunctions.set(fnName, {
                  node: d.init,
                  name: fnName,
                  exportName: fnName,
                  isClass: false
                });
              }
            }
          }
        }
      } else if (node.source && node.source.value) {
        // Re-export: export { a, b as c } from './foo.js'
        const subFile = resolveModuleFile(fileDir, node.source.value);
        if (subFile) {
          const subFns = analyzeModuleInternal(subFile, options, visited);
          for (const spec of node.specifiers || []) {
            if (spec.type === 'ExportSpecifier' && spec.local && spec.exported) {
              const localName = spec.local.name;
              const exportName = spec.exported.name;
              const match = subFns.find(f => f.exportName === localName || f.name === localName);
              if (match) {
                reExportedFunctions.push({
                  ...match,
                  exportName
                });
              }
            }
          }
        }
      } else if (node.specifiers) {
        // Local export: export { foo, bar as baz }
        for (const spec of node.specifiers) {
          if (spec.local && spec.exported) {
            exportMap.set(spec.local.name, spec.exported.name);
          }
        }
      }
    }

    // 2. ExportAllDeclaration: export * from './foo.js'
    else if (node.type === 'ExportAllDeclaration' && node.source && node.source.value) {
      const subFile = resolveModuleFile(fileDir, node.source.value);
      if (subFile) {
        const subFns = analyzeModuleInternal(subFile, options, visited);
        for (const f of subFns) {
          reExportedFunctions.push({ ...f });
        }
      }
    }

    // 3. ExportDefaultDeclaration
    else if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration) {
        const decl = node.declaration;
        if (
          decl.type === 'FunctionDeclaration' ||
          decl.type === 'FunctionExpression' ||
          decl.type === 'ArrowFunctionExpression'
        ) {
          const fnName = (decl.id && decl.id.name) ? decl.id.name : 'default';
          defaultExportName = 'default';
          topLevelFunctions.set(fnName, {
            node: decl,
            name: fnName,
            exportName: 'default',
            isClass: false
          });
        } else if (decl.type === 'ClassDeclaration') {
          const clsName = (decl.id && decl.id.name) ? decl.id.name : 'default';
          defaultExportName = 'default';
          const ctor = (decl.body?.body || []).find(m => m.type === 'MethodDefinition' && m.kind === 'constructor');
          topLevelFunctions.set(clsName, {
            node: ctor ? ctor.value : decl,
            name: clsName,
            exportName: 'default',
            isClass: true
          });
        } else if (decl.type === 'Identifier') {
          defaultExportName = decl.name;
        }
      }
    }

    // 4. Top-level function declarations
    else if (node.type === 'FunctionDeclaration' && node.id) {
      const fnName = node.id.name;
      if (!topLevelFunctions.has(fnName)) {
        topLevelFunctions.set(fnName, {
          node,
          name: fnName,
          exportName: exportMap.get(fnName) || null,
          isClass: false
        });
      }
    }

    // 5. Top-level class declarations
    else if (node.type === 'ClassDeclaration' && node.id) {
      const clsName = node.id.name;
      if (!topLevelFunctions.has(clsName)) {
        const ctor = (node.body?.body || []).find(m => m.type === 'MethodDefinition' && m.kind === 'constructor');
        topLevelFunctions.set(clsName, {
          node: ctor ? ctor.value : node,
          name: clsName,
          exportName: exportMap.get(clsName) || null,
          isClass: true
        });
      }
    }

    // 6. Top-level const fn = ...
    else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.id && decl.id.name && decl.init) {
          if (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression') {
            const fnName = decl.id.name;
            if (!topLevelFunctions.has(fnName)) {
              topLevelFunctions.set(fnName, {
                node: decl.init,
                name: fnName,
                exportName: exportMap.get(fnName) || null,
                isClass: false
              });
            }
          }
        }
      }
    }

    // 7. CommonJS exports: module.exports = ... or exports.foo = ...
    else if (node.type === 'ExpressionStatement' && node.expression) {
      const expr = node.expression;
      if (expr.type === 'AssignmentExpression') {
        const left = expr.left;
        if (left && left.type === 'MemberExpression') {
          if (left.object && left.object.name === 'exports' && left.property) {
            const prop = left.property.name || left.property.value;
            if (expr.right.type === 'FunctionExpression' || expr.right.type === 'ArrowFunctionExpression') {
              topLevelFunctions.set(prop, {
                node: expr.right,
                name: prop,
                exportName: prop,
                isClass: false
              });
            }
          } else if (
            left.object &&
            left.object.name === 'module' &&
            left.property &&
            left.property.name === 'exports'
          ) {
            if (expr.right.type === 'FunctionExpression' || expr.right.type === 'ArrowFunctionExpression') {
              topLevelFunctions.set('default', {
                node: expr.right,
                name: 'default',
                exportName: 'default',
                isClass: false
              });
            }
          }
        }
      }
    }
  }

  // Update exportNames for items exported via export { local as exported }
  for (const [localName, exportName] of exportMap.entries()) {
    if (topLevelFunctions.has(localName)) {
      topLevelFunctions.get(localName).exportName = exportName;
    }
  }

  // If default export referenced an existing function/class
  if (defaultExportName && topLevelFunctions.has(defaultExportName)) {
    const entry = topLevelFunctions.get(defaultExportName);
    entry.exportName = 'default';
  }

  const result = [];

  // Filter candidates: if options.all is true, take all functions; otherwise only exported
  let candidates = Array.from(topLevelFunctions.values());
  const exportedOnly = candidates.filter(c => Boolean(c.exportName));

  if (!options.all && exportedOnly.length > 0) {
    candidates = exportedOnly;
  }

  for (const item of candidates) {
    const fnNode = item.node;
    if (fnNode.generator) continue; // Skip generators

    const params = (fnNode.params || []).map(extractParamInfo);

    const startLoc = locator(fnNode.start);
    const endLoc = locator(fnNode.end);

    result.push({
      name: item.name,
      exportName: item.exportName || item.name,
      async: Boolean(fnNode.async),
      isClass: Boolean(item.isClass),
      params,
      line: startLoc.line,
      column: startLoc.column,
      endLine: endLoc.line,
      endColumn: endLoc.column
    });
  }

  // Merge re-exported functions (avoid duplicate exportNames)
  const existingExports = new Set(result.map(r => r.exportName));
  for (const reExport of reExportedFunctions) {
    if (!existingExports.has(reExport.exportName)) {
      existingExports.add(reExport.exportName);
      result.push(reExport);
    }
  }

  return result;
}

/**
 * Analyzes a JavaScript/TypeScript module and discovers candidate functions for auto-benchmarking.
 */
export function analyzeModule(filePath, options = {}) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target file not found: ${resolved}`);
  }

  const functions = analyzeModuleInternal(resolved, options, new Set());

  return {
    filePath: resolved,
    functions
  };
}
