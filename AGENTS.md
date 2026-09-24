# AGENTS.md

Welcome to the **Softscope** codebase. This document outlines project conventions, architectural design, invariant constraints, and workflows to assist AI coding agents when navigating, modifying, or extending this repository.

---

## 1. Project Overview

Softscope is a lightweight, zero-bloat Node.js CLI tool specifically engineered to profile and observe runtime behavior in **benchmarks, micro-benchmarks, test suites, and application scripts**.

### Key Capabilities
- **Microscopic Function Profiling**: Measures exact function call frequencies, total durations, self-times (exclusive duration subtracting child calls), and min/avg/max latencies.
- **Autonomous Micro-Benchmarking & Fuzz-Bench**: Automatically analyzes functions and dependencies, synthesizes inputs, measures ops/sec throughput, and hunts down latency cliffs and unhandled edge-case crashes.
- **Dynamic Seed Capture (Record & Replay)**: Captures real function arguments during test runs (`--capture-seeds`) to replay as hyper-realistic micro-benchmarks.
- **Caller-Callee Call Graphs**: Discovers which functions call which, along with call counts.
- **Runtime Reach**: Compares statically discovered functions against runtime-executed functions to identify untouched code or untriggered branches.
- **Zero-Config Transparency**: Preserves target process arguments, environment variables, exit codes, stdio, and signal handling without modifying application source code.
- **Flexible Output Formats**: Human-readable terminal tables, GitHub Flavored Markdown (`--md` / `.md` files) for CI/PR comments, versioned JSON (`--json` / `.json` files), and token-efficient AI/LLM diagnostic profiles (`--ai` / `--llm` / `.ai` files) with actionable agent directives.

---

## 2. Technology Stack & Dependencies

Softscope maintains a strict minimal-dependency philosophy:
- **Node.js**: Requires Node `>= 20.6.0` (relies on native `--import` and `module.register()`).
- **AST Parsing**: `oxc-parser` (ultra-fast Rust-based JavaScript/TypeScript parser via N-API).
- **Code Transformation**: `magic-string` (lightweight string manipulation and sourcemap generation).
- **Path Matching**: `picomatch` (glob matching for include/exclude filters).
- **Vite (Optional Peer)**: Requires Vite `>= 4.0.0` (supports Vite 4.x, 5.x, 6.x+).
- **Test Runner**: Native Node.js test runner (`node --test`). Zero external test dependencies.

> **Rule for Agents**: Do **not** add heavy external dependencies (e.g. Babel, Webpack, Express, chalk, commander) unless explicitly requested. Keep the runtime footprint zero-overhead.

---

## 3. Architecture & File Structure

```text
softscope/
├── bin/
│   └── softscope.js          # CLI entry point (#!/usr/bin/env node)
├── src/
│   ├── cli.js                # CLI entry dispatcher, --help, and --version
│   ├── config.js             # CLI argument parser (options object builder)
│   ├── runner.js             # Child process spawner, IPC server, session cleanup, output dispatch
│   ├── loader/
│   │   ├── register.js       # Preloaded via NODE_OPTIONS="--import=...", sets up runtime collector & CJS hook
│   │   └── hooks.mjs         # Node ESM module customization hook (module.register)
│   ├── instrument/
│   │   ├── parse.js          # OXC parser wrapper & source locator (line/col indexing)
│   │   ├── registry.js       # Discovers functions (declarations, expressions, arrows, methods) with contextual names
│   │   ├── filter.js         # Path filtering (boundary checks, node_modules, include/exclude globs)
│   │   └── transform.js      # Surgical try...finally injection (__softscope.enter / exit)
│   ├── runtime/
│   │   ├── collector.js      # TypedArray-backed zero-allocation metric storage (calls, durations, errors)
│   │   ├── stack.js          # Call stack management, self-time calculation, caller-callee edge tracking
│   │   └── session.js        # IPC client (heartbeat) and process exit dump writer (proc-<pid>-<time>.json)
│   ├── vite/
│   │   ├── index.js          # Vite plugin factory (virtual module resolution, HTML injection, transform)
│   │   ├── client.js         # Browser client singleton (window.__softscope API, snapshot, reset)
│   │   └── overlay.js        # Zero-dependency in-browser floating HUD badge & ShadowRoot diagnostics drawer
│   ├── autobench/
│   │   ├── analyze.js        # AST candidate function and parameter analyzer
│   │   ├── seeds.js          # Seed synthesis, captured seed loader, and boundary mutation fuzzer
│   │   ├── harness.js        # Synthetic benchmark executor, latency cliff and crash detector
│   │   └── report.js         # Multi-format report renderers for auto-bench results
│   └── report/
│       ├── compare.js        # Performance comparison engine and delta report renderers
│       ├── format.js         # Duration/number formatters and terminal table rendering
│       ├── markdown.js       # GitHub Flavored Markdown (GFM) report generator
│       ├── ai.js             # Token-efficient LLM diagnostics and actionable directives
│       ├── tui.js            # Zero-dependency interactive ANSI terminal dashboard
│       ├── json.js           # Version 1 JSON schema exporter
│       ├── live.js           # Periodic live stderr status reporter for --live mode
│       └── summary.js        # Multi-process dump aggregator and runtime reach calculator
├── test/
│   ├── autobench.test.js     # Auto-bench, seed synthesis, and edge-case fuzzing tests
│   ├── cli.test.js           # CLI end-to-end and exit code propagation tests
│   ├── collector.test.js     # Unit tests for TypedArray accumulator & stack edge calculations
│   ├── compare.test.js       # Unit and CLI tests for baseline capture, compare & threshold gating
│   ├── filter.test.js        # Path filter and glob boundary tests
│   ├── markdown.test.js      # Markdown table formatting & CLI flag tests
│   ├── tui.test.js           # Interactive TUI state machine and rendering tests
│   ├── parse.test.js         # OXC parsing & anonymous function naming heuristics tests
│   ├── transform.test.js     # Surgical AST code rewriting & semantics preservation tests
│   └── vite.test.js          # Vite plugin hooks, virtual module, HTML injection & browser client tests
├── fixtures/                 # Test sample applications (simple, error, autobench, npm-script)
├── bench/
│   ├── run.js                # Micro-benchmark comparing baseline vs Softscope instrumentation overhead
│   └── target.js             # High-frequency function call benchmark target
└── demo/                     # Standalone sample demo application with mock services
```

