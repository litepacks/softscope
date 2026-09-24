import path from 'node:path';

export const DEFAULT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx'
]);

export function parseCliArgs(rawArgs, cwd = process.cwd()) {
  const options = {
    live: false,
    tui: false,
    files: false,
    json: false,
    md: false,
    ai: false,
    output: null,
    top: 10,
    include: [],
    exclude: [],
    includeNodeModules: false,
    strict: false,
    saveBaseline: null,
    compare: null,
    failOnRegression: null,
    captureSeeds: null,
    seeds: null,
    fuzz: true,
    iterations: 10000,
    all: false,
    help: false,
    version: false,
    projectRoot: path.resolve(cwd),
    command: []
  };

  const command = [];
  let i = 0;
  let explicitCommandArgs = false;

  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (explicitCommandArgs) {
      command.push(arg);
      i++;
      continue;
    }

    if (arg === '--') {
      explicitCommandArgs = true;
      i++;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      i++;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
      i++;
    } else if (arg === '--live') {
      options.live = true;
      i++;
    } else if (arg === '--tui') {
      options.tui = true;
      options.live = true;
      i++;
    } else if (arg === '--md' || arg === '--markdown') {
      options.md = true;
      i++;
    } else if (arg === '--ai' || arg === '--llm') {
      options.ai = true;
      i++;
    } else if (arg === '--files') {
      options.files = true;
      i++;
    } else if (arg === '--json') {
      options.json = true;
      i++;
    } else if (arg === '--strict') {
      options.strict = true;
      i++;
    } else if (arg === '--include-node-modules') {
      options.includeNodeModules = true;
      i++;
    } else if (arg === '--output' || arg === '-o') {
      options.output = rawArgs[i + 1] ? path.resolve(cwd, rawArgs[i + 1]) : null;
      i += 2;
    } else if (arg.startsWith('--output=')) {
      options.output = path.resolve(cwd, arg.slice('--output='.length));
      i++;
    } else if (arg === '--top') {
      options.top = parseInt(rawArgs[i + 1], 10) || 10;
      i += 2;
    } else if (arg.startsWith('--top=')) {
      options.top = parseInt(arg.slice('--top='.length), 10) || 10;
      i++;
    } else if (arg === '--include') {
      if (rawArgs[i + 1]) options.include.push(rawArgs[i + 1]);
      i += 2;
    } else if (arg.startsWith('--include=')) {
      options.include.push(arg.slice('--include='.length));
      i++;
    } else if (arg === '--exclude') {
      if (rawArgs[i + 1]) options.exclude.push(rawArgs[i + 1]);
      i += 2;
    } else if (arg.startsWith('--exclude=')) {
      options.exclude.push(arg.slice('--exclude='.length));
      i++;
    } else if (arg === '--save-baseline') {
      options.saveBaseline = rawArgs[i + 1] ? path.resolve(cwd, rawArgs[i + 1]) : null;
      i += 2;
    } else if (arg.startsWith('--save-baseline=')) {
      options.saveBaseline = path.resolve(cwd, arg.slice('--save-baseline='.length));
      i++;
    } else if (arg === '--compare' || arg === '--baseline') {
      options.compare = rawArgs[i + 1] ? path.resolve(cwd, rawArgs[i + 1]) : null;
      i += 2;
    } else if (arg.startsWith('--compare=')) {
      options.compare = path.resolve(cwd, arg.slice('--compare='.length));
      i++;
    } else if (arg.startsWith('--baseline=')) {
      options.compare = path.resolve(cwd, arg.slice('--baseline='.length));
      i++;
    } else if (arg === '--fail-on-regression') {
      const val = parseFloat(rawArgs[i + 1]);
      options.failOnRegression = !isNaN(val) ? val : 10;
      i += 2;
    } else if (arg.startsWith('--fail-on-regression=')) {
      const val = parseFloat(arg.slice('--fail-on-regression='.length));
      options.failOnRegression = !isNaN(val) ? val : 10;
      i++;
    } else if (arg === '--capture-seeds') {
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) {
        options.captureSeeds = path.resolve(cwd, rawArgs[i + 1]);
        i += 2;
      } else {
        options.captureSeeds = path.resolve(cwd, 'seeds.json');
        i++;
      }
    } else if (arg.startsWith('--capture-seeds=')) {
      options.captureSeeds = path.resolve(cwd, arg.slice('--capture-seeds='.length));
      i++;
    } else if (arg === '--seeds') {
      options.seeds = rawArgs[i + 1] ? path.resolve(cwd, rawArgs[i + 1]) : null;
      i += 2;
    } else if (arg.startsWith('--seeds=')) {
      options.seeds = path.resolve(cwd, arg.slice('--seeds='.length));
      i++;
    } else if (arg === '--fuzz') {
      options.fuzz = true;
      i++;
    } else if (arg === '--no-fuzz') {
      options.fuzz = false;
      i++;
    } else if (arg === '--iterations') {
      options.iterations = parseInt(rawArgs[i + 1], 10) || 10000;
      i += 2;
    } else if (arg.startsWith('--iterations=')) {
      options.iterations = parseInt(arg.slice('--iterations='.length), 10) || 10000;
      i++;
    } else if (arg === '--all') {
      options.all = true;
      i++;
    } else {
      command.push(arg);
      i++;
    }
  }

  options.command = command;
  return options;
}
