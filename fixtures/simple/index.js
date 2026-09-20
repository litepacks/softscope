// Simple fixture exercising various function types and call trees
export function add(a, b) {
  return a + b;
}

export const multiply = (a, b) => a * b;

export const compute = (x) => {
  if (x <= 0) return 0;
  const sum = add(x, 10);
  return multiply(sum, 2);
};

export class Calculator {
  constructor(initial = 0) {
    this.value = initial;
  }

  get current() {
    return this.value;
  }

  set current(val) {
    this.value = val;
  }

  calculate() {
    const numbers = [1, 2, 3];
    const squared = numbers.map(n => n * n);
    return squared.reduce((acc, n) => add(acc, n), this.value);
  }
}

// Unexecuted function to test runtime reach
export function neverCalledHelper() {
  return 'untouched';
}

// Main execution
for (let i = 0; i < 5; i++) {
  compute(i);
}

const calc = new Calculator(100);
calc.current = 50;
const total = calc.calculate();
console.log('Calculator result:', total);
