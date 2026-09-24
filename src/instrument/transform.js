import MagicString from 'magic-string';
import { parseSource, createSourceLocator } from './parse.js';

export function transformSource(code, filename, relativePath, registry, options = {}) {
  const { strict = false, clientImport, captureSeeds = false } = options;

  let parseResult;
  try {
    parseResult = parseSource(filename, code);
  } catch (err) {
    if (strict) throw err;
    console.warn(`[softscope] Warning: Could not parse ${relativePath}: ${err.message}`);
    return { code, map: null, transformed: false, functions: [] };
  }

  if (!parseResult.ast || (parseResult.errors && parseResult.errors.length > 0)) {
    if (strict && parseResult.errors && parseResult.errors.length > 0) {
      throw new Error(`Parse errors in ${relativePath}: ${JSON.stringify(parseResult.errors)}`);
    }
    if (parseResult.errors && parseResult.errors.length > 0) {
      console.warn(`[softscope] Warning: Parse errors in ${relativePath}, skipping instrumentation.`);
    }
    return { code, map: null, transformed: false, functions: [] };
  }

  const locator = createSourceLocator(code);
  const functions = registry.discoverFunctions(parseResult.ast, relativePath, locator);

  if (functions.length === 0) {
    // No functions to instrument, but we still register the file as observed
    const clientStmt = clientImport ? `import __softscope from ${JSON.stringify(clientImport)};\n` : '';
    const registerStmt = `${clientStmt}globalThis.__softscope?.registerFile?.(${JSON.stringify(relativePath)}, []);\n`;
    const s = new MagicString(code);
    insertHeader(s, code, registerStmt);
    return {
      code: s.toString(),
      map: s.generateMap({ hires: true, source: relativePath, includeContent: true }),
      transformed: true,
      functions: []
    };
  }

  try {
    const s = new MagicString(code);

    // Sort functions: innermost / shortest first so nested concise arrow appends order correctly
    const sortedFunctions = [...functions].sort((a, b) => {
      const lenA = (a.node.end || 0) - (a.node.start || 0);
      const lenB = (b.node.end || 0) - (b.node.start || 0);
      return lenA - lenB;
    });

    for (const fn of sortedFunctions) {
      // Do not instrument unsafe constructs like generators
      if (fn.unsupported) {
        continue;
      }

      const node = fn.node;
      const id = fn.id;

      let argsExpr = '';
      if (captureSeeds) {
        if (node.type === 'ArrowFunctionExpression') {
          const paramNames = (node.params || [])
            .map(p => (p.type === 'Identifier' ? p.name : p.left && p.left.type === 'Identifier' ? p.left.name : null))
            .filter(Boolean);
          argsExpr = paramNames.length > 0 ? `, [${paramNames.join(', ')}]` : '';
        } else {
          argsExpr = `, typeof arguments !== 'undefined' ? arguments : null`;
        }
      }

      if (node.type === 'ArrowFunctionExpression' && node.expression) {
        // Concise arrow function: () => expr
        const bodyStart = node.body.start;
        const bodyEnd = node.body.end;

        s.prependLeft(bodyStart, `{ __softscope.enter(${id}${argsExpr}); try { return (`);
        s.appendRight(bodyEnd, `); } finally { __softscope.exit(${id}); } }`);
      } else if (node.body && node.body.type === 'BlockStatement') {
        // Standard block function
        let insertPos = node.body.start + 1;

        // If there's a directive prologue e.g. "use strict", insert after it
        if (node.body.body && node.body.body.length > 0) {
          for (const stmt of node.body.body) {
            if (
              stmt.type === 'ExpressionStatement' &&
              (stmt.directive ||
                (stmt.expression &&
                  stmt.expression.type === 'Literal' &&
                  typeof stmt.expression.value === 'string'))
            ) {
              insertPos = stmt.end;
            } else {
              break;
            }
          }
        }

        const isAfterDirective = insertPos > node.body.start + 1;
        const enterCode = isAfterDirective
          ? `\n__softscope.enter(${id}${argsExpr}); try {\n`
          : ` __softscope.enter(${id}${argsExpr}); try { `;
        const exitCode = ` } finally { __softscope.exit(${id}); } `;

        const exitPos = node.body.end - 1;
        if (insertPos >= exitPos) {
          s.appendRight(insertPos, `${enterCode}${exitCode}`);
        } else {
          s.appendRight(insertPos, enterCode);
          s.prependLeft(exitPos, exitCode);
        }
      }
    }

    // Register file metadata at module top
    const serializedFns = functions.map(f => ({
      id: f.id,
      file: f.file,
      name: f.name,
      line: f.line,
      column: f.column,
      type: f.type,
      async: f.async,
      generator: f.generator,
      unsupported: f.unsupported
    }));

    const clientStmt = clientImport ? `import __softscope from ${JSON.stringify(clientImport)};\n` : '';
    const registerStmt = `${clientStmt}globalThis.__softscope?.registerFile?.(${JSON.stringify(relativePath)}, ${JSON.stringify(serializedFns)});\n`;
    insertHeader(s, code, registerStmt);

    return {
      code: s.toString(),
      map: s.generateMap({ hires: true, source: relativePath, includeContent: true }),
      transformed: true,
      functions
    };
  } catch (err) {
    if (strict) throw err;
    console.warn(`[softscope] Warning: Instrumentation failed for ${relativePath}: ${err.message}`);
    return { code, map: null, transformed: false, functions: [] };
  }
}

function insertHeader(s, code, headerText) {
  let insertIndex = 0;

  // Preserve shebang on line 1
  if (code.startsWith('#!')) {
    const newlineIndex = code.indexOf('\n');
    if (newlineIndex !== -1) {
      insertIndex = newlineIndex + 1;
    }
  }

  s.appendRight(insertIndex, headerText);
}
