import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASE_API,versionParts,isNewerVersion,verifiedRelease,
  checkLatestRelease,evaluateUpdateReadiness,stillApprovedRelease} from '../desktop/update-policy.mjs';

const release=(tag='v0.1.4')=>({
  tag_name:tag,name:'Chat Orchestrator '+tag,
  draft:false,prerelease:false,
  html_url:'https://github.com/EmpRider/Chat-Orchestrator/releases/tag/'+tag,
});
test('trusted update discovery rejects older, prerelease and URL spoofing',async()=>{
  assert.deepEqual(versionParts('v1.20.3'),[1,20,3]);
  assert.equal(isNewerVersion('0.1.4','0.1.3'),true);
  assert.equal(isNewerVersion('0.1.3','0.1.3'),false);
  assert.equal(verifiedRelease(release('v0.1.2'),'0.1.3'),null);
  assert.equal(verifiedRelease({...release(),prerelease:true},'0.1.3'),null);
  assert.equal(verifiedRelease({...release(),html_url:'https://evil.example/update.exe'},'0.1.3'),null);
  assert.equal(verifiedRelease(release(),'0.1.3').version,'0.1.4');
  const result=await checkLatestRelease('0.1.3',{fetchImpl:async(url,options)=>{
    assert.equal(url,RELEASE_API);
    assert.match(options.headers.Accept,/github/);
    return {ok:true,json:async()=>release()};
  }});
  assert.equal(result.url,release().html_url);
});
test('deferred update rechecks publisher before opening the approved release',()=>{
  const original=verifiedRelease(release('v0.1.4'),'0.1.3');
  assert.equal(stillApprovedRelease('0.1.4',original,original),true);
  assert.equal(stillApprovedRelease('0.1.4',original,null),false);
  assert.equal(stillApprovedRelease('0.1.4',original,
    verifiedRelease(release('v0.1.5'),'0.1.3')),false);
  assert.equal(stillApprovedRelease('0.1.4',original,
    {...original,url:'https://example.invalid/release'}),false);
});
test('update remains pending until tasks, review, queue and browser inventory are verified',()=>{
  const now=Date.now();
  const clean={generatedAt:new Date(now).toISOString(),registryError:false,
    browserTabs:{status:'observed',observedAt:new Date(now).toISOString()},
    storageReady:true,hiddenPending:0,queue:[]};
  const ready={ready:true,blockers:[],checked_at:now};
  assert.equal(evaluateUpdateReadiness(ready,clean,{now}).ready,true);
  assert.equal(evaluateUpdateReadiness({...ready,ready:false,blockers:['Parent review']},clean,{now}).ready,false);
  assert.equal(evaluateUpdateReadiness({...ready,ready:false},clean,{now}).ready,false);
  assert.equal(evaluateUpdateReadiness(ready,
    {...clean,hiddenPending:1},{now}).ready,false);
  assert.equal(evaluateUpdateReadiness(ready,
    {...clean,queue:[{phase:'DELIVERED'}]},{now}).ready,false);
  assert.equal(evaluateUpdateReadiness(ready,
    {...clean,generatedAt:new Date(now-120000).toISOString()},{now}).ready,false);
  assert.equal(evaluateUpdateReadiness(ready,null,{now}).ready,false);
  assert.equal(evaluateUpdateReadiness({...ready,checked_at:now-16000},clean,{now}).ready,false);
  assert.equal(evaluateUpdateReadiness(ready,{
    ...clean,browserTabs:{status:'observed',observedAt:new Date(now-18000).toISOString()},
  },{now}).ready,false);
  assert.equal(evaluateUpdateReadiness(ready,{
    ...clean,browserTabs:{status:'observed',observedAt:new Date(now+12000).toISOString()},
  },{now}).ready,false);
});
