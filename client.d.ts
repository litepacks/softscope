import type { SoftscopeClient, SoftscopePluginOptions } from './index.js';

export function initSoftscopeClient(options?: SoftscopePluginOptions): SoftscopeClient;
export const client: SoftscopeClient | null;
export default client;
export type { SoftscopeClient, SoftscopePluginOptions };
