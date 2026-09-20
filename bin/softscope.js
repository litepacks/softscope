#!/usr/bin/env node
import { main } from '../src/cli.js';

main().then((code) => {
  process.exitCode = typeof code === 'number' ? code : 0;
}).catch((err) => {
  console.error('[softscope] Fatal error:', err);
  process.exit(1);
});
