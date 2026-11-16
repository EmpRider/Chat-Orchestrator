// Request-scoped MCP idempotency, deliberately memory-only: never persist
// read_chat responses or other conversation content to a transcript archive.
// The caller must supply a fresh UUID for a logically new read/operation and
// reuse the original UUID only when retrying the same logical request.
export function createIdempotencyLedger({capacity=2048}={}) {
  const responses=new Map();
  const canonical=(value)=>{
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value==='object') return Object.fromEntries(
      Object.keys(value).sort().map((key)=>[key,canonical(value[key])]));
    return value;
  };
  return {
    async execute(scope,method,args,operation) {
      const key=args?.idempotency_key;
      if (typeof key!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
        throw new Error('Every MCP call requires a fresh caller-generated idempotency_key UUID');
      if (typeof scope!=='string' || !scope)
        throw new Error('Stable caller context required for idempotency');
      const identity=JSON.stringify([scope,key]);
      const fingerprint=JSON.stringify(canonical({method,args}));
      const existing=responses.get(identity);
      if (existing) {
        if (existing.fingerprint!==fingerprint)
          throw new Error('Idempotency key was reused with a different tool request');
        return existing.result; // In-flight promise or the original response.
      }
      if (responses.size>=capacity)
        throw new Error('MCP idempotency ledger full; reconcile before sending new requests');
      // Reserve synchronously BEFORE executing a side effect.
      const entry={fingerprint,result:null};
      responses.set(identity,entry);
      entry.result=Promise.resolve().then(operation);
      return entry.result;
    },
    size:()=>responses.size,
  };
}
