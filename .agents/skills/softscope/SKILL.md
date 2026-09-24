---
name: softscope
description: >-
  Use this skill to profile, benchmark, or observe JavaScript/TypeScript files, micro-benchmarks,
  test suites, or application scripts using Softscope. Provides procedures for measuring function
  call frequencies, total and self execution durations, caller-callee call graphs, runtime reach,
  and generating GitHub Flavored Markdown (--md), terminal tables, or versioned JSON reports.
---

# Softscope Profiling & Observability Skill

This skill guides the agent in profiling, benchmarking, and analyzing JavaScript/TypeScript runtime behavior using Softscope.

---

## 1. Quick Execution Workflows

Softscope wraps target processes transparently via native Node.js module customization hooks (`--import` and `module.register()`). It requires no application source modifications.

### Run a Single Script or Benchmark
```bash
# Token-efficient AI/LLM diagnostic profile (recommended for AI agents)
softscope bench/run.js --ai

# Terminal table output (default)
softscope bench/run.js

# Interactive Zero-Dependency TUI mode
softscope bench/run.js --tui

# GitHub Flavored Markdown output (ideal for PR comments and CI summaries)
softscope bench/run.js --md

# Export AI profile or Markdown directly to a file
softscope bench/run.js -o profile.ai
softscope bench/run.js -o BENCHMARK.md
```

### Run Baseline Capture & Performance Comparison
```bash
# Save execution metrics as a baseline profile
softscope bench/run.js --save-baseline baseline.json

# Compare current benchmark execution against saved baseline
softscope bench/run.js --compare baseline.json

# Compare with Markdown output (ideal for GitHub PR comments)
softscope bench/run.js --compare baseline.json --md

# Compare with AI diagnostic delta profile
softscope bench/run.js --compare baseline.json --ai

# Offline comparison of two existing profiles in CI
softscope compare baseline.json current.json --md

# CI gating: exit code 1 if any function regresses by > 10%
softscope bench/run.js --compare baseline.json --fail-on-regression 10
```

### Run Autonomous Micro-Benchmarking & Edge-Case Fuzzing
```bash
# Automatically benchmark all exported functions with fuzzing
softscope auto-bench src/math.js

# Benchmark with Markdown output (ideal for PR comments)
softscope auto-bench src/math.js --md

# Benchmark with AI diagnostic profile and directives
softscope auto-bench src/math.js --ai

# Capture real runtime argument seeds during tests, then replay in auto-bench
softscope npm test --capture-seeds
softscope auto-bench src/math.js --seeds seeds.json

# Benchmark with custom iterations and benchmark all functions
softscope auto-bench src/math.js --iterations 50000 --all
```

### Run NPM Scripts or Framework Runners
```bash
# Profile an npm test or vitest suite
softscope npm test --files

# Profile scripts using benchmark libraries (e.g. Mitata, Tinybench)
softscope node bench.js --md

# Profile CLI-based test/benchmark runners
softscope npx vitest bench

# Profile a long-running script with live telemetry on stderr
softscope --live demo/server.js
```

---

## 2. CLI Options Reference

