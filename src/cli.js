import { parseCliArgs } from './config.js';
import { runCommand, runStandaloneCompare, printHelp } from './runner.js';
import { runAutoBench } from './autobench/harness.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);

  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.version) {
    try {
      const pkgPath = path.resolve(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      console.log(`softscope v${pkg.version}`);
    } catch {
      console.log('softscope v0.1.0');
    }
    return 0;
  }

  if (options.command[0] === 'compare') {
    return runStandaloneCompare(options);
  }

  if (options.command[0] === 'auto-bench') {
    return runAutoBench(options);
  }

  return runCommand(options);
}
