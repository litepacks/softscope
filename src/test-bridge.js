import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './runner.js';

/**
 * Detects the project test runner and forwards execution to Softscope with dynamic seed capture.
 */
export async function runTestBridge(options) {
  const rawArgs = options.command.slice(1);
  const projectRoot = options.projectRoot || process.cwd();

  // 1. Check for capture override flags in test args
  let captureSeeds = true;
  let customSeedsFile = null;
  const forwardedArgs = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--no-capture' || arg === '--no-capture-seeds') {
      captureSeeds = false;
    } else if (arg === '--capture-seeds' || arg === '--seeds') {
      captureSeeds = true;
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) {
        customSeedsFile = rawArgs[i + 1];
        i++;
      }
    } else if (arg.startsWith('--capture-seeds=')) {
      captureSeeds = true;
      customSeedsFile = arg.slice('--capture-seeds='.length);
    } else if (arg.startsWith('--seeds=')) {
      captureSeeds = true;
      customSeedsFile = arg.slice('--seeds='.length);
    } else {
      forwardedArgs.push(arg);
    }
  }

  // 2. Discover test runner
  const testCmd = resolveTestCommand(projectRoot, forwardedArgs);

  if (captureSeeds && !options.captureSeeds) {
    const seedsTarget = customSeedsFile || options.seeds || 'seeds.json';
    options.captureSeeds = path.resolve(projectRoot, seedsTarget);
  }

  const prettyCmd = testCmd.join(' ');
  const seedsNotice = options.captureSeeds
    ? ` (recording seeds to ${path.relative(process.cwd(), options.captureSeeds) || options.captureSeeds})`
    : '';

  console.log(`[softscope test] 🧪 Running test suite: "${prettyCmd}"${seedsNotice}...`);

  options.command = testCmd;
  return runCommand(options);
}

/**
 * Resolves the underlying test runner command based on package.json and project files.
 */
export function resolveTestCommand(projectRoot, forwardedArgs = []) {
  const pkgPath = path.join(projectRoot, 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      // Ignore
    }
  }

  const hasNpmTestScript = pkg && pkg.scripts && typeof pkg.scripts.test === 'string' &&
    !pkg.scripts.test.includes('no test specified');

  if (hasNpmTestScript) {
    const isPnpm = fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'));
    const isYarn = fs.existsSync(path.join(projectRoot, 'yarn.lock'));
    const isBun = fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'));

    if (isPnpm) {
      return ['pnpm', 'test', ...(forwardedArgs.length > 0 ? ['--', ...forwardedArgs] : [])];
    }
    if (isYarn) {
      return ['yarn', 'test', ...forwardedArgs];
    }
    if (isBun) {
      return ['bun', 'test', ...forwardedArgs];
    }
    return ['npm', 'test', ...(forwardedArgs.length > 0 ? ['--', ...forwardedArgs] : [])];
  }

  // Fallback checks
  const isVitest = (pkg?.devDependencies?.vitest || pkg?.dependencies?.vitest) ||
    fs.existsSync(path.join(projectRoot, 'vitest.config.ts')) ||
    fs.existsSync(path.join(projectRoot, 'vitest.config.js'));

  if (isVitest) {
    return ['npx', 'vitest', 'run', ...forwardedArgs];
  }

  const isJest = (pkg?.devDependencies?.jest || pkg?.dependencies?.jest) ||
    fs.existsSync(path.join(projectRoot, 'jest.config.js')) ||
    fs.existsSync(path.join(projectRoot, 'jest.config.ts'));

  if (isJest) {
    return ['npx', 'jest', ...forwardedArgs];
  }

  // Native node --test fallback
  if (fs.existsSync(path.join(projectRoot, 'test'))) {
    return ['node', '--test', ...(forwardedArgs.length > 0 ? forwardedArgs : ['test/**/*.test.js'])];
  }

  // Final fallback
  return ['npm', 'test', ...(forwardedArgs.length > 0 ? ['--', ...forwardedArgs] : [])];
}
