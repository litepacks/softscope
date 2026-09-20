function resolveCalleeName(callee) {
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    const obj = resolveCalleeName(callee.object);
    const prop = callee.property
      ? (callee.property.name || (callee.property.value ? String(callee.property.value) : ''))
      : '';
    return obj ? (prop ? `${obj}.${prop}` : obj) : prop;
  }
  return '';
}

function resolvePropertyName(propNode) {
  if (!propNode) return '';
  if (propNode.type === 'Identifier') return propNode.name;
  if (propNode.type === 'Literal') return String(propNode.value);
  if (propNode.type === 'PrivateIdentifier') return `#${propNode.name}`;
  return '';
}

export function createFunctionRegistry() {
  let nextId = 1;
  const functionMap = new Map(); // id -> FunctionInfo
  const fileFunctions = new Map(); // filePath -> FunctionInfo[]

  function allocateId() {
    return nextId++;
  }

  function getFunction(id) {
    return functionMap.get(id);
  }

  function getAllFunctions() {
    return Array.from(functionMap.values());
  }

  function getFunctionsForFile(filePath) {
    return fileFunctions.get(filePath) || [];
  }

  function discoverFunctions(ast, filePath, locator) {
    if (!ast) return [];

    const discovered = [];
    const astStack = [];

    function walk(node, parent) {
      if (!node || typeof node !== 'object') return;

      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression';

      if (isFn) {
        let name = '';

        if (node.id && node.id.name) {
          name = node.id.name;
        } else if (parent) {
          if (parent.type === 'MethodDefinition') {
            // Find enclosing class name
            const cls = astStack.find(
              n => n.type === 'ClassDeclaration' || n.type === 'ClassExpression'
            );
            const clsName = (cls && cls.id && cls.id.name) ? cls.id.name : 'Class';
            const propName = resolvePropertyName(parent.key);

            if (parent.kind === 'constructor') {
              name = `${clsName}.constructor`;
            } else if (parent.kind === 'get') {
              name = `get ${clsName}.${propName}`;
            } else if (parent.kind === 'set') {
              name = `set ${clsName}.${propName}`;
            } else {
              name = `${clsName}.${propName}`;
            }
          } else if (parent.type === 'Property') {
            const propName = resolvePropertyName(parent.key);
            if (parent.kind === 'get') {
              name = `get ${propName}`;
            } else if (parent.kind === 'set') {
              name = `set ${propName}`;
            } else {
              name = propName;
            }
          } else if (parent.type === 'VariableDeclarator' && parent.id && parent.id.name) {
            name = parent.id.name;
          } else if (parent.type === 'AssignmentExpression') {
            const left = resolveCalleeName(parent.left);
            if (left === 'module.exports') {
              name = 'module.exports handler';
            } else {
              name = left || 'anonymous';
            }
          } else if (parent.type === 'CallExpression') {
            const callee = resolveCalleeName(parent.callee);
            name = callee ? `${callee} callback` : 'callback';
          }
        }

        const loc = locator ? locator(node.start) : { line: 1, column: 1 };
        if (!name) {
          name = `anonymous@${loc.line}:${loc.column}`;
        }

        const id = allocateId();
        const fnInfo = {
          id,
          file: filePath,
          name,
          line: loc.line,
          column: loc.column,
          type: node.type,
          async: Boolean(node.async),
          generator: Boolean(node.generator),
          node,
          body: node.body,
          unsupported: node.generator ? 'generator' : null
        };

        discovered.push(fnInfo);
        functionMap.set(id, fnInfo);
      }

      astStack.push(node);

      for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) walk(c, node);
        } else if (child && typeof child === 'object' && child.type) {
          walk(child, node);
        }
      }

      astStack.pop();
    }

    walk(ast, null);
    fileFunctions.set(filePath, discovered);
    return discovered;
  }

  return {
    allocateId,
    getFunction,
    getAllFunctions,
    getFunctionsForFile,
    discoverFunctions
  };
}
