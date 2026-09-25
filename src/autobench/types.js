import fs from 'node:fs';
import path from 'node:path';
import { parseSource } from '../instrument/parse.js';

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

/**
 * Normalizes an AST type node into a structured TypeShape descriptor.
 */
export function resolveTsTypeNode(typeNode, typeRegistry = new Map(), resolving = new Set(), depth = 0) {
  if (!typeNode) return null;
  if (depth > 6) return { kind: 'primitive', primitive: 'any' };

  switch (typeNode.type) {
    case 'TSStringKeyword':
      return { kind: 'primitive', primitive: 'string' };
    case 'TSNumberKeyword':
      return { kind: 'primitive', primitive: 'number' };
    case 'TSBooleanKeyword':
      return { kind: 'primitive', primitive: 'boolean' };
    case 'TSBigIntKeyword':
      return { kind: 'primitive', primitive: 'bigint' };
    case 'TSAnyKeyword':
    case 'TSUnknownKeyword':
      return { kind: 'primitive', primitive: 'any' };
    case 'TSNullKeyword':
      return { kind: 'primitive', primitive: 'null' };
    case 'TSUndefinedKeyword':
    case 'TSVoidKeyword':
      return { kind: 'primitive', primitive: 'undefined' };

    case 'TSLiteralType': {
      const val = typeNode.literal ? typeNode.literal.value : undefined;
      return { kind: 'literal', value: val };
    }

    case 'TSArrayType': {
      const element = resolveTsTypeNode(typeNode.elementType, typeRegistry, resolving, depth + 1);
      return { kind: 'array', elementType: element || { kind: 'primitive', primitive: 'any' } };
    }

    case 'TSTupleType': {
      const firstElem = typeNode.elementTypes?.[0];
      const element = resolveTsTypeNode(firstElem, typeRegistry, resolving, depth + 1);
      return { kind: 'array', elementType: element || { kind: 'primitive', primitive: 'any' } };
    }

    case 'TSUnionType': {
      const types = (typeNode.types || [])
        .map(t => resolveTsTypeNode(t, typeRegistry, resolving, depth + 1))
        .filter(Boolean);
      const literalValues = [];
      let allLiterals = types.length > 0;
      for (const t of types) {
        if (t.kind === 'literal') {
          literalValues.push(t.value);
        } else {
          allLiterals = false;
        }
      }
      return {
        kind: 'union',
        types,
        values: literalValues,
        isLiteralUnion: allLiterals
      };
    }

    case 'TSIntersectionType': {
      const types = (typeNode.types || [])
        .map(t => resolveTsTypeNode(t, typeRegistry, resolving, depth + 1))
        .filter(Boolean);
      const mergedProperties = [];
      for (const t of types) {
        if (t.kind === 'object' && Array.isArray(t.properties)) {
          mergedProperties.push(...t.properties);
        }
      }
      return {
        kind: 'object',
        properties: mergedProperties
      };
    }

    case 'TSTypeLiteral': {
      const properties = [];
      for (const member of typeNode.members || []) {
        if (member.type === 'TSPropertySignature' && member.key) {
          const propName = member.key.name || member.key.value;
          if (propName) {
            const propTypeNode = member.typeAnnotation?.typeAnnotation;
            const propType = resolveTsTypeNode(propTypeNode, typeRegistry, resolving, depth + 1);
            properties.push({
              name: String(propName),
              optional: Boolean(member.optional),
              type: propType || { kind: 'primitive', primitive: 'any' }
            });
          }
        }
      }
      return {
        kind: 'object',
        properties
      };
    }

    case 'TSTypeReference': {
      const refName = typeNode.typeName?.name;
      if (!refName) return { kind: 'reference', name: 'unknown' };

      // Built-in utility types
      if (refName === 'Array' && typeNode.typeArguments?.params?.length > 0) {
        const elem = resolveTsTypeNode(typeNode.typeArguments.params[0], typeRegistry, resolving, depth + 1);
        return { kind: 'array', elementType: elem || { kind: 'primitive', primitive: 'any' } };
      }
      if (refName === 'Record' && typeNode.typeArguments?.params?.length > 1) {
        const valType = resolveTsTypeNode(typeNode.typeArguments.params[1], typeRegistry, resolving, depth + 1);
        return {
          kind: 'object',
          isRecord: true,
          valueType: valType || { kind: 'primitive', primitive: 'any' },
          properties: []
        };
      }
      if (refName === 'Partial' && typeNode.typeArguments?.params?.length > 0) {
        const inner = resolveTsTypeNode(typeNode.typeArguments.params[0], typeRegistry, resolving, depth + 1);
        if (inner && inner.kind === 'object') {
          return {
            ...inner,
            properties: (inner.properties || []).map(p => ({ ...p, optional: true }))
          };
        }
      }
      if (refName === 'Readonly' && typeNode.typeArguments?.params?.length > 0) {
        return resolveTsTypeNode(typeNode.typeArguments.params[0], typeRegistry, resolving, depth + 1);
      }
      if (refName === 'Promise' && typeNode.typeArguments?.params?.length > 0) {
        return resolveTsTypeNode(typeNode.typeArguments.params[0], typeRegistry, resolving, depth + 1);
      }

      // Check registered shapes
      if (typeRegistry && typeRegistry.has(refName)) {
        const resolvedTarget = typeRegistry.get(refName);
        if (resolvedTarget) {
          return {
            name: refName,
            ...resolvedTarget
          };
        }
      }

      return { kind: 'reference', name: refName };
    }

    case 'TSFunctionType':
      return { kind: 'function' };

    default:
      return { kind: 'primitive', primitive: 'any' };
  }
}

