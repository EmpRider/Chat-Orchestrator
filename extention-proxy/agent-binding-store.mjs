// Restart-safe encrypted Agent capability bindings. Never stores chat content.
// A restored binding grants nothing until the Proxy verifies a live approved
// tab, the same browser session/incarnation, and its current ancestry.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createAgentBindingStore(directory) {
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'mcp-agent-bindings.bin');
  const keyFile=file+'.key';
  try{fs.writeFileSync(keyFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const key=fs.readFileSync(keyFile);
  if(key.length!==32)throw new Error('Agent binding encryption key is corrupt');

  const load=()=>{
    if(!fs.existsSync(file))return [];
    const content=fs.readFileSync(file);
    if(content.length<29||content.length>131072)
      throw new Error('Agent binding state has invalid size');
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,content.subarray(0,12));
    decipher.setAuthTag(content.subarray(12,28));
    const decoded=Buffer.concat([decipher.update(content.subarray(28)),decipher.final()]);
    const state=JSON.parse(decoded.toString('utf8'));
    if(state.schema!==1||!Array.isArray(state.bindings)||state.bindings.length>200)
      throw new Error('Invalid saved Agent binding schema');
    return state.bindings;
  };
  const save=(bindings)=>{
    if(!Array.isArray(bindings)||bindings.length>200)
      throw new Error('Agent binding limit reached');
    const payload=Buffer.from(JSON.stringify({schema:1,bindings:bindings.map((item)=>({
      browserSessionId:item.browserSessionId,tabId:item.tabId,
      incarnationId:item.incarnationId,routeHash:item.routeHash,
      agentId:item.agentId,agentCredential:item.agentCredential,
    }))}));
    if(payload.length>120000)throw new Error('Agent binding storage capacity exceeded');
    const nonce=crypto.randomBytes(12);
    const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
    const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]);
    const encrypted=Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]);
    const temp=file+'.'+crypto.randomUUID()+'.tmp';
    try {
      fs.writeFileSync(temp,encrypted,{flag:'wx',mode:0o600});
      fs.renameSync(temp,file);
    } finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
  };
  return Object.freeze({load,save});
}
