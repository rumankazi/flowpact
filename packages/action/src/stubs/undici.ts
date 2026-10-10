/**
 * Stands in for undici in the bundle. @actions/http-client imports its ProxyAgent only for getAgentDispatcher(), a
 * dispatcher for fetch() behind a proxy, which neither the action nor @actions/core calls: their requests go through
 * http-client's own agents, which reach proxies with tunnel. So undici stays out of dist/index.js.
 */
export class ProxyAgent {
  constructor() {
    throw new Error(
      'undici is not part of the flowpact action: @actions/http-client getAgentDispatcher() is not available',
    );
  }
}
