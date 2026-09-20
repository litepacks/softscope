import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFilter } from '../instrument/filter.js';
import { createFunctionRegistry } from '../instrument/registry.js';
import { transformSource } from '../instrument/transform.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOFTSCOPE_ROOT = path.resolve(__dirname, '..', '..');

const VIRTUAL_CLIENT_ID = 'virtual:softscope-client';
const RESOLVED_VIRTUAL_CLIENT_ID = '\0' + VIRTUAL_CLIENT_ID;

/**
 * Softscope Vite Plugin for in-browser profiling and floating HUD overlay.
 *
 * @param {Object} [options]
 * @param {boolean} [options.overlay=true] - Whether to inject floating badge and diagnostics drawer
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [options.position='bottom-right'] - Overlay badge position
 * @param {string} [options.openHotkey='alt+s'] - Keyboard shortcut to toggle drawer
 * @param {Array<string|RegExp>} [options.include] - File inclusion patterns
 * @param {Array<string|RegExp>} [options.exclude] - File exclusion patterns
 * @param {boolean} [options.includeNodeModules=false] - Whether to profile dependencies in node_modules
 * @returns {import('vite').Plugin}
 */
export function softscope(options = {}) {
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

  return {
    name: 'softscope',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      projectRoot = resolvedConfig.root ? path.resolve(resolvedConfig.root) : process.cwd();
      filter = null; // Re-create filter with resolved root
    },

    resolveId(id) {
      const [cleanId] = id.split('?');
      if (
        cleanId === VIRTUAL_CLIENT_ID ||
        cleanId === '/@id/' + VIRTUAL_CLIENT_ID ||
        cleanId === '/' + VIRTUAL_CLIENT_ID ||
        cleanId.includes(VIRTUAL_CLIENT_ID)
      ) {
        return RESOLVED_VIRTUAL_CLIENT_ID;
      }
      return null;
    },

    load(id) {
      const [cleanId] = id.split('?');
      if (cleanId === RESOLVED_VIRTUAL_CLIENT_ID || cleanId.includes(VIRTUAL_CLIENT_ID)) {
        const clientOptions = {
          overlay: options.overlay !== false,
          position: options.position || 'bottom-right',
          openHotkey: options.openHotkey || 'alt+s'
        };

        return [
          `import { initSoftscopeClient } from 'softscope/client';`,
          `const client = initSoftscopeClient(${JSON.stringify(clientOptions)});`,
          `export default client;`,
          `export { client, initSoftscopeClient };`
        ].join('\n');
      }
      return null;
    },

    transformIndexHtml() {
      if (options.overlay === false) return;
      return [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: '/@id/' + VIRTUAL_CLIENT_ID
          },
          injectTo: 'head-prepend'
        }
      ];
    },

    transform(code, id) {
      if (!code || typeof code !== 'string') return null;

      const [cleanId] = id.split('?');

      // Skip virtual modules and internal softscope runtime files
      if (
        cleanId.startsWith('\0') ||
        cleanId.includes(VIRTUAL_CLIENT_ID) ||
        cleanId.startsWith(SOFTSCOPE_ROOT)
      ) {
        return null;
      }

      const activeFilter = getFilter();
      if (!activeFilter(cleanId)) {
        return null;
      }

      const relativePath = path.relative(projectRoot, cleanId).replace(/\\/g, '/');

      const result = transformSource(code, cleanId, relativePath, registry, {
        clientImport: VIRTUAL_CLIENT_ID
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

export default softscope;
