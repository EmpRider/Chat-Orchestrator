// Presentation-only browser presence. Saved registry entries are an ownership
// ledger, NOT proof that the tab is still open. Never mutate the registry or
// private journal to make the dashboard look clean.
const CHAT_SITES = new Set(['chatgpt', 'claude', 'gemini']);

export function normalizeOpenChatTabs(observed) {
  if (!Array.isArray(observed)) throw new TypeError('Browser tab discovery unavailable');
  const ids = new Set();
  const tabs = [];
  for (const item of observed) {
    const tabId = item?.tab_id;
    const browserSessionId=item?.browser_session_id;
    const key=(browserSessionId || '')+':'+tabId;
    if (!Number.isSafeInteger(tabId) || tabId <= 0 ||
        !CHAT_SITES.has(item.site) || ids.has(key)) continue;
    ids.add(key);
    tabs.push({tabId, site:item.site,...(browserSessionId ? {browserSessionId} : {})});
    if (tabs.length >= 500) break;
  }
  return tabs;
}

export function annotateTabPresence(registryEntries, observation) {
  const available = observation?.status === 'observed' &&
    Array.isArray(observation.tabs);
  const byId = available
    ? new Map(observation.tabs.map((tab)=>[(tab.browserSessionId || '')+':'+tab.tabId,tab]))
    : new Map();
  return (registryEntries || []).map((entry)=>{
    const observed = byId.get((entry.browserSessionId || '')+':'+entry.tabId);
    return {
      ...entry,
      presence: !available ? 'unknown' : !observed ? 'not_open'
        : observed.site !== entry.site ? 'site_mismatch' : 'open_unverified',
    };
  });
}
