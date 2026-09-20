import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeSessionSnapshots } from './report/summary.js';
import { renderTerminalReport } from './report/format.js';
import { renderJsonReport } from './report/json.js';
import { renderMarkdownReport } from './report/markdown.js';
import { renderAiReport } from './report/ai.js';
import { createLiveReporter } from './report/live.js';
import { createTui } from './report/tui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTER_PATH = path.resolve(__dirname, 'loader', 'register.js');

export async function runCommand(options) {
  if (options.command.length === 0) {
    printHelp();
    return 0;
  }

  // 1. Resolve executable and arguments
  let executable = options.command[0];
  let childArgs = options.command.slice(1);

  const isJsFile =
    executable.endsWith('.js') ||
    executable.endsWith('.mjs') ||
    executable.endsWith('.cjs') ||
    executable.endsWith('.ts') ||
    executable.endsWith('.mts') ||
    executable.endsWith('.cts') ||
    executable.endsWith('.jsx') ||
    executable.endsWith('.tsx');

  const resolvedTarget = path.resolve(options.projectRoot, executable);
  const existsAsFile = fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isFile();

  if (isJsFile || existsAsFile) {
    // Direct file execution: softscope app.js -> node app.js
    executable = process.execPath;
    childArgs = options.command;
  }

  // 2. Create temporary session directory
  const sessionDir = path.join(
    os.tmpdir(),
    `softscope-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  // 3. Setup TUI or Live Reporter
  const isTtyAvailable = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const useTui = Boolean(options.tui && isTtyAvailable);
  const tui = useTui ? createTui({ targetCommand: options.command.join(' ') }) : null;
  const liveReporter = (options.live && !tui) ? createLiveReporter() : null;

  // 4. Create IPC server for live updates & session tracking
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\softscope-${process.pid}-${Date.now()}`
      : path.join(sessionDir, 'softscope.sock');

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep partial line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'heartbeat') {
            if (tui) {
              tui.update(msg);
            } else if (liveReporter) {
              liveReporter.render(msg);
            }
          }
        } catch {
          // Ignore invalid frames
        }
      }
    });
  });

  await new Promise((resolve) => {
    server.listen(socketPath, () => resolve());
  });

  // 5. Prepare environment variables
  const registerUrl = pathToFileURL(REGISTER_PATH).href;
  const existingNodeOptions = process.env.NODE_OPTIONS || '';
  const alreadyImported = existingNodeOptions.includes(REGISTER_PATH) || existingNodeOptions.includes(registerUrl);
  const nodeOptions = alreadyImported
    ? existingNodeOptions
    : existingNodeOptions
      ? `${existingNodeOptions} --import=${registerUrl}`
      : `--import=${registerUrl}`;

  const childEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    SOFTSCOPE_SESSION_DIR: sessionDir,
    SOFTSCOPE_CONFIG: JSON.stringify(options),
    SOFTSCOPE_LIVE: (options.live || options.tui) ? '1' : '0',
    SOFTSCOPE_IPC_SOCKET: socketPath
  };

  const startTime = Date.now();

  // 6. Spawn child process
  return new Promise((resolve) => {
    if (tui) {
      tui.start();
    }

    const childStdio = tui ? ['inherit', 'pipe', 'pipe'] : 'inherit';

    const child = spawn(executable, childArgs, {
      cwd: options.projectRoot,
      env: childEnv,
      stdio: childStdio
    });

    if (tui && child.stdout && child.stderr) {
      child.stdout.on('data', (chunk) => tui.appendLog(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => tui.appendLog(chunk, 'stderr'));
    }

    // Forward termination signals
    const forwardSignal = (sig) => {
      if (child && !child.killed) {
        child.kill(sig);
      }
    };

    if (tui) {
      tui.onAbort(() => {
        forwardSignal('SIGINT');
      });
    }

    process.on('SIGINT', forwardSignal);
    process.on('SIGTERM', forwardSignal);
    process.on('SIGHUP', forwardSignal);

    child.on('error', (err) => {
      console.error(`[softscope] Failed to start command "${executable}": ${err.message}`);
      cleanup();
      if (tui) tui.close();
      resolve(1);
    });

    child.on('close', (code, signal) => {
      const overallDurationMs = Date.now() - startTime;

      cleanup();

      // Read all dump files from sessionDir
      const snapshots = [];
      try {
        if (fs.existsSync(sessionDir)) {
          const files = fs.readdirSync(sessionDir);
          for (const f of files) {
            if (f.startsWith('proc-') && f.endsWith('.json')) {
              const content = fs.readFileSync(path.join(sessionDir, f), 'utf-8');
              try {
                snapshots.push(JSON.parse(content));
              } catch {
                // Ignore corrupt dumps
              }
            }
          }
        }
      } catch {
        // Continue
      }

      // Cleanup sessionDir
      try {
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors
      }

      // Aggregate metrics
      const summary = mergeSessionSnapshots(snapshots, overallDurationMs);

      // Output to file if requested
      if (options.output) {
        let fileContent;
        if (options.ai || options.output.endsWith('.ai') || options.output.endsWith('.llm')) {
          fileContent = renderAiReport(summary, {
            top: options.top,
            files: options.files,
            targetCommand: options.command.join(' ')
          });
        } else if (options.md || options.output.endsWith('.md')) {
          fileContent = renderMarkdownReport(summary, {
            top: options.top,
            files: options.files
          });
        } else {
          fileContent = renderJsonReport(summary);
        }

        try {
          fs.writeFileSync(options.output, fileContent, 'utf-8');
        } catch (err) {
          console.error(`[softscope] Failed to write report to ${options.output}: ${err.message}`);
        }
      }

      // Determine exit code
      let exitCode = 0;
      if (typeof code === 'number') {
        exitCode = code;
      } else if (signal) {
        exitCode = 128 + 15; // SIGTERM default
      }

      if (tui) {
        tui.finish(summary, exitCode);
        tui.onExit((finalCode) => {
          resolve(finalCode);
        });
      } else {
        // Output to stdout for non-TUI runs
        if (options.json) {
          const jsonOutput = renderJsonReport(summary);
          process.stdout.write(jsonOutput + '\n');
        } else if (options.ai) {
          const aiOutput = renderAiReport(summary, {
            top: options.top,
            files: options.files,
            targetCommand: options.command.join(' ')
          });
          process.stdout.write('\n' + aiOutput + '\n');
        } else if (options.md) {
          const mdOutput = renderMarkdownReport(summary, {
            top: options.top,
            files: options.files
          });
          process.stdout.write('\n' + mdOutput + '\n');
        } else {
          const textReport = renderTerminalReport(summary, {
            top: options.top,
            files: options.files
          });
          process.stdout.write('\n' + textReport + '\n');
        }

        resolve(exitCode);
      }
    });

    function cleanup() {
      process.removeListener('SIGINT', forwardSignal);
      process.removeListener('SIGTERM', forwardSignal);
      process.removeListener('SIGHUP', forwardSignal);

      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close();
      } catch {
        // Ignore
      }

      try {
        if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {
        // Ignore
      }
    }
  });
}

export function printHelp() {
  const helpText = `
Usage:
  softscope <file>
  softscope <command> [...args]

Examples:
  softscope app.js
  softscope bench/run.js
  softscope --tui bench/run.js
  softscope --md bench/run.js
  softscope -o report.md app.js

Options:
  --tui                    Launch interactive Terminal User Interface (TUI)
  --ai, --llm              Output token-efficient AI/LLM diagnostic report to stdout
  --live                   Display lightweight live metrics while process runs
  --files                  Show file-level breakdown summary
  --md, --markdown         Output report in GitHub Flavored Markdown format to stdout
  --json                   Output report in versioned JSON format to stdout
  --output <file>, -o      Write report to file (.md for Markdown, .json for JSON, .ai for AI)
  --top <n>                Number of top functions to display (default: 10)
  --include <glob>         Glob pattern for files to include
  --exclude <glob>         Glob pattern for files to exclude
  --include-node-modules   Include node_modules in instrumentation
  --strict                 Throw on instrumentation or parse errors
  --help, -h               Show this help message
  --version, -v            Show version
`.trim();

  console.log(helpText);
}
