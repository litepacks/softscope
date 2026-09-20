# Softscope Demo Application

This directory contains a zero-dependency demo application to explore and evaluate Softscope's profiling and observability capabilities (terminal tables, file breakdown, caller-callee call graphs, live telemetry, and Markdown/JSON report formats).

## Project Structure

```text
demo/
├── index.js                  # Single-run batch simulation (generates reports immediately)
├── server.js                 # HTTP API server (for live telemetry and simulated load)
├── services/
│   ├── user-service.js       # User profile operations & mock data
│   └── order-service.js      # Order processing, discounts, and taxes (nested call trees)
├── utils/
│   └── math.js               # Helper math, clamping, and Fibonacci computation
└── package.json              # Sample profiling and benchmark scripts
```

---

## How to Run

### 1. Batch Simulation (One-off Execution)
Run directly from the repository root or within the `demo` directory:

```bash
# Terminal table report
softscope demo/index.js

# Markdown report to stdout
softscope demo/index.js --md

# Export Markdown report to file
softscope demo/index.js -o report.md

# File-level reach and metric breakdown
softscope demo/index.js --files

# Versioned JSON schema output
softscope demo/index.js --json
```

---

### 2. Live Telemetry Mode (`--live`)
Run the HTTP server with real-time function call statistics streaming to stderr:

```bash
softscope --live demo/server.js --simulate
```

> **Note:** The `--simulate` flag triggers automatic HTTP requests every 2 seconds across the demo API endpoints, producing continuous live telemetry in your terminal.

---

### 3. Running via `package.json`
From inside the `demo/` folder:

```bash
cd demo

# Normal execution
npm start

# Profile with Softscope terminal report
npm run dev:perf

# Batch simulation with Markdown output
npm run batch:md

# Batch simulation exporting to report.md
npm run batch:out
```
