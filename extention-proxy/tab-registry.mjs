// Proxy-owned browser tab ancestry. The browser extension is the source of live
// tab/incarnation observations. Session-only registries are never persisted.
import fs from 'node:fs';
import path from 'node:path';

const positive = (id) => Number.isSafeInteger(id) && id > 0;
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function createTabRegistry(file, {sessionOnly = false} = {}) {
  const entries = new Map();
  const sessionEntries = new Map();
  let serial = Promise.resolve();
  let closed = false;
  if (!sessionOnly && fs.existsSync(file)) {
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) throw new Error('Tab registry exceeds size limit');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (disk.schema !== 1 || !Array.isArray(disk.tabs)) throw new Error('Unsupported tab registry; manual recovery required');
    for (const entry of disk.tabs) {
      if (!entry || !positive(entry.tabId) || !positive(entry.rootTabId) ||
          (entry.parentTabId !== null && !positive(entry.parentTabId)) ||
          !uuid(entry.incarnationId) || !uuid(entry.browserSessionId) ||
          !['chatgpt', 'claude', 'gemini'].includes(entry.site) ||
          (entry.parentTabId !== null && !uuid(entry.parentIncarnationId)) ||
          (entry.parentTabId === null ? entry.phase !== 'root' :
            !['prepared','started','uncertain','reattached'].includes(entry.phase)) ||
          entries.has(entry.tabId) || entries.size >= 200) {
        throw new Error('Corrupt tab registry; refusing to classify unknown tabs');
      }
      entries.set(entry.tabId, Object.freeze(entry));
    }
    for (const entry of entries.values()) {
      if (entry.parentTabId === null && entry.rootTabId !== entry.tabId) throw new Error('Root tab ancestry invalid');
      if (entry.parentTabId !== null && entry.parentTabId === entry.tabId) throw new Error('Self-parent tab');
      const seen = new Set();
      let node = entry;
      while (node?.parentTabId !== null) {
        if (seen.has(node.tabId)) throw new Error('Tab ancestry cycle');
        seen.add(node.tabId);
        node = entries.get(node.parentTabId);
        // Parents can be missing after intentional root closure. Do not promote
        // an orphan to a new root; retain lineage and hold new delegation.
        if (!node) break;
      }
    }
  }

  async function persist() {
    if (sessionOnly) return;
    const data = JSON.stringify({schema:1, tabs:[...entries.values()]});
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Tab registry full');
    await fs.promises.mkdir(path.dirname(file), {recursive:true});
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    let descriptor;
    try {
      descriptor = await fs.promises.open(tmp, 'wx', 0o600);
      await descriptor.writeFile(data);
      await descriptor.sync();
      await descriptor.close(); descriptor = null;
      await fs.promises.rename(tmp, file);
    } finally {
      await descriptor?.close().catch(()=>{});
      await fs.promises.unlink(tmp).catch(()=>{});
    }
  }

  function tableFor(sessionId) {
    if (!sessionOnly || !sessionId) return entries;
    let table=sessionEntries.get(sessionId);
    if (!table) {table=new Map();sessionEntries.set(sessionId,table);}
    return table;
  }

  function observed(inspection) {
    if (!inspection || !positive(inspection.tab_id) || !uuid(inspection.incarnation_id) ||
        !uuid(inspection.browser_session_id) ||
        !['chatgpt','claude','gemini'].includes(inspection.site)) {
      throw new Error('A live supported browser tab and incarnation are required');
    }
    return inspection;
  }

  function registerRoot(inspection) {
    const live = observed(inspection);
    const table=tableFor(live.browser_session_id);
    const old = table.get(live.tab_id);
    if (old) {
      if (old.browserSessionId !== live.browser_session_id ||
          old.incarnationId !== live.incarnation_id || old.site !== live.site) {
        throw new Error('Tab ID reused or browser session changed; reconcile before continuing');
      }
      return old;
    }
    if (live.is_managed_worker) throw new Error('Unregistered worker cannot be promoted to orchestrator');
    if (table.size >= 200) throw new Error('Tab registry full');
    const record = Object.freeze({tabId:live.tab_id,parentTabId:null,rootTabId:live.tab_id,
      incarnationId:live.incarnation_id,browserSessionId:live.browser_session_id,site:live.site,
      phase:'root'});
    table.set(record.tabId,record);
    return record;
  }

  function reconcileRoot(inspection, expectedIncarnationId) {
    const live=observed(inspection);
    const table=tableFor(live.browser_session_id);
    const old=table.get(live.tab_id);
    if (!old || old.parentTabId !== null || old.phase !== 'root' ||
        live.is_managed_worker || old.rootTabId !== old.tabId ||
        old.browserSessionId !== live.browser_session_id ||
        old.site !== live.site || old.incarnationId !== expectedIncarnationId ||
        [...table.values()].some((entry)=>entry.parentTabId === old.tabId)) {
      throw new Error('Root reconciliation refused: registry ancestry/session changed');
    }
    const updated=Object.freeze({...old,incarnationId:live.incarnation_id});
    table.set(updated.tabId,updated);
    return updated;
  }

  function registerChild(parentId, inspection) {
    const live = observed(inspection);
    const table=tableFor(live.browser_session_id);
    const parent = table.get(parentId);
    if (!parent) throw new Error('Parent tab was not registered');
    // Never extend an orphaned or changed ancestry chain.
    let ancestor = parent;
    const visited = new Set();
    while (ancestor.parentTabId !== null) {
      if (visited.has(ancestor.tabId)) throw new Error('Parent ancestry cycle');
      visited.add(ancestor.tabId);
      const next = table.get(ancestor.parentTabId);
      if (!next || next.incarnationId !== ancestor.parentIncarnationId)
        throw new Error('Parent ancestry requires manual reconciliation');
      ancestor = next;
    }
    if (ancestor.tabId !== parent.rootTabId) throw new Error('Root ancestry mismatch');
    const existing = table.get(live.tab_id);
    if (existing) {
      if (existing.parentTabId !== parentId || existing.incarnationId !== live.incarnation_id ||
          existing.browserSessionId !== live.browser_session_id || existing.site !== live.site)
        throw new Error('Child tab collision or parent change');
      return existing;
    }
    if (parent.tabId === live.tab_id || table.size >= 200 || live.is_managed_worker !== true)
      throw new Error('Invalid or unowned child tab');
    if (parent.browserSessionId !== live.browser_session_id)
      throw new Error('Parent and child browser sessions differ');
    const record = Object.freeze({tabId:live.tab_id,parentTabId:parentId,rootTabId:parent.rootTabId,
      incarnationId:live.incarnation_id,browserSessionId:live.browser_session_id,site:live.site,
      parentIncarnationId:parent.incarnationId,phase:'prepared'});
    table.set(record.tabId,record);
    return record;
  }

  function within(callerId, targetId, sessionId) {
    const table=tableFor(sessionId);
    let node = table.get(targetId);
    const seen = new Set();
    while (node && !seen.has(node.tabId)) {
      if (node.tabId === callerId) return true;
      seen.add(node.tabId);
      const next = node.parentTabId === null ? null : table.get(node.parentTabId);
      if (next && next.incarnationId !== node.parentIncarnationId) break;
      node = next;
    }
    return false;
  }

  function directChild(parentId, childId, sessionId) {
    const table=tableFor(sessionId);
    const child = table.get(childId);
    const parent = table.get(parentId);
    return Boolean(parent && child && child.parentTabId === parentId &&
      child.parentIncarnationId === parent.incarnationId);
  }

  function hasChildren(tabId, sessionId) {
    return [...tableFor(sessionId).values()].some((entry)=>entry.parentTabId===tabId);
  }

  function setPhase(tabId, phase, sessionId) {
    const table=tableFor(sessionId);
    const current = table.get(tabId);
    if (!current || current.parentTabId === null) throw new Error('Unknown worker tab');
    const allowed = {
      prepared:['started','uncertain','reattached'],
      started:['prepared','uncertain'],
      reattached:['prepared','uncertain'],
      uncertain:[],
    };
    if (phase !== current.phase && !allowed[current.phase]?.includes(phase))
      throw new Error('Worker phase requires manual reconciliation');
    const updated = Object.freeze({...current,phase});
    table.set(tabId,updated);
    return updated;
  }

  function mutate(action, sessionId) {
    const operation = serial.then(async () => {
      if (closed) throw new Error('Tab registry session is closed');
      const table=tableFor(sessionId);
      const previous = new Map(table);
      try { const result = action(); await persist(); return result; }
      catch (error) { table.clear(); for(const [id,e] of previous)table.set(id,e); throw error; }
    });
    serial = operation.catch(()=>{});
    return operation;
  }

  return Object.freeze({
    get: (id,sessionId)=>sessionId ? tableFor(sessionId).get(id)||null
      : entries.get(id) || [...sessionEntries.values()].map((table)=>table.get(id))
        .find((entry)=>entry) || null,
    list: (sessionId)=>sessionId ? [...tableFor(sessionId).values()]
      : [...entries.values(),...[...sessionEntries.values()].flatMap((table)=>[...table.values()])],
    within,
    directChild,
    hasChildren,
    setPhase:(tabId,phase,sessionId)=>mutate(()=>setPhase(tabId,phase,sessionId),sessionId),
    registerRoot:(inspection)=>mutate(()=>registerRoot(inspection),inspection.browser_session_id),
    reconcileRoot:(inspection,expectedIncarnationId)=>mutate(()=>
      reconcileRoot(inspection,expectedIncarnationId),inspection.browser_session_id),
    registerChild:(parentId,inspection)=>mutate(()=>registerChild(parentId,inspection),
      inspection.browser_session_id),
    // Intentional closure removes one record. Descendants stay orphaned and
    // cannot silently become roots; their saved parent link remains visible.
    remove:(id,sessionId)=>mutate(()=>tableFor(sessionId).delete(id),sessionId),
    // Wait for all queued mutations before dropping volatile ownership.
    // Calling this on a persistent registry does NOT delete its ledger.
    closeSession: async () => {
      closed = true;
      await serial;
      entries.clear();
      sessionEntries.clear();
    },
  });
}

// The proxy must use this constructor. Every new proxy process/session starts
// empty, even if an older build left tab-relations.json on disk.
export function createSessionTabRegistry() {
  return createTabRegistry(null,{sessionOnly:true});
}
