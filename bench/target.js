import { performance } from 'node:perf_hooks';

export function add(a, b) {
  return a + b;
}

const t0 = performance.now();
for (let i = 0; i < 1_000_000; i++) {
  add(i, 1);
}
const duration = performance.now() - t0;
console.log(`Loop duration: ${duration.toFixed(2)}ms`);
