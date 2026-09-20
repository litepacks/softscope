/**
 * Configuration options for the Softscope Vite plugin.
 */
export interface SoftscopePluginOptions {
  /**
   * Whether to inject the floating HUD badge and slide-over diagnostics drawer into the browser page.
   * @default true
   */
  overlay?: boolean;

  /**
   * Screen position of the in-browser floating badge.
   * @default 'bottom-right'
   */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

  /**
   * Keyboard shortcut to toggle the slide-over diagnostics drawer.
   * @default 'alt+s'
   */
  openHotkey?: string;

  /**
   * Glob patterns or regular expressions for source files to instrument.
   */
  include?: Array<string | RegExp>;

  /**
   * Glob patterns or regular expressions for files to exclude from instrumentation.
   */
  exclude?: Array<string | RegExp>;

  /**
   * Whether to instrument files inside node_modules.
   * @default false
   */
  includeNodeModules?: boolean;
}

/**
 * Metadata and runtime metrics for a discovered function.
 */
export interface FunctionMetadata {
  id: number;
  file: string;
  name: string;
  line: number;
  column: number;
  type: string;
  async: boolean;
  generator: boolean;
  calls: number;
  totalDurationMs: number;
  selfDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  avgDurationMs: number;
  errors: number;
  inFlight: number;
  maxConcurrent: number;
}

/**
 * Caller-to-callee call graph edge.
 */
export interface CallGraphEdge {
  caller: string;
  callee: string;
  calls: number;
}

/**
 * Complete runtime snapshot of all observed metrics.
 */
export interface ProfileSnapshot {
  pid: number;
  threadId: number;
  startTime: number;
  durationMs: number;
  totalCalls: number;
  totalDiscovered: number;
  totalExecuted: number;
  functions: FunctionMetadata[];
  edges: CallGraphEdge[];
  files: Record<string, any>;
}

/**
 * Softscope client interface exposed in the browser on `window.__softscope`.
 */
export interface SoftscopeClient {
  /**
   * Records entry into a function by ID.
   */
  enter(id: number): void;

  /**
   * Records exit from a function by ID.
   */
  exit(id: number, isError?: boolean): void;

  /**
   * Registers discovered static function metadata for a file.
   */
  registerFile(file: string, functions: any[]): void;

  /**
   * Returns a structured JSON snapshot of all functions, execution metrics, and call graph edges.
   */
  getSnapshot(): ProfileSnapshot;

  /**
   * Returns a token-efficient diagnostic summary formatted with actionable directives for AI coding agents.
   */
  getAiProfile(): string;

  /**
   * Prints a formatted hotspot breakdown table to the browser DevTools console.
   */
  printReport(): void;

  /**
   * Resets all runtime metrics and TypedArray accumulators to zero for targeted profiling.
   */
  reset(): void;

  /**
   * Programmatically opens or closes the in-browser slide-over diagnostics drawer.
   */
  toggleOverlay(state?: boolean): void;

  /**
   * Internal collector instance.
   */
  _collector: any;

  /**
   * Internal overlay HUD instance.
   */
  _overlay: any;
}

/**
 * Minimal Vite/Rollup plugin interface.
 */
export interface VitePlugin {
  name: string;
  enforce?: 'pre' | 'post';
  [key: string]: any;
}

/**
 * Softscope Vite plugin factory for in-browser profiling and floating HUD overlay.
 */
export function softscope(options?: SoftscopePluginOptions): VitePlugin;

export default softscope;

declare global {
  var __softscope: SoftscopeClient | undefined;
  interface Window {
    __softscope?: SoftscopeClient;
  }
}
