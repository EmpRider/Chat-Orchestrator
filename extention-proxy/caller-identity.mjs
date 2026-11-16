// Explicit browser-tab/Agent binding using a one-time extension offer and
// an opaque per-Agent capability. HTTP/MCP metadata cannot prove the
// originating browser tab, so no authorization depends on openai/session.
import crypto from 'node:crypto';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/i;
const TTL_MS=180_000;

export function createCallerIdentity({now=()=>Date.now(),onChange=()=>{}}={}) {
  const offers=new Map();
  const credentials=new Map(); // random capability -> immutable binding
  const sessions=new Map(); // optional metadata for diagnostics, never authority
  const tabs=new Map(); // browser session/tab/incarnation -> credential
  const sessionKey=(subject,session)=>JSON.stringify([subject||'',session]);
  const tabKey=(item)=>[item.browserSessionId,item.tabId,item.incarnationId].join(':');
  function revoke(credential) {
    const prior=credentials.get(credential);
    if (!prior) return false;
    credentials.delete(credential);
    if (tabs.get(tabKey(prior))===credential) tabs.delete(tabKey(prior));
    for (const [key,value] of sessions)
      if (value.agentCredential===credential) sessions.delete(key);
    onChange([...credentials.values()]);
    return true;
  }
  function offer({code,browserSessionId,tabId,incarnationId,routeHash,socket}) {
    if (!ID.test(code||'') || !ID.test(browserSessionId||'') ||
        !ID.test(incarnationId||'') || !Number.isSafeInteger(tabId) ||
        tabId<=0 || !HASH.test(routeHash||'') || !socket)
      throw new Error('Invalid browser pairing offer');
    for (const [key,item] of offers)
      if (item.expiresAt<=now() ||
          (item.browserSessionId===browserSessionId && item.tabId===tabId))
        offers.delete(key);
    if (offers.size>=100) throw new Error('Too many pending browser pairing offers');
    if (offers.has(code)) throw new Error('Duplicate pairing offer');
    offers.set(code,{browserSessionId,tabId,incarnationId,routeHash,socket,
      expiresAt:now()+TTL_MS});
  }
  function peek(code) {
    const item=offers.get(code);
    if (!item || item.expiresAt<=now()) {
      offers.delete(code);
      throw new Error('Pairing code unavailable or expired; generate a new one in the extension');
    }
    return item;
  }
  function bind({code,session=null,subject=''}) {
    if (session!=null && (typeof session!=='string' || !session || session.length>512))
      throw new Error('Invalid optional MCP session metadata');
    if (typeof subject!=='string' || subject.length>512)
      throw new Error('Invalid optional MCP subject metadata');
    const item=peek(code);
    const sk=session ? sessionKey(subject,session) : null;
    const priorSession=sk && sessions.get(sk);
    if (priorSession && tabKey(priorSession)!==tabKey(item))
      throw new Error('MCP conversation already paired to another Agent tab');
    const existingCredential=tabs.get(tabKey(item));
    const existing=credentials.get(existingCredential);
    // Fresh explicit pairing rotates the capability without changing the
    // logical identity of this still-live Agent tab.
    const result=Object.freeze({
      ...item,socket:undefined,
      agentId:existing?.agentId||crypto.randomUUID(),
      agentCredential:crypto.randomBytes(32).toString('hex'),
    });
    offers.delete(code);
    if (existingCredential) revoke(existingCredential);
    credentials.set(result.agentCredential,result);
    tabs.set(tabKey(item),result.agentCredential);
    if (sk) sessions.set(sk,result);
    onChange([...credentials.values()]);
    return result;
  }
  function restore(list) {
    if(!Array.isArray(list)||list.length>200 || credentials.size)
      throw new Error('Invalid or repeated Agent binding restoration');
    for(const item of list) {
      if(!item || !ID.test(item.browserSessionId||'') ||
          !Number.isSafeInteger(item.tabId)||item.tabId<1 ||
          !ID.test(item.incarnationId||'') || !HASH.test(item.routeHash||'') ||
          !ID.test(item.agentId||'') || !HASH.test(item.agentCredential||'') ||
          credentials.has(item.agentCredential)||tabs.has(tabKey(item)))
        throw new Error('Corrupt saved Agent credential binding');
      const binding=Object.freeze({...item,socket:undefined});
      credentials.set(binding.agentCredential,binding);
      tabs.set(tabKey(binding),binding.agentCredential);
    }
  }
  const getByCredential=(credential)=>
    typeof credential==='string' && HASH.test(credential)
      ? credentials.get(credential)||null : null;
  const get=(session,subject='')=>
    typeof session==='string' && session
      ? sessions.get(sessionKey(subject,session))||null : null;
  function unpair(session,subject='') {
    const item=get(session,subject);
    return item ? revoke(item.agentCredential) : false;
  }
  function revokeTab(browserSessionId,tabId) {
    let revoked=0;
    for (const [credential,binding] of [...credentials]) {
      if(binding.browserSessionId===browserSessionId && binding.tabId===tabId) {
        if(revoke(credential)) revoked++;
      }
    }
    return revoked;
  }
  function disconnect(socket) {
    for (const [code,item] of offers)
      if (item.socket===socket) offers.delete(code);
    // Established credentials still require live tab/route inspection on use.
  }
  function clear({preserveBindings=false}={}) {
    offers.clear();sessions.clear();
    if(!preserveBindings) {
      credentials.clear();tabs.clear();
      onChange([]);
    }
  }
  return Object.freeze({offer,peek,bind,get,getByCredential,
    revokeCredential:revoke,revokeTab,unpair,disconnect,clear,restore});
}