/**
 * Traverses an AST to collect interface, type alias, and enum definitions.
 * Recursively resolves relative imported types.
 */
export function collectTypeDefinitions(ast, currentFilePath, typeRegistry = new Map(), visitedFiles = new Set()) {
  if (!ast || !ast.body || visitedFiles.has(currentFilePath)) {
    return typeRegistry;
  }
  visitedFiles.add(currentFilePath);

  const fileDir = path.dirname(currentFilePath);
  const rawDeclarations = new Map();
  const importMap = new Map();

  for (const stmt of ast.body) {
    // 1. ImportDeclaration
    if (stmt.type === 'ImportDeclaration') {
      const sourceVal = stmt.source?.value;
      if (sourceVal && sourceVal.startsWith('.')) {
        for (const spec of stmt.specifiers || []) {
          if (spec.local && spec.local.name) {
            importMap.set(spec.local.name, {
              source: sourceVal,
              importedName: spec.imported ? spec.imported.name : spec.local.name
            });
          }
        }
      }
    }

    // 2. ExportNamedDeclaration with interface/type/enum
    else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      const decl = stmt.declaration;
      if (decl.type === 'TSInterfaceDeclaration' && decl.id?.name) {
        rawDeclarations.set(decl.id.name, { kind: 'interface', node: decl });
      } else if (decl.type === 'TSTypeAliasDeclaration' && decl.id?.name) {
        rawDeclarations.set(decl.id.name, { kind: 'alias', node: decl });
      } else if (decl.type === 'TSEnumDeclaration' && decl.id?.name) {
        rawDeclarations.set(decl.id.name, { kind: 'enum', node: decl });
      }
    }

    // 3. Top-level interface declaration
    else if (stmt.type === 'TSInterfaceDeclaration' && stmt.id?.name) {
      rawDeclarations.set(stmt.id.name, { kind: 'interface', node: stmt });
    }

    // 4. Top-level type alias declaration
    else if (stmt.type === 'TSTypeAliasDeclaration' && stmt.id?.name) {
      rawDeclarations.set(stmt.id.name, { kind: 'alias', node: stmt });
    }

    // 5. Top-level enum declaration
    else if (stmt.type === 'TSEnumDeclaration' && stmt.id?.name) {
      rawDeclarations.set(stmt.id.name, { kind: 'enum', node: stmt });
    }
  }

  function resolveDecl(name, resolving = new Set()) {
    if (typeRegistry.has(name)) {
      return typeRegistry.get(name);
    }
    if (resolving.has(name)) {
      return { kind: 'reference', name };
    }

    const decl = rawDeclarations.get(name);
    if (!decl) {
      // Check if imported from another local file
      const importInfo = importMap.get(name);
      if (importInfo) {
        const targetPath = resolveModuleFile(fileDir, importInfo.source);
        if (targetPath && !visitedFiles.has(targetPath)) {
          try {
            const targetCode = fs.readFileSync(targetPath, 'utf-8');
            const targetParsed = parseSource(targetPath, targetCode);
            collectTypeDefinitions(targetParsed.ast, targetPath, typeRegistry, visitedFiles);
            return typeRegistry.get(importInfo.importedName) || { kind: 'reference', name };
          } catch {
            return { kind: 'reference', name };
          }
        }
      }
      return { kind: 'reference', name };
    }

    resolving.add(name);

    if (decl.kind === 'enum') {
      const values = [];
      let autoVal = 0;
      for (const m of decl.node.body?.members || []) {
        if (m.initializer && m.initializer.type === 'Literal') {
          values.push(m.initializer.value);
          if (typeof m.initializer.value === 'number') {
            autoVal = m.initializer.value + 1;
          }
        } else {
          values.push(autoVal++);
        }
      }
      const shape = {
        kind: 'union',
        name,
        values,
        isLiteralUnion: true
      };
      typeRegistry.set(name, shape);
      resolving.delete(name);
      return shape;
    }

    if (decl.kind === 'alias') {
      const resolvedShape = resolveTsTypeNode(decl.node.typeAnnotation, typeRegistry, resolving, 0);
      const shape = resolvedShape ? { name, ...resolvedShape } : { kind: 'primitive', primitive: 'any', name };
      typeRegistry.set(name, shape);
      resolving.delete(name);
      return shape;
    }

    if (decl.kind === 'interface') {
      const properties = [];
      // Handle interface inheritance (extends A, B)
      if (decl.node.extends && Array.isArray(decl.node.extends)) {
        for (const heritage of decl.node.extends) {
          const parentName = heritage.expression?.name;
          if (parentName) {
            const parentShape = resolveDecl(parentName, resolving);
            if (parentShape && parentShape.kind === 'object' && Array.isArray(parentShape.properties)) {
              properties.push(...parentShape.properties);
            }
          }
        }
      }

      // Add interface own members
      const interfaceMembers = decl.node.body?.body || decl.node.body?.members || [];
      for (const member of interfaceMembers) {
        if (member.type === 'TSPropertySignature' && member.key) {
          const propName = member.key.name || member.key.value;
          if (propName) {
            const propType = resolveTsTypeNode(member.typeAnnotation?.typeAnnotation, typeRegistry, resolving, 0);
            properties.push({
              name: String(propName),
              optional: Boolean(member.optional),
              type: propType || { kind: 'primitive', primitive: 'any' }
            });
          }
        }
      }

      const shape = {
        kind: 'object',
        name,
        properties
      };
      typeRegistry.set(name, shape);
      resolving.delete(name);
      return shape;
    }

    resolving.delete(name);
    return { kind: 'reference', name };
  }

  // Eagerly resolve all local declarations in file
  for (const name of rawDeclarations.keys()) {
    resolveDecl(name);
  }

  // Eagerly resolve relative imported types
  for (const name of importMap.keys()) {
    const res = resolveDecl(name);
    if (res && res.kind !== 'reference') {
      typeRegistry.set(name, res);
    }
  }

  return typeRegistry;
}
