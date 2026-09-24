import fs from 'node:fs';
import path from 'node:path';
import { parseSource } from '../instrument/parse.js';

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
 * Analyzes a JavaScript/TypeScript module and discovers candidate functions for auto-benchmarking.
 */
export function analyzeModule(filePath, options = {}) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target file not found: ${resolved}`);
  }

  const code = fs.readFileSync(resolved, 'utf-8');
  const { ast, errors } = parseSource(resolved, code);

  if (!ast || (errors && errors.length > 0)) {
    throw new Error(`Failed to parse ${resolved}: ${errors ? errors[0]?.message : 'Unknown AST error'}`);
  }

  const exportMap = new Map(); // localName -> exportName
  let defaultExportName = null;
  const topLevelFunctions = new Map(); // name -> FunctionInfo

  const body = ast.body || [];

  for (const node of body) {
    // 1. ExportNamedDeclaration
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
          const fnName = node.declaration.id.name;
          exportMap.set(fnName, fnName);
          topLevelFunctions.set(fnName, {
            node: node.declaration,
            name: fnName,
            exportName: fnName
          });
        } else if (node.declaration.type === 'VariableDeclaration') {
          for (const decl of node.declaration.declarations || []) {
            if (decl.id && decl.id.name && decl.init) {
              if (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression') {
                const fnName = decl.id.name;
                exportMap.set(fnName, fnName);
                topLevelFunctions.set(fnName, {
                  node: decl.init,
                  name: fnName,
                  exportName: fnName
                });
              }
            }
          }
        }
      } else if (node.specifiers) {
        for (const spec of node.specifiers) {
          if (spec.local && spec.exported) {
            exportMap.set(spec.local.name, spec.exported.name);
          }
        }
      }
    }

    // 2. ExportDefaultDeclaration
    else if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration) {
        if (
          node.declaration.type === 'FunctionDeclaration' ||
          node.declaration.type === 'FunctionExpression' ||
          node.declaration.type === 'ArrowFunctionExpression'
        ) {
          const fnName = (node.declaration.id && node.declaration.id.name) ? node.declaration.id.name : 'default';
          defaultExportName = 'default';
          topLevelFunctions.set(fnName, {
            node: node.declaration,
            name: fnName,
            exportName: 'default'
          });
        } else if (node.declaration.type === 'Identifier') {
          defaultExportName = node.declaration.name;
        }
      }
    }

    // 3. Top-level function declarations
    else if (node.type === 'FunctionDeclaration' && node.id) {
      const fnName = node.id.name;
      if (!topLevelFunctions.has(fnName)) {
        topLevelFunctions.set(fnName, {
          node,
          name: fnName,
          exportName: exportMap.get(fnName) || null
        });
      }
    }

    // 4. Top-level const fn = ...
    else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.id && decl.id.name && decl.init) {
          if (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression') {
            const fnName = decl.id.name;
            if (!topLevelFunctions.has(fnName)) {
              topLevelFunctions.set(fnName, {
                node: decl.init,
                name: fnName,
                exportName: exportMap.get(fnName) || null
              });
            }
          }
        }
      }
    }

    // 5. CommonJS exports: module.exports = ... or exports.foo = ...
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
                exportName: prop
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
                exportName: 'default'
              });
            }
          }
        }
      }
    }
  }

  // If default export referenced an existing function
  if (defaultExportName && topLevelFunctions.has(defaultExportName)) {
    const entry = topLevelFunctions.get(defaultExportName);
    entry.exportName = 'default';
  }

  // Filter candidates: if options.all is true, take all top-level functions;
  // otherwise, only take exported functions. If none are explicitly exported, take all top-level functions.
  let candidates = Array.from(topLevelFunctions.values());
  const exportedOnly = candidates.filter(c => Boolean(c.exportName));

  if (!options.all && exportedOnly.length > 0) {
    candidates = exportedOnly;
  }

  const result = [];
  for (const item of candidates) {
    const fnNode = item.node;
    if (fnNode.generator) continue; // Skip generators

    const params = (fnNode.params || []).map(extractParamInfo);

    result.push({
      name: item.name,
      exportName: item.exportName || item.name,
      async: Boolean(fnNode.async),
      params,
      line: fnNode.loc ? fnNode.loc.start.line : 1
    });
  }

  return {
    filePath: resolved,
    functions: result
  };
}
