import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads a seeds JSON file captured during a previous test or run.
 */
export function loadSeedsFile(filePath) {
  if (!filePath) return new Map();
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return new Map();
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const data = JSON.parse(raw);
    const seedsList = Array.isArray(data) ? data : data.seeds || [];
    const map = new Map();

    for (const item of seedsList) {
      if (item && item.name && Array.isArray(item.calls) && item.calls.length > 0) {
        // Map by name and by "file:name"
        map.set(item.name, item.calls);
        if (item.file) {
          map.set(`${item.file}:${item.name}`, item.calls);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Synthesizes a realistic concrete value matching a structured TypeShape descriptor.
 */
export function inferShapeValue(shape, depth = 0) {
  if (!shape || depth > 5) return {};

  switch (shape.kind) {
    case 'primitive': {
      switch (shape.primitive) {
        case 'number': return 10;
        case 'string': return 'benchmark';
        case 'boolean': return true;
        case 'bigint': return 10n;
        case 'null': return null;
        case 'undefined': return undefined;
        default: return 'benchmark';
      }
    }

    case 'literal': {
      return shape.value;
    }

    case 'union': {
      if (shape.values && shape.values.length > 0) {
        return shape.values[0];
      }
      if (shape.types && shape.types.length > 0) {
        return inferShapeValue(shape.types[0], depth + 1);
      }
      return 'benchmark';
    }

    case 'array': {
      const elem = inferShapeValue(shape.elementType, depth + 1);
      return [elem];
    }

    case 'function': {
      return () => {};
    }

    case 'object': {
      if (shape.isRecord) {
        const val = inferShapeValue(shape.valueType, depth + 1);
        return { key1: val, key2: val };
      }
      const obj = {};
      for (const prop of shape.properties || []) {
        obj[prop.name] = inferShapeValue(prop.type, depth + 1);
      }
      return obj;
    }

    default:
      return {};
  }
}

/**
 * Infers a single baseline value from parameter metadata.
 */
export function inferParamValue(param) {
  if (param.hasDefault && param.defaultValue !== undefined) {
    return param.defaultValue;
  }

  if (param.tsType) {
    if (typeof param.tsType === 'string') {
      switch (param.tsType) {
        case 'number':
          return 10;
        case 'string':
          return 'benchmark';
        case 'boolean':
          return true;
        case 'array':
          return [1, 2, 3];
        case 'object':
          return { id: 1, name: 'test' };
      }
    } else if (typeof param.tsType === 'object') {
      const synthesized = inferShapeValue(param.tsType);
      if (synthesized !== undefined) {
        return synthesized;
      }
    }
  }

  const name = (param.name || '').toLowerCase();
  if (/num|count|idx|index|len|size|max|min|limit|offset|a|b|x|y|amount|sum|val/i.test(name)) {
    return 10;
  }
  if (/str|text|name|key|word|query|msg|message|title|sql/i.test(name)) {
    return 'benchmark';
  }
  if (/arr|list|items|elements|data|rows/i.test(name)) {
    return [1, 2, 3];
  }
  if (/obj|options|opts|config|settings|props|ctx/i.test(name)) {
    return {};
  }
  if (/is|has|flag|enabled/i.test(name)) {
    return true;
  }
  if (/fn|cb|callback|handler|listener|done|next|^on[a-z0-9_]/i.test(name)) {
    return () => {};
  }

  return 10; // Default primitive
}

/**
 * Produces perturbed edge-case values for a single argument.
 */
export function generateMutations(val) {
  if (typeof val === 'number') {
    return [
      { label: 'zero (0)', val: 0 },
      { label: 'negative (-1)', val: -1 },
      { label: 'MAX_SAFE_INTEGER', val: Number.MAX_SAFE_INTEGER },
      { label: 'NaN', val: NaN },
      { label: 'Infinity', val: Infinity },
      { label: 'large number (1M)', val: 1000000 }
    ];
  }

  if (typeof val === 'string') {
    return [
      { label: 'empty string ("")', val: '' },
      { label: 'whitespace ("   ")', val: '   ' },
      { label: 'long string (10k chars)', val: 'a'.repeat(10000) },
      { label: 'unicode surrogate emoji ("🚀✨")', val: '🚀✨🎉' },
      { label: 'string "null"', val: 'null' },
      { label: 'string "undefined"', val: 'undefined' }
    ];
  }

  if (Array.isArray(val)) {
    const sample = val.length > 0 ? val[0] : 1;
    return [
      { label: 'empty array ([])', val: [] },
      { label: 'single element ([item])', val: [sample] },
      { label: 'large array (1000 items)', val: Array(1000).fill(sample) },
      { label: 'null as array', val: null },
      { label: 'undefined as array', val: undefined }
    ];
  }

  if (typeof val === 'boolean') {
    return [
      { label: 'inverted boolean', val: !val },
      { label: 'null as boolean', val: null },
      { label: 'undefined as boolean', val: undefined }
    ];
  }

  if (val && typeof val === 'object') {
    return [
      { label: 'empty object ({})', val: {} },
      { label: 'null object', val: null },
      { label: 'undefined object', val: undefined }
    ];
  }

  return [
    { label: 'null', val: null },
    { label: 'undefined', val: undefined }
  ];
}

/**
 * Generates perturbations for an object based on its TypeShape properties.
 */
export function generateShapeMutations(baseVal, shape) {
  const mutations = [];

  // Base mutations for any object
  mutations.push({ label: 'empty object ({})', val: {} });
  mutations.push({ label: 'null object', val: null });
  mutations.push({ label: 'undefined object', val: undefined });

  if (!shape.properties || shape.properties.length === 0) {
    return mutations;
  }

  for (const prop of shape.properties) {
    const propName = prop.name;
    const propType = prop.type;

    // 1. Omit property
    if (baseVal && typeof baseVal === 'object' && propName in baseVal) {
      const omitted = { ...baseVal };
      delete omitted[propName];
      mutations.push({
        label: `omitted ${propName}`,
        val: omitted
      });
    }

    // 2. If property is a union (e.g. dialect: 'postgres' | 'mysql' | 'sqlite')
    if (propType && propType.kind === 'union' && propType.values && propType.values.length > 0) {
      for (const alt of propType.values) {
        if (!baseVal || baseVal[propName] !== alt) {
          mutations.push({
            label: `variant ${propName}='${alt}'`,
            val: { ...(baseVal || {}), [propName]: alt }
          });
        }
      }
      mutations.push({
        label: `invalid ${propName}='__invalid__'`,
        val: { ...(baseVal || {}), [propName]: '__invalid__' }
      });
    }

    // 3. If property is boolean
    if (propType && propType.kind === 'primitive' && propType.primitive === 'boolean') {
      const current = baseVal ? Boolean(baseVal[propName]) : true;
      mutations.push({
        label: `toggle ${propName}=${!current}`,
        val: { ...(baseVal || {}), [propName]: !current }
      });
    }

    // 4. If property is number
    if (propType && propType.kind === 'primitive' && propType.primitive === 'number') {
      mutations.push({
        label: `boundary ${propName}=0`,
        val: { ...(baseVal || {}), [propName]: 0 }
      });
      mutations.push({
        label: `boundary ${propName}=-1`,
        val: { ...(baseVal || {}), [propName]: -1 }
      });
    }

    // 5. If property is array
    if (propType && propType.kind === 'array') {
      mutations.push({
        label: `empty array ${propName}=[]`,
        val: { ...(baseVal || {}), [propName]: [] }
      });
    }

    // 6. If property is string (and not union)
    if (propType && propType.kind === 'primitive' && propType.primitive === 'string') {
      mutations.push({
        label: `empty string ${propName}=""`,
        val: { ...(baseVal || {}), [propName]: '' }
      });
    }
  }

  return mutations;
}

export function generateUnionMutations(baseVal, shape) {
  const mutations = [];
  if (shape.values && shape.values.length > 0) {
    for (const alt of shape.values) {
      if (alt !== baseVal) {
        mutations.push({ label: `union variant '${alt}'`, val: alt });
      }
    }
    mutations.push({ label: 'invalid union member', val: '__invalid_variant__' });
  } else if (shape.types && shape.types.length > 0) {
    for (const t of shape.types) {
      const val = inferShapeValue(t);
      if (val !== baseVal) {
        mutations.push({ label: 'union type variant', val });
      }
    }
  }
  mutations.push({ label: 'null', val: null });
  mutations.push({ label: 'undefined', val: undefined });
  return mutations;
}

export function generateArrayMutations(baseVal, shape) {
  const elem = inferShapeValue(shape.elementType);
  return [
    { label: 'empty array ([])', val: [] },
    { label: 'single element ([item])', val: [elem] },
    { label: 'multiple elements ([...])', val: [elem, elem, elem] },
    { label: 'null as array', val: null },
    { label: 'undefined as array', val: undefined }
  ];
}

export function generateParamMutations(baseVal, param) {
  if (param && param.tsType && typeof param.tsType === 'object') {
    const shape = param.tsType;
    if (shape.kind === 'object') {
      return generateShapeMutations(baseVal, shape);
    }
    if (shape.kind === 'union') {
      return generateUnionMutations(baseVal, shape);
    }
    if (shape.kind === 'array') {
      return generateArrayMutations(baseVal, shape);
    }
  }

  return generateMutations(baseVal);
}

/**
 * Resolves baseline seeds and generates edge-case mutations for a candidate function.
 */
export function synthesizeSeeds(fnInfo, seedsMap = new Map(), options = {}) {
  const { fuzz = true } = options;

  let baselineSeed = null;

  // 1. Check captured seeds map
  const captured = seedsMap.get(fnInfo.name) || seedsMap.get(`${fnInfo.file}:${fnInfo.name}`);
  if (captured && captured.length > 0) {
    baselineSeed = captured[0];
  }

  // 2. Synthesize baseline from AST parameters if not captured
  const params = fnInfo.params || [];
  if (!baselineSeed) {
    baselineSeed = params.map(inferParamValue);
  }

  // 3. Generate edge-case / perturbed seeds
  const fuzzSeeds = [];
  if (fuzz && baselineSeed.length > 0) {
    for (let argIdx = 0; argIdx < baselineSeed.length; argIdx++) {
      const originalVal = baselineSeed[argIdx];
      const param = fnInfo.params ? fnInfo.params[argIdx] : null;
      const mutations = generateParamMutations(originalVal, param);

      for (const mut of mutations) {
        const mutatedArgs = [...baselineSeed];
        mutatedArgs[argIdx] = mut.val;
        fuzzSeeds.push({
          label: `arg[${argIdx}] ${mut.label}`,
          args: mutatedArgs
        });
      }
    }
  }

  return {
    baselineSeed,
    fuzzSeeds
  };
}
