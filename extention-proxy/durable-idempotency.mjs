// Encrypted, bounded operational response replay. Never a conversation archive:
// only user-requested MCP first-response snapshots and operation receipts.
// A write-ahead UNKNOWN marker precedes any side effect; after a crash UNKNOWN
// is returned for inspection, never silently executed a second time.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN=Object.freeze({isError:true,content:[{type:'text',
  text:'UNKNOWN: Original operation was accepted before a Proxy interruption. Inspect existing browser/task state; never automatically repeat its side effect.'}]});
const MAX_ITEM=512*1024; // one operational response, not unbounded chat archives
const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(
    Object.keys(value).sort()
      .filter((key)=>key!=='agent_credential')
      .map((key)=>[key,canonical(value[key])]));
  return value;
}
function encrypt(value,key) {
  const nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64');
}
function decrypt(value,key) {
  const payload=Buffer.from(value,'base64');
  if(payload.length<29)throw new Error('Corrupt idempotency entry');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,payload.subarray(0,12));
  decipher.setAuthTag(payload.subarray(12,28));
  return Buffer.concat([decipher.update(payload.subarray(28)),decipher.final()]).toString('utf8');
}
async function persistAtomic(file,data) {
  const temp=file+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  let handle;
  try {
    handle=await fs.open(temp,'wx',0o600);
    await handle.writeFile(JSON.stringify(data),'utf8');
    await handle.sync();
    await handle.close();handle=null;
    await fs.rename(temp,file);
  } finally {
    await handle?.close().catch(()=>{});
    await fs.unlink(temp).catch(()=>{});
  }
}

export async function createDurableIdempotencyLedger(file,{capacity=2048}={}) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const keyFile=file+'.key';
  let secret;
  try {await fs.writeFile(keyFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  secret=await fs.readFile(keyFile);
  if(secret.length!==32)throw new Error('Corrupt response replay encryption key');
  let entries=new Map(),serial=Promise.resolve();
  try {
    const content=await fs.readFile(file,'utf8');
    if(Buffer.byteLength(content)>32*1024*1024)throw new Error('Idempotency state exceeds bounds');
    const data=JSON.parse(content);
    if(data.schema!==1 || !Array.isArray(data.items) || data.items.length>capacity)
      throw new Error('Invalid idempotency state schema');
    for(const entry of data.items) {
      if(!entry || !/^[a-f0-9]{64}$/.test(entry.id) ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          !['UNKNOWN','COMPLETED'].includes(entry.status) ||
          (entry.status==='COMPLETED' && typeof entry.result!=='string') ||
          entries.has(entry.id)) throw new Error('Corrupt idempotency state');
      if(entry.status==='COMPLETED') {
        // Fail closed on corrupt ciphertext. Never discard saved operation
        // reservations and retry an action because encrypted data was lost.
        JSON.parse(decrypt(entry.result,secret));
      }
      entries.set(entry.id,entry);
    }
  } catch(error) {
    if(error.code!=='ENOENT')throw error;
  }
  const save=async()=>{
    const write=serial.then(()=>persistAtomic(file,{schema:1,
      items:[...entries.values()].map(({id,fingerprint,status,result})=>
        ({id,fingerprint,status,...(status==='COMPLETED'?{result}:{})}))}));
    serial=write.catch(()=>{});
    return write;
  };
  const inFlight=new Map();
  return Object.freeze({
    async execute(scope,method,args,operation) {
      if(typeof scope!=='string' || !scope || typeof method!=='string' ||
          !UUID.test(args?.idempotency_key||''))
        throw new Error('Valid logical Agent, method and UUID idempotency_key required');
      const id=hash(JSON.stringify([scope,args.idempotency_key]));
      const fingerprint=hash(JSON.stringify(canonical({method,args})));
      const prior=entries.get(id);
      if(prior) {
        if(prior.fingerprint!==fingerprint)
          throw new Error('Idempotency key reused with conflicting request arguments');
        if(inFlight.has(id))return inFlight.get(id);
        if(prior.status==='COMPLETED')return JSON.parse(decrypt(prior.result,secret));
        return UNKNOWN;
      }
      if(entries.size>=capacity)
        throw new Error('Operational replay capacity exhausted; reconcile or explicitly archive/clear old keys');
      // Reserve synchronously, before first await. All simultaneous duplicates
      // join the SAME promise and never start another browser operation.
      entries.set(id,{id,fingerprint,status:'UNKNOWN'});
      const running=(async()=>{
        await save(); // fsync a recoverable UNKNOWN before browser side effects
        const result=await operation();
        const text=JSON.stringify(result);
        if(Buffer.byteLength(text)>MAX_ITEM)
          throw new Error('First response exceeds bounded encrypted replay limit; operation outcome UNKNOWN');
        const encrypted=encrypt(text,secret);
        entries.set(id,{id,fingerprint,status:'COMPLETED',result:encrypted});
        await save();
        return result;
      })();
      inFlight.set(id,running);
      try{return await running;}
      finally{inFlight.delete(id);}
    },
    size:()=>entries.size,
  });
}
