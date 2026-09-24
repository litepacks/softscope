// Test fixture for auto-benchmarking, seed synthesis, and edge-case fuzzing

export function add(a = 1, b = 2) {
  return a + b;
}

export function multiply(x = 10, y = 20) {
  return x * y;
}

// Intentional unhandled edge-case crash when user is null or missing name
export function formatName(user = { name: 'alice' }) {
  if (user === null || typeof user !== 'object') {
    throw new TypeError('Cannot read properties of null (reading "name")');
  }
  if (!user.name) {
    throw new TypeError('User must have a name property');
  }
  return user.name.toUpperCase();
}

// Intentional algorithmic latency cliff: O(N^2) quadratic nested loop on long strings
export function processTokens(str = 'hello') {
  if (typeof str !== 'string') return 0;
  let count = 0;
  const len = str.length;
  // If string exceeds 1,000 characters, simulate heavy quadratic processing
  if (len >= 1000) {
    for (let i = 0; i < len; i++) {
      for (let j = 0; j < Math.min(len, 2000); j++) {
        count += (i + j) % 2;
      }
    }
  } else {
    for (let i = 0; i < len; i++) {
      count += str.charCodeAt(i);
    }
  }
  return count;
}
