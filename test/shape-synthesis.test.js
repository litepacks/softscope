import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSource } from '../src/instrument/parse.js';
import { collectTypeDefinitions, resolveTsTypeNode } from '../src/autobench/types.js';
import { analyzeModule } from '../src/autobench/analyze.js';
import {
  inferShapeValue,
  inferParamValue,
  generateShapeMutations,
  generateUnionMutations,
  generateArrayMutations,
  synthesizeSeeds
} from '../src/autobench/seeds.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOFTSCOPE_BIN = path.resolve(__dirname, '..', 'bin', 'softscope.js');

function runCli(args, opts = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.SOFTSCOPE_SESSION_DIR;
  delete cleanEnv.SOFTSCOPE_CONFIG;
  delete cleanEnv.SOFTSCOPE_IPC_SOCKET;
  delete cleanEnv.SOFTSCOPE_LIVE;
  delete cleanEnv.SOFTSCOPE_CAPTURE_SEEDS;

  return execFileAsync(process.execPath, [SOFTSCOPE_BIN, ...args], {
    env: cleanEnv,
    ...opts
  });
}

test('Shape Types: collectTypeDefinitions accurately extracts interfaces, extends, aliases, and enums', () => {
  const code = `
    export interface BaseConfig {
      id: number;
    }
    export interface ParserOptions extends BaseConfig {
      dialect?: 'postgres' | 'mysql' | 'sqlite';
      strict?: boolean;
      maxDepth?: number;
      tables?: string[];
      nested?: { debug?: boolean };
    }
    export type QueryConfig = {
      timeout: number;
      retries?: number;
    };
    export type Direction = 'asc' | 'desc';
    export enum LogLevel {
      Debug = 'debug',
      Info = 'info',
      Error = 500
    }
  `;

  const parsed = parseSource('test.ts', code);
  const reg = collectTypeDefinitions(parsed.ast, 'test.ts');

  assert.ok(reg.has('BaseConfig'));
  assert.ok(reg.has('ParserOptions'));
  assert.ok(reg.has('QueryConfig'));
  assert.ok(reg.has('Direction'));
  assert.ok(reg.has('LogLevel'));

  // ParserOptions inherits id: number from BaseConfig
  const parserOptions = reg.get('ParserOptions');
  assert.equal(parserOptions.kind, 'object');
  assert.equal(parserOptions.properties[0].name, 'id');
  assert.equal(parserOptions.properties[0].type.primitive, 'number');

  // dialect property is a union with literal values
  const dialectProp = parserOptions.properties.find(p => p.name === 'dialect');
  assert.ok(dialectProp);
  assert.equal(dialectProp.type.kind, 'union');
  assert.deepEqual(dialectProp.type.values, ['postgres', 'mysql', 'sqlite']);

  // LogLevel enum has literal values
  const logLevel = reg.get('LogLevel');
  assert.equal(logLevel.kind, 'union');
  assert.deepEqual(logLevel.values, ['debug', 'info', 500]);
});

test('Shape Types: resolves cross-file relative imported types seamlessly', () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-shape-cross-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const typesFile = path.join(tmpDir, 'types.ts');
  const mainFile = path.join(tmpDir, 'index.ts');

  fs.writeFileSync(
    typesFile,
    `
    export interface EngineOptions {
      mode: 'jit' | 'aot';
      workers?: number;
    }
  `
  );

  fs.writeFileSync(
    mainFile,
    `
    import { EngineOptions } from './types.ts';
    export function runEngine(code: string, opts?: EngineOptions) {
      return code.length;
    }
  `
  );

  try {
    const analysis = analyzeModule(mainFile);
    assert.equal(analysis.functions.length, 1);
    const fn = analysis.functions[0];
    assert.equal(fn.name, 'runEngine');
    assert.equal(fn.params.length, 2);

    const optsParam = fn.params[1];
    assert.equal(optsParam.tsType.kind, 'object');
    assert.equal(optsParam.tsType.name, 'EngineOptions');
    assert.equal(optsParam.tsType.properties[0].name, 'mode');
    assert.deepEqual(optsParam.tsType.properties[0].type.values, ['jit', 'aot']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Shape Seeds: inferShapeValue synthesizes rich realistic object graphs', () => {
  const shape = {
    kind: 'object',
    name: 'ParserOptions',
    properties: [
      { name: 'dialect', type: { kind: 'union', values: ['postgres', 'mysql', 'sqlite'] } },
      { name: 'strict', type: { kind: 'primitive', primitive: 'boolean' } },
      { name: 'maxTokens', type: { kind: 'primitive', primitive: 'number' } },
      { name: 'tags', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } } },
      {
        name: 'meta',
        type: {
          kind: 'object',
          properties: [
            { name: 'author', type: { kind: 'primitive', primitive: 'string' } }
          ]
        }
      }
    ]
  };

  const synthesized = inferShapeValue(shape);
  assert.deepEqual(synthesized, {
    dialect: 'postgres',
    strict: true,
    maxTokens: 10,
    tags: ['benchmark'],
    meta: {
      author: 'benchmark'
    }
  });
});