---

## 4. Invariants & Critical Behavioral Rules

When modifying or extending this codebase, adhere to these rules:

1. **Child Process Transparency**:
   - Softscope wraps target processes using `node:child_process.spawn`.
   - Never tamper with `child.stdio` unless explicitly piped.
   - Always forward termination signals (`SIGINT`, `SIGTERM`, `SIGHUP`) to the child process.
   - Child process exit code must be propagated accurately (including non-zero exits and fatal error signals).

2. **Zero-Allocation Runtime Collector**:
   - The runtime collector (`src/runtime/collector.js`) is executed on hot execution paths inside the user's application.
   - It utilizes pre-allocated `Uint32Array` and `Float64Array` buffers. Avoid allocating temporary objects or arrays on function entry/exit.

3. **No Web UI / No HTTP Dashboard**:
   - The interactive web UI and HTTP/SSE server were intentionally removed in favor of direct CLI terminal and GitHub Flavored Markdown reports.
   - Do **not** re-introduce web servers or UI dependencies.

4. **Reporting & Comparison Conventions**:
   - Default output: Terminal tables (`renderTerminalReport`).
   - TUI output: Triggered by `--tui` using zero-dependency native ANSI terminal buffers (`createTui`).
   - AI / LLM output: Triggered by `--ai`, `--llm`, or when `--output` specifies `.ai` or `.llm` (`renderAiReport`).
   - Markdown output: Triggered by `--md`, `--markdown`, or when `--output` specifies a `.md` extension (`renderMarkdownReport`).
   - JSON output: Triggered by `--json` or when `--output` specifies a `.json` extension (`renderJsonReport`).
   - Baseline capture: Triggered by `--save-baseline <file>`.
   - Performance comparison: Triggered by `--compare <file>` (or `--baseline <file>`) during execution, or via standalone `softscope compare <base.json> <curr.json>`.
   - Automated gating: Triggered by `--fail-on-regression <threshold%>` (exits with code 1 if any function regresses beyond threshold).
   - File-level summary: Included only when `--files` is explicitly supplied.

5. **Benchmark-First Focus**:
   - Softscope is designed as a companion tool for benchmark suites (e.g. `bench/run.js`, Mitata, Tinybench, micro-benchmarks).
   - Ensure overhead per call remains in the low hundreds of nanoseconds (~300–400 ns per instrumented call).

6. **Browser & Vite Plugin Isolation**:
   - The Vite plugin (`softscope/vite`) and in-browser overlay (`src/vite/overlay.js`) must strictly maintain zero external runtime dependencies.
   - The in-browser floating badge and slide-over diagnostics drawer must always be encapsulated in an isolated `ShadowRoot` to prevent host CSS contamination (e.g., Tailwind, CSS modules) in either direction.
   - The browser client exposes `window.__softscope` for programmatic inspection (`getSnapshot()`, `printReport()`, `getAiProfile()`, `reset()`, `toggleOverlay()`).


---

## 5. Development & Testing Commands

Run tests and verification before committing changes:

```bash
# Run all unit and integration tests
npm test

# Run overhead micro-benchmark
npm run bench

# Run a sample fixture with standard terminal output
softscope fixtures/simple/index.js

# Save a baseline JSON profile
softscope bench/run.js --save-baseline baseline.json

# Compare current benchmark execution against saved baseline
softscope bench/run.js --compare baseline.json

# Compare two saved profiles offline with Markdown output
softscope compare baseline.json current.json --md

# Run a sample fixture with AI/LLM diagnostic output
softscope fixtures/simple/index.js --ai

# Run a sample fixture with Markdown output
softscope fixtures/simple/index.js --md

# Run a sample fixture saving to a file
softscope fixtures/simple/index.js -o /tmp/report.md
```
