// Durable, user-mediated tab closure decisions. No transcript storage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX=200;
export function createClosureStore(file,{now=()=>Date.now()}={}) {
  let records=[];
  if(fs.existsSync(file)){
    const bytes=fs.readFileSync(file);
    if(bytes.length>262144) throw new Error('Closure decision journal size exceeded');
    const saved=JSON.parse(bytes.toString('utf8'));
    if(saved.schema!==1 || !Array.isArray(saved.records) || saved.records.length>MAX)
      throw new Error('Invalid closure decision journal; manual inspection required');
    records=saved.records.map((r)=>{
      if(!UUID.test(r.id)||!UUID.test(r.browser_session_id)||
          !Number.isSafeInteger(r.old_tab_id)||r.old_tab_id<=0||
          !['pending','restoring','failed','resolved'].includes(r.phase)||
          !['parent','child'].includes(r.role))
        throw new Error('Invalid closure decision record; refusing unsafe recovery');
      return r;
    });
  }
  function persist(){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.'+crypto.randomUUID()+'.tmp';
    try {
      fs.writeFileSync(tmp,JSON.stringify({schema:1,records}),{flag:'wx',mode:0o600});
      const handle=fs.openSync(tmp,'r');
      try {
        try{fs.fsyncSync(handle);}
        catch(error) {
          // Some Windows filesystems/AV policies deny fsync on an otherwise
          // writable file. Atomic rename still protects against torn JSON,
          // but does not promise power-loss durability on that platform.
          if(process.platform!=='win32'||error.code!=='EPERM')throw error;
        }
      } finally {fs.closeSync(handle);}
      fs.renameSync(tmp,file);
    }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  }
  const pending=()=>records.filter((r)=>r.phase!=='resolved').map((r)=>structuredClone(r));
  function record(input){
    if(!UUID.test(input.browser_session_id)||!Number.isSafeInteger(input.old_tab_id)||
       input.old_tab_id<=0||!UUID.test(input.incarnation_id)||
       !['parent','child'].includes(input.role))
      throw new Error('Invalid browser closure observation');
    const existing=records.find((r)=>r.browser_session_id===input.browser_session_id&&
      r.old_tab_id===input.old_tab_id&&r.incarnation_id===input.incarnation_id);
    if(existing)return structuredClone(existing);
    if(records.filter((r)=>r.phase!=='resolved').length>=MAX)
      throw new Error('Too many pending browser closure decisions');
    const item={id:crypto.randomUUID(),phase:'pending',created_at:now(),
      browser_session_id:input.browser_session_id,old_tab_id:input.old_tab_id,
      incarnation_id:input.incarnation_id,role:input.role,
      parent_tab_id:input.parent_tab_id??null,
      site:input.site||'chatgpt',url:input.url||null,
      title:String(input.title||'Chat Agent').slice(0,160),
      descendants:Array.isArray(input.descendants)?input.descendants.slice(0,200):[],
      active_descendants:Array.isArray(input.active_descendants)?
        input.active_descendants.slice(0,200):[],
      outcome:null};
    records.push(item);persist();return structuredClone(item);
  }
  function get(id){return records.find((r)=>r.id===id)||null;}
  function begin(id,action){
    const record=get(id);
    if(!record||record.phase==='resolved')throw new Error('Unknown or resolved closure decision');
    if(record.phase==='restoring')throw new Error('Restoration already in progress');
    if(!['Accident','Yes','Cancel'].includes(action))throw new Error('Invalid closure decision');
    if(now()-record.created_at<5000)
      throw new Error('Closure decision buttons remain disabled for the first five seconds');
    record.phase='restoring';record.requested_action=action;persist();
    return structuredClone(record);
  }
  function finish(id,{outcome,error=null,result=null}){
    const record=get(id);
    if(!record||record.phase!=='restoring')throw new Error('Closure decision is not in progress');
    record.phase=error?'failed':'resolved';
    record.outcome=outcome;record.error=error?String(error).slice(0,500):null;
    record.result=result;record.finished_at=now();persist();return structuredClone(record);
  }
  function retry(id){
    const record=get(id);
    if(!record||!['failed','restoring'].includes(record.phase))
      throw new Error('Closure decision is not recoverable');
    record.phase='pending';delete record.requested_action;persist();
    return structuredClone(record);
  }
  return Object.freeze({record,pending,begin,finish,retry,get:(id)=>structuredClone(get(id))});
}
