import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILENAMES = [
  '.softscoperc.json',
  '.softscoperc',
  'softscope.config.json'
];

/**
 * Discovers and loads a Softscope configuration file from disk.
 *
 * Supported formats:
 * - Explicit path via --config <file>
 * - .softscoperc.json
 * - .softscoperc (JSON)
 * - softscope.config.json
 * - "softscope" section in package.json
 */
export function loadConfig(projectRoot = process.cwd(), explicitPath = null) {
  if (explicitPath) {
    const resolved = path.resolve(projectRoot, explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found at: ${resolved}`);
    }
    return parseConfigFile(resolved);
  }

  // 1. Check dedicated config files in project root
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(projectRoot, filename);
    if (fs.existsSync(candidate)) {
      return parseConfigFile(candidate);
    }
  }

  // 2. Check "softscope" field in package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      if (pkg.softscope && typeof pkg.softscope === 'object') {
        return {
          config: pkg.softscope,
          configFile: pkgPath
        };
      }
    } catch {
      // Ignore invalid package.json in discovery
    }
  }

  return {
    config: {},
    configFile: null
  };
}

function parseConfigFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at ${filePath}: ${err.message}`);
  }

  try {
    const config = JSON.parse(content);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Config file must contain a valid JSON object');
    }
    return {
      config,
      configFile: filePath
    };
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${filePath}: ${err.message}`);
  }
}
