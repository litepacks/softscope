import http from 'node:http';
import { listUsers } from './services/user-service.js';
import { processOrder } from './services/order-service.js';
import { computeFibonacci } from './utils/math.js';

const PORT = Number(process.env.PORT) || 3000;
const shouldSimulate = process.argv.includes('--simulate');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Softscope Demo App</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; line-height: 1.6; color: #1e293b; }
          h1 { color: #0284c7; }
          ul { list-style: none; padding: 0; }
          li { margin: 12px 0; }
          a { color: #2563eb; text-decoration: none; font-weight: 600; padding: 6px 12px; background: #f1f5f9; border-radius: 6px; }
          a:hover { background: #e2e8f0; }
          .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 24px; }
        </style>
      </head>
      <body>
        <h1>🔭 Softscope Demo API</h1>
        <p>This demo server processes simulated e-commerce and computation requests to generate rich runtime telemetry.</p>
        <ul>
          <li><a href="/api/users">GET /api/users</a> - List formatted user profiles</li>
          <li><a href="/api/orders">GET /api/orders</a> - Process and validate sample order</li>
          <li><a href="/api/compute">GET /api/compute</a> - Run CPU-bound Fibonacci calculations</li>
        </ul>
        <div class="card">
          <strong>Tip:</strong> Run with <code>softscope --live demo/server.js --simulate</code> to see live performance telemetry streamed to stderr!
        </div>
      </body>
      </html>
    `);
    return;
  }

  if (url.pathname === '/api/users') {
    const users = listUsers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, count: users.length, users }));
    return;
  }

  if (url.pathname === '/api/orders') {
    const order = processOrder({
      userId: 'usr_1',
      items: [
        { name: 'Ergonomic Desk Mat', price: 29.99, quantity: 2 },
        { name: 'USB Hub 4-Port', price: 19.50, quantity: 1 }
      ],
      couponCode: 'SAVE20'
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, order }));
    return;
  }

  if (url.pathname === '/api/compute') {
    const target = Number(url.searchParams.get('n')) || 32;
    const result = computeFibonacci(target);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, n: target, result }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`[demo-server] Server listening on http://localhost:${PORT}`);
  if (shouldSimulate) {
    console.log('[demo-server] Traffic simulation active: sending simulated requests every 2 seconds...');
    const endpoints = ['/api/users', '/api/orders', '/api/compute'];
    let idx = 0;
    const timer = setInterval(() => {
      const ep = endpoints[idx % endpoints.length];
      idx++;
      http.get(`http://localhost:${PORT}${ep}`, (res) => {
        res.resume();
      }).on('error', () => {});
    }, 2000);
    timer.unref();
  }
});
