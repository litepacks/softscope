import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFilter } from '../instrument/filter.js';
import { createFunctionRegistry } from '../instrument/registry.js';
import { transformSource } from '../instrument/transform.js';
import { SoftscopeVitestReporter } from './reporter.js';
import { SoftscopeTestRunner } from './runner.js';
import { compareTestMetrics } from './compare.js';
import { sessionManager, als, TestSession } from './context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOFTSCOPE_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER_PATH = path.resolve(__dirname, 'runner.js');
const SETUP_PATH = path.resolve(__dirname, 'setup.js');

const VIRTUAL_VITEST_CLIENT_ID = 'virtual:softscope-vitest-client';
const RESOLVED_VIRTUAL_VITEST_CLIENT_ID = '\0' + VIRTUAL_VITEST_CLIENT_ID;

/**
 * Softscope Vitest Plugin.
 * Seamlessly profiles instrumented application code inside Vitest tests
 * and outputs per-test performance summaries and optional baseline comparisons.
 *
 * @param {Object} [options]
 * @param {Array<string|RegExp>} [options.include] - File inclusion patterns
 * @param {Array<string|RegExp>} [options.exclude] - File exclusion patterns
 * @param {boolean} [options.includeNodeModules=false] - Whether to profile files in node_modules
 * @param {string|boolean} [options.json=false] - Output JSON report file path (e.g. 'softscope-report.json')
 * @param {string} [options.baseline] - File path of baseline to compare against
 * @param {string|boolean} [options.saveBaseline=false] - Save current run as baseline to file path
 * @param {number} [options.threshold=10] - Percentage regression threshold (default: 10%)
 * @param {number} [options.minAbsoluteDeltaMs=1.0] - Minimum absolute duration difference in ms before flagging regression
 * @param {boolean} [options.silent=false] - Suppress terminal performance summary
 * @returns {import('vite').Plugin}
 */
