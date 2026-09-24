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
 * Infers a single baseline value from parameter metadata.
 */
function inferParamValue(param) {
  if (param.hasDefault && param.defaultValue !== undefined) {
    return param.defaultValue;
  }

  if (param.tsType) {
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
  }

  const name = (param.name || '').toLowerCase();
  if (/num|count|idx|index|len|size|max|min|limit|offset|a|b|x|y|amount|sum|val/i.test(name)) {
    return 10;
  }
  if (/str|text|name|key|word|query|msg|message|title/i.test(name)) {
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
  if (/fn|cb|callback|handler/i.test(name)) {
    return () => {};
  }

  return 10; // Default primitive
}

/**
 * Produces perturbed edge-case values for a single argument.
 */
function generateMutations(val) {
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
  if (!baselineSeed) {
    const params = fnInfo.params || [];
    baselineSeed = params.map(inferParamValue);
  }

  // 3. Generate edge-case / perturbed seeds
  const fuzzSeeds = [];
  if (fuzz && baselineSeed.length > 0) {
    for (let argIdx = 0; argIdx < baselineSeed.length; argIdx++) {
      const originalVal = baselineSeed[argIdx];
      const mutations = generateMutations(originalVal);

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