| Flag | Purpose | Example |
| :--- | :--- | :--- |
| `auto-bench <file>` | Autonomous micro-benchmarking with AST analysis and edge-case fuzzing | `softscope auto-bench src/math.js` |
| `--capture-seeds [file]` | Records real function argument samples during test execution | `softscope npm test --capture-seeds` |
| `--seeds <file>` | Loads captured seeds for auto-benchmarking | `softscope auto-bench src/math.js --seeds seeds.json` |
| `--fuzz`, `--no-fuzz` | Enables or disables boundary/edge-case fuzzing during auto-bench | `softscope auto-bench src/math.js --no-fuzz` |
| `--iterations <n>` | Number of iterations per function in auto-bench (default: 10000) | `softscope auto-bench src/math.js --iterations 50000` |
| `--all` | Benchmarks all top-level functions (including unexported ones) | `softscope auto-bench src/math.js --all` |
| `--save-baseline <file>` | Saves execution profile as baseline JSON for future comparisons | `softscope bench.js --save-baseline base.json` |
| `--compare <file>`, `--baseline` | Compares current run against baseline JSON profile | `softscope bench.js --compare base.json` |
| `--fail-on-regression <n>` | Exits with code 1 if any function regresses by > n% (default: 10) | `softscope bench.js --compare base.json --fail-on-regression 15` |
| `compare <base> <curr>` | Standalone command to compare two saved JSON profiles offline | `softscope compare base.json curr.json --md` |
| `--ai`, `--llm` | Outputs token-efficient AI diagnostic profile with directives | `softscope app.js --ai` |
| `--tui` | Launches zero-dependency interactive Terminal User Interface | `softscope bench/run.js --tui` |
| `--md`, `--markdown` | Outputs report in GitHub Flavored Markdown to stdout | `softscope app.js --md` |
| `--output <file>`, `-o` | Saves report to file (`.ai`/`.llm` for AI, `.md` for Markdown, `.json` for JSON) | `softscope app.js -o report.ai` |
| `--json` | Outputs report as versioned JSON to stdout | `softscope app.js --json` |
| `--files` | Appends file-level function, execution, reach, and duration breakdown | `softscope app.js --files` |
| `--top <n>` | Limits top total time and most called tables (default: 10) | `softscope app.js --top 20` |
| `--live` | Emits live periodic progress metrics to stderr | `softscope app.js --live` |
| `--include <glob>` | Only instruments files matching the glob | `softscope app.js --include "src/**"` |
| `--exclude <glob>` | Excludes files matching the glob | `softscope app.js --exclude "test/**"` |
| `--include-node-modules` | Enables instrumentation inside `node_modules` | `softscope app.js --include-node-modules` |
| `--strict` | Fails immediately on parse or instrumentation errors | `softscope app.js --strict` |

---

## 3. Interpreting Softscope Metrics

### Self-Time vs Total Duration
- **Total Time (`totalDurationMs`)**: The overall time elapsed between function entry and exit.
- **Self-Time (`selfDurationMs`)**: Total duration minus all child calls executed while this function was on top of the call stack.
- **Diagnostic rule**: If a function has high Total Time but low Self-Time, it is a coordinator delegating work to children. If Self-Time is high, the function body itself is a bottleneck.

### Runtime Reach
- **Runtime Reach (`executedPercent`)**: Compares the number of functions discovered via static OXC parsing against the functions actually executed at runtime.
- **Untouched Functions**: Indicates dead code, unexercised error handlers, or benchmark iterations that failed to hit specific branches.

### Call Relationships
- **Caller -> Callee**: Tracks dynamic parent-child invocation edges and counts (e.g. `compute -> add x1,000,000`).
- Use this to detect accidental quadratic calls or redundant recursion in hot loops.

---

## 4. In-Browser Profiling & Vite Plugin (`softscope/vite`)

For web applications and client-side benchmarks, Softscope exports a zero-config Vite plugin:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import softscope from 'softscope/vite';

export default defineConfig({
  plugins: [
    softscope({
      // overlay: true (default: true)
      // position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
      // openHotkey: 'alt+s'
    })
  ]
});
```

### In-Browser HUD Features
- **Floating Badge**: Isolated in a `ShadowRoot`, live call count, duration, and status pulse.
- **Diagnostics Drawer (`Alt+S` / `Escape`)**: Bottlenecks ranked by self-time, high-frequency detection (>1k calls), call graph edges, untouched code reach.
- **1-Click AI Diagnostic Export**: "Copy AI Profile" copies token-efficient diagnosis and agent directives directly to clipboard.
- **Console API**: `window.__softscope.printReport()`, `getSnapshot()`, `getAiProfile()`, `reset()`, `toggleOverlay()`.
- **Version Compatibility**: Supports **Vite >= 4.0.0** (Vite 4.x, 5.x, 6.x+) across React, Vue, Svelte, Solid, and Vanilla TS/JS with full Tailwind CSS v3/v4 support.

---

## 5. Verification & Testing

Always verify Softscope after making code or instrumentation changes:

```bash
# Run the test suite (36 unit, CLI integration, and Vite plugin tests)
npm test

# Run the 1,000,000 function call overhead benchmark
npm run bench
```