test('Shape Seeds: generateShapeMutations produces omit, union variant, boolean toggle, and boundary mutations', () => {
  const shape = {
    kind: 'object',
    properties: [
      { name: 'dialect', type: { kind: 'union', values: ['postgres', 'mysql', 'sqlite'] } },
      { name: 'strict', type: { kind: 'primitive', primitive: 'boolean' } },
      { name: 'limit', type: { kind: 'primitive', primitive: 'number' } }
    ]
  };

  const baseVal = { dialect: 'postgres', strict: true, limit: 10 };
  const mutations = generateShapeMutations(baseVal, shape);

  // Check base object mutations
  assert.ok(mutations.some(m => m.label === 'empty object ({})'));
  assert.ok(mutations.some(m => m.label === 'null object'));
  assert.ok(mutations.some(m => m.label === 'undefined object'));

  // Check omit mutations
  const omittedDialect = mutations.find(m => m.label === 'omitted dialect');
  assert.ok(omittedDialect);
  assert.deepEqual(omittedDialect.val, { strict: true, limit: 10 });

  // Check union alternate variants
  const mysqlVariant = mutations.find(m => m.label === "variant dialect='mysql'");
  assert.ok(mysqlVariant);
  assert.equal(mysqlVariant.val.dialect, 'mysql');

  const invalidUnion = mutations.find(m => m.label === "invalid dialect='__invalid__'");
  assert.ok(invalidUnion);
  assert.equal(invalidUnion.val.dialect, '__invalid__');

  // Check boolean toggle
  const toggleStrict = mutations.find(m => m.label === 'toggle strict=false');
  assert.ok(toggleStrict);
  assert.equal(toggleStrict.val.strict, false);

  // Check number boundaries
  const zeroLimit = mutations.find(m => m.label === 'boundary limit=0');
  assert.ok(zeroLimit);
  assert.equal(zeroLimit.val.limit, 0);

  const negLimit = mutations.find(m => m.label === 'boundary limit=-1');
  assert.ok(negLimit);
  assert.equal(negLimit.val.limit, -1);
});

test('Shape Seeds: synthesizeSeeds end-to-end synthesizes type-informed inputs and targeted fuzz cases', () => {
  const fnInfo = {
    name: 'parseSql',
    params: [
      { name: 'sql', tsType: { kind: 'primitive', primitive: 'string' } },
      {
        name: 'options',
        tsType: {
          kind: 'object',
          name: 'ParserOptions',
          properties: [
            { name: 'dialect', type: { kind: 'union', values: ['postgres', 'mysql'] } },
            { name: 'strict', type: { kind: 'primitive', primitive: 'boolean' } }
          ]
        }
      }
    ]
  };

  const { baselineSeed, fuzzSeeds } = synthesizeSeeds(fnInfo, new Map(), { fuzz: true });

  assert.equal(baselineSeed[0], 'benchmark');
  assert.deepEqual(baselineSeed[1], { dialect: 'postgres', strict: true });

  // Check fuzzSeeds contains mutations for options
  const hasMysql = fuzzSeeds.some(s => s.args[1] && s.args[1].dialect === 'mysql');
  const hasToggledStrict = fuzzSeeds.some(s => s.args[1] && s.args[1].strict === false);
  const hasEmptyOptions = fuzzSeeds.some(s => s.args[1] && Object.keys(s.args[1]).length === 0);

  assert.ok(hasMysql);
  assert.ok(hasToggledStrict);
  assert.ok(hasEmptyOptions);
});

test('CLI: auto-bench benchmarks TypeScript function with interface options and exercises branches', async () => {
  const tmpDir = path.join(os.tmpdir(), `softscope-shape-e2e-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tsFile = path.join(tmpDir, 'parser.ts');

  fs.writeFileSync(
    tsFile,
    `
    export interface ParserOptions {
      dialect?: 'postgres' | 'mysql';
      strict?: boolean;
    }

    export function executeQuery(query: string, options?: ParserOptions) {
      if (options?.dialect === 'postgres') {
        return 'pg:' + query;
      }
      if (options?.dialect === 'mysql') {
        return 'my:' + query;
      }
      return 'def:' + query;
    }
  `
  );

  try {
    const { stdout } = await runCli(['auto-bench', tsFile, '--iterations', '500', '--json']);
    const json = JSON.parse(stdout);
    assert.ok(json.functions.length >= 1);
    const bench = json.functions.find(b => b.name === 'executeQuery');
    assert.ok(bench);
    assert.ok(bench.opsPerSec > 0);
    assert.deepEqual(bench.baselineSeed[1], { dialect: 'postgres', strict: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
