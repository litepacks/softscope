import { listUsers, findUserById } from './services/user-service.js';
import { processOrder } from './services/order-service.js';
import { computeFibonacci } from './utils/math.js';

console.log('🚀 Softscope Demo Batch Simulation starting...');

// 1. User operations
const users = listUsers();
console.log(`Loaded ${users.length} users.`);

// 2. Process mock orders
const sampleItems = [
  { name: 'Mechanical Keyboard', price: 89.99, quantity: 1 },
  { name: 'USB-C Cable', price: 14.50, quantity: 2 },
  { name: 'Ergonomic Mousepad', price: 19.95, quantity: 1 }
];

const order1 = processOrder({
  userId: 'usr_1',
  items: sampleItems,
  couponCode: 'SAVE20'
});
console.log(`Processed order: ${order1.orderId}, total: $${order1.total}`);

const order2 = processOrder({
  userId: 'usr_2',
  items: [{ name: 'Monitor Arm', price: 49.00, quantity: 1 }],
  couponCode: 'FLAT10'
});
console.log(`Processed order: ${order2.orderId}, total: $${order2.total}`);

// 3. CPU-bound calculation simulation
const fibTarget = 30;
const fibResult = computeFibonacci(fibTarget);
console.log(`Computed Fibonacci(${fibTarget}) = ${fibResult}`);

console.log('✅ Demo simulation complete.\n');
