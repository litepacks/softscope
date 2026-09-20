export function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculatePercentage(amount, percent) {
  return roundCurrency((amount * percent) / 100);
}

export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

export function computeFibonacci(n) {
  if (n <= 1) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const c = a + b;
    a = b;
    b = c;
  }
  return b;
}

export function unusedMathHelper(x) {
  // Deliberately untouched at runtime to demonstrate runtime reach detection
  return Math.sqrt(Math.abs(x)) * Math.PI;
}
