import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export function setupSession(collector) {
  const sessionDir = process.env.SOFTSCOPE_SESSION_DIR;
  const socketPath = process.env.SOFTSCOPE_IPC_SOCKET;
  const liveEnabled = process.env.SOFTSCOPE_LIVE === '1';

  let dumped = false;

  function dumpMetricsSync() {
    if (dumped) return;
    dumped = true;

    if (!sessionDir) return;

    try {
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const snapshot = collector.getSnapshot();
      const fileName = `proc-${process.pid}-${Date.now()}.json`;
      const filePath = path.join(sessionDir, fileName);

      fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch {
      // Never crash child process on dump error
    }
  }

  // Register process exit hooks
  process.once('beforeExit', () => {
    dumpMetricsSync();
  });

  process.once('exit', () => {
    dumpMetricsSync();
  });

  // Setup IPC client for live mode if socket is provided
  if (socketPath) {
    let client = null;
    let timer = null;

    try {
      client = net.createConnection(socketPath, () => {
        client.unref(); // Do not prevent process exit

        if (liveEnabled) {
          timer = setInterval(() => {
            if (!client.destroyed) {
              const snapshot = collector.getSnapshot();
              const hot = collector.getHotFunctions(6);
              const executedPct = snapshot.totalDiscovered > 0
                ? (snapshot.totalExecuted / snapshot.totalDiscovered) * 100
                : 0;

              const payload = JSON.stringify({
                type: 'heartbeat',
                pid: process.pid,
                uptimeMs: Date.now() - collector.startTime,
                activeFunctions: collector.getActiveCount(),
                totalCalls: snapshot.totalCalls,
                filesObserved: snapshot.files.length,
                functionsDiscovered: snapshot.totalDiscovered,
                functionsExecuted: snapshot.totalExecuted,
                runtimeReach: {
                  executedPercent: Number(executedPct.toFixed(1)),
                  notExecutedPercent: Number((100 - executedPct).toFixed(1))
                },
                hot,
                files: snapshot.files.slice(0, 15).map(f => ({
                  file: f.file,
                  calls: f.calls,
                  totalTimeMs: Number(f.totalTimeMs.toFixed(2)),
                  functionsDiscovered: f.functionsDiscovered,
                  functionsExecuted: f.functionsExecuted
                }))
              }) + '\n';
              client.write(payload);
            }
          }, 400);
          timer.unref();
        }
      });

      client.on('error', () => {
        if (timer) clearInterval(timer);
      });
    } catch {
      // Silently continue without IPC
    }
  }

  return {
    dumpMetricsSync
  };
}