export function softscopeVitest(options = {}) {
  let projectRoot = process.cwd();
  let filter = null;
  const registry = createFunctionRegistry();

  function getFilter() {
    if (!filter) {
      filter = createFilter({
        projectRoot,
        include: options.include || [],
        exclude: options.exclude || [],
        includeNodeModules: Boolean(options.includeNodeModules)
      });
    }
    return filter;
  }

  const reporterInstance = new SoftscopeVitestReporter({
    json: options.json,
    baseline: options.baseline,
    saveBaseline: options.saveBaseline,
    threshold: options.threshold,
    minAbsoluteDeltaMs: options.minAbsoluteDeltaMs,
    silent: options.silent
  });

  return {
    name: 'softscope:vitest',
    enforce: 'pre',

    config(userConfig) {
      process.env.SOFTSCOPE_PROJECT_ROOT = projectRoot;
      // Initialize fallback globalThis.__softscope in main Vitest process as well
      sessionManager.init();

      userConfig.test = userConfig.test || {};

      // 1. Guard against unsupported browser mode
      if (userConfig.test.browser && userConfig.test.browser.enabled) {
        console.warn(
          '\n\x1b[33m[softscope] Warning: Vitest Browser Mode is not supported by softscope/vitest.\x1b[0m\n' +
          'Softscope Vitest integration requires a Node.js worker environment (threads, forks, vmThreads).\n' +
          'For browser profiling, please use the "softscope/vite" plugin with the in-browser HUD overlay instead.\n'
        );
        return;
      }

      // 2. Preserve existing user reporters and register Softscope reporter
      const existingReporters = userConfig.test.reporters
        ? (Array.isArray(userConfig.test.reporters) ? [...userConfig.test.reporters] : [userConfig.test.reporters])
        : ['default'];

      if (!existingReporters.includes(reporterInstance)) {
        existingReporters.push(reporterInstance);
      }
      userConfig.test.reporters = existingReporters;

      // 3. Configure setupFiles and test runner
      const existingSetup = userConfig.test.setupFiles
        ? (Array.isArray(userConfig.test.setupFiles) ? [...userConfig.test.setupFiles] : [userConfig.test.setupFiles])
        : [];

      if (!existingSetup.includes(SETUP_PATH)) {
        existingSetup.push(SETUP_PATH);
      }
      userConfig.test.setupFiles = existingSetup;

      if (!userConfig.test.runner) {
        userConfig.test.runner = RUNNER_PATH;
      }

      // Ensure application code is processed through Vite's transform pipeline (even under CJS require)
      userConfig.test.server = userConfig.test.server || {};
      userConfig.test.server.deps = userConfig.test.server.deps || {};
      const existingInline = Array.isArray(userConfig.test.server.deps.inline)
        ? userConfig.test.server.deps.inline
        : (userConfig.test.server.deps.inline ? [userConfig.test.server.deps.inline] : []);

      // Inline non-node_modules local source files so Vite transforms them
      userConfig.test.server.deps.inline = [...existingInline, /^(?!\/?node_modules).*$/];

      return {
        test: {
          runner: userConfig.test.runner,
          setupFiles: existingSetup,
          reporters: userConfig.test.reporters,
          server: {
            deps: {
              inline: userConfig.test.server.deps.inline
            }
          }
        }
      };
    },

    configResolved(resolvedConfig) {
      projectRoot = resolvedConfig.root ? path.resolve(resolvedConfig.root) : process.cwd();
      process.env.SOFTSCOPE_PROJECT_ROOT = projectRoot;
      filter = null;

      // Ensure reporter is registered in resolvedConfig in case CLI flags stripped it
      if (resolvedConfig.test) {
        if (!Array.isArray(resolvedConfig.test.reporters)) {
          resolvedConfig.test.reporters = resolvedConfig.test.reporters ? [resolvedConfig.test.reporters] : ['default'];
        }
        if (!resolvedConfig.test.reporters.includes(reporterInstance)) {
          resolvedConfig.test.reporters.push(reporterInstance);
        }
      }
    },

    configureVitest(context) {
      if (context && context.vitest && context.vitest.config) {
        const vConfig = context.vitest.config;
        if (Array.isArray(vConfig.reporters)) {
          if (!vConfig.reporters.includes(reporterInstance)) {
            vConfig.reporters.push(reporterInstance);
          }
        }
      }
    },

    resolveId(id) {
      const [cleanId] = id.split('?');
      if (
        cleanId === VIRTUAL_VITEST_CLIENT_ID ||
        cleanId === '/@id/' + VIRTUAL_VITEST_CLIENT_ID ||
        cleanId === '/' + VIRTUAL_VITEST_CLIENT_ID ||
        cleanId.includes(VIRTUAL_VITEST_CLIENT_ID)
      ) {
        return RESOLVED_VIRTUAL_VITEST_CLIENT_ID;
      }
      return null;
    },

    load(id) {
      const [cleanId] = id.split('?');
      if (cleanId === RESOLVED_VIRTUAL_VITEST_CLIENT_ID || cleanId.includes(VIRTUAL_VITEST_CLIENT_ID)) {
        return [
          `const fallback = {`,
          `  enter: () => {},`,
          `  exit: () => {},`,
          `  registerFile: () => {}`,
          `};`,
          `const client = new Proxy(fallback, {`,
          `  get(target, prop) {`,
          `    if (typeof globalThis !== 'undefined' && globalThis.__softscope && typeof globalThis.__softscope[prop] === 'function') {`,
          `      return globalThis.__softscope[prop].bind(globalThis.__softscope);`,
          `    }`,
          `    return target[prop] || (() => {});`,
          `  }`,
          `});`,
          `export default client;`,
          `export const __softscope = client;`
        ].join('\n');
      }
      return null;
    },

    transform(code, id) {
      if (!code || typeof code !== 'string') return null;

      const [cleanId] = id.split('?');

      // Skip virtual modules, test files, setup/global-setup files, and softscope internal runtime files
      if (
        cleanId.startsWith('\0') ||
        cleanId.includes(VIRTUAL_VITEST_CLIENT_ID) ||
        cleanId.startsWith(SOFTSCOPE_ROOT) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(cleanId) ||
        /(global[-_]?setup|vitest\.setup|setup-files?)\.[cm]?[jt]sx?$/i.test(cleanId)
      ) {
        return null;
      }

      const activeFilter = getFilter();
      if (!activeFilter(cleanId)) {
        return null;
      }

      const relativePath = path.relative(projectRoot, cleanId).replace(/\\/g, '/');

      const result = transformSource(code, cleanId, relativePath, registry, {
        clientImport: VIRTUAL_VITEST_CLIENT_ID
      });

      if (!result.transformed) {
        return null;
      }

      return {
        code: result.code,
        map: result.map
      };
    }
  };
}

export {
  SoftscopeVitestReporter,
  SoftscopeTestRunner,
  compareTestMetrics,
  sessionManager,
  als,
  TestSession
};

export default softscopeVitest;
