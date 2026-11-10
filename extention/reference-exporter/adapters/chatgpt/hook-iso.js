/**
 * Isolated-world half of the chatgpt token hook. Loaded at document_start
 * (same time as hook-main.js's main-world counterpart) so the CustomEvent
 * listener is in place before the SPA fires its first authenticated request.
 *
 * Caches captured tokens on self.__exporterChatGPT.token; api.js reads from
 * the same isolated-world namespace at export time.
 */
(function () {
  document.addEventListener('exporter:chatgpt-token', (ev) => {
  // MAIN-world request telemetry is transferred as counts/timestamps only.
  // The isolated-world consumer never receives URLs, bodies, or auth tokens.
  const network = self.__chatOrchNetwork = {
    pendingRequests:0,lastNetworkActivityAt:Date.now(),
    observedRequests:0,observed:false,
  };
  document.addEventListener('chat-orch:network-state', (event) => {
    const state = event?.detail;
    if (!state || !Number.isSafeInteger(state.pendingRequests) ||
        state.pendingRequests < 0 ||
        !Number.isSafeInteger(state.lastNetworkActivityAt) ||
        !Number.isSafeInteger(state.observedRequests)) return;
    network.pendingRequests = state.pendingRequests;
    network.lastNetworkActivityAt = state.lastNetworkActivityAt;
    network.observedRequests = state.observedRequests;
    network.observed = true;
  });
  // A synchronous snapshot closes the main-world/isolated-world injection race.
  document.dispatchEvent(new Event('chat-orch:network-state-request'));

    const tok = ev && ev.detail;
    if (typeof tok === 'string' && tok) {
      const store = (self.__exporterChatGPT = self.__exporterChatGPT || {});
      store.token = tok;
    }
  });
})();
