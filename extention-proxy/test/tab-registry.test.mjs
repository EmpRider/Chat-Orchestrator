// Authoring-only coverage for the proxy tab hierarchy. Run in the final
// coordinated test pass, not while implementation is in progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createTabRegistry,createSessionTabRegistry} from '../tab-registry.mjs';

function observed(tabId, session, {managed=false,incarnation=randomUUID(),site='chatgpt'}={}) {
  return {tab_id:tabId,browser_session_id:session,incarnation_id:incarnation,
    is_managed_worker:managed,site};
}

test('proxy session registry starts empty and closes without persistent tab state',async()=>{
  const session=randomUUID();
  const first=createSessionTabRegistry();
  const root=observed(269061258,session);
  await first.registerRoot(root);
  await first.registerChild(269061258,observed(777777,session,{managed:true}));
  assert.equal(first.list().length,2);
  await first.closeSession();
  assert.deepEqual(first.list(),[],'shutdown removes all registered roots and workers');
  await assert.rejects(first.registerRoot(root),/session is closed/);
  const second=createSessionTabRegistry();
  assert.deepEqual(second.list(),[],'a new Proxy session cannot inherit old tabs');
  await second.registerRoot(observed(269061258,randomUUID()));
  assert.equal(second.list().length,1,'previous tab ID can safely be registered anew');
  await second.closeSession();
});

test('session registry isolates reused numeric tab IDs across browser profiles',async()=>{
  const registry=createSessionTabRegistry();
  const a=randomUUID(),b=randomUUID();
  const rootA=observed(101,a),rootB=observed(101,b);
  const childA=observed(202,a,{managed:true}),childB=observed(202,b,{managed:true});
  await registry.registerRoot(rootA);
  await registry.registerRoot(rootB);
  await registry.registerChild(101,childA);
  await registry.registerChild(101,childB);
  await registry.setPhase(202,'started',a);
  assert.equal(registry.get(101,a).incarnationId,rootA.incarnation_id);
  assert.equal(registry.get(101,b).incarnationId,rootB.incarnation_id);
  assert.equal(registry.get(202,a).phase,'started');
  assert.equal(registry.get(202,b).phase,'prepared');
  assert.equal(registry.directChild(101,202,a),true);
  assert.equal(registry.directChild(101,202,b),true);
  assert.equal(registry.list(a).length,2);
  assert.equal(registry.list(b).length,2);
  await registry.closeSession();
});

test('session registry ignores legacy files and preserves FIFO files untouched',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'session-registry-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const oldFile=path.join(dir,'tab-relations.json');
  const journal=path.join(dir,'coordination.events.journal');
  const previous=createTabRegistry(oldFile);
  await previous.registerRoot(observed(101,randomUUID()));
  fs.writeFileSync(journal,'historical FIFO journal retained');
  const oldBytes=fs.readFileSync(oldFile);
  const session=createSessionTabRegistry();
  assert.deepEqual(session.list(),[]);
  await session.registerRoot(observed(202,randomUUID()));
  await session.closeSession();
  assert.deepEqual(fs.readFileSync(oldFile),oldBytes,
    'historical file is not imported or erased by volatile registration');
  assert.equal(fs.readFileSync(journal,'utf8'),'historical FIFO journal retained');
});

test('proxy registry persists independent roots, children and grandchildren',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tab-relations-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'relations.json');
  const session=randomUUID();
  const registry=createTabRegistry(file);
  const rootA=observed(101,session);
  const childA=observed(102,session,{managed:true});
  const grandchildA=observed(103,session,{managed:true});
  const rootB=observed(201,session);
  const childB=observed(202,session,{managed:true,site:'claude'});
  await registry.registerRoot(rootA);
  await registry.registerChild(101,childA);
  await registry.registerChild(102,grandchildA);
  await registry.registerRoot(rootB);
  await registry.registerChild(201,childB);
  assert.equal(registry.get(101).parentTabId,null);
  assert.equal(registry.get(103).parentTabId,102);
  assert.equal(registry.get(103).rootTabId,101);
  assert.equal(registry.get(101).phase,'root');
  assert.equal(registry.get(102).phase,'prepared');
  await registry.setPhase(102,'started');
  await registry.setPhase(103,'uncertain');
  await assert.rejects(registry.setPhase(103,'prepared'),/manual reconciliation/);
  assert.equal(registry.get(202).rootTabId,201);
  assert.equal(registry.directChild(101,102),true);
  assert.equal(registry.directChild(102,103),true);
  assert.equal(registry.directChild(101,103),false);
  assert.equal(registry.within(101,103),true);
  assert.equal(registry.within(201,103),false);
  assert.equal(registry.hasChildren(102),true);
  const restored=createTabRegistry(file);
  assert.equal(restored.get(102).phase,'started');
  assert.equal(restored.get(103).phase,'uncertain');
  assert.equal(restored.get(103).parentIncarnationId,childA.incarnation_id);
  assert.equal(restored.directChild(102,103),true);
  assert.equal(restored.within(201,103),false);
});

test('root registration rejects workers; stale identities and cross-tree reparenting fail closed',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tab-relations-denial-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const registry=createTabRegistry(path.join(dir,'relations.json'));
  const session=randomUUID();
  const a=observed(1,session);
  const b=observed(2,session);
  const child=observed(3,session,{managed:true});
  await assert.rejects(registry.registerRoot(child),/worker cannot be promoted/);
  await registry.registerRoot(a);
  await registry.registerRoot(b);
  await registry.registerChild(1,child);
  await assert.rejects(registry.registerChild(2,child),/parent change/);
  await assert.rejects(registry.registerRoot(observed(1,session)),/reused/);
  await assert.rejects(registry.registerRoot(observed(1,randomUUID(),{incarnation:a.incarnation_id})),/reused/);
  await assert.rejects(registry.registerChild(2,observed(4,randomUUID(),{managed:true})),/sessions differ/);
  await registry.remove(1);
  await assert.rejects(registry.registerChild(3,observed(5,session,{managed:true})),/reconciliation/);
  assert.equal(registry.get(3).rootTabId,1,'orphan must not be silently promoted');
});

test('explicit clean-root reconciliation updates only its incarnation and persists',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tab-repair-clean-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'registry.json');
  const s=randomUUID(),old=observed(50,s),next=observed(50,s);
  const registry=createTabRegistry(file);
  await registry.registerRoot(old);
  await assert.rejects(registry.reconcileRoot(next,randomUUID()),/reconciliation refused/i);
  assert.equal(registry.get(50).incarnationId,old.incarnation_id);
  await registry.reconcileRoot(next,old.incarnation_id);
  assert.equal(registry.get(50).incarnationId,next.incarnation_id);
  assert.equal(createTabRegistry(file).get(50).incarnationId,next.incarnation_id);
  await assert.rejects(registry.reconcileRoot(observed(50,randomUUID()),next.incarnation_id),
    /reconciliation refused/i);
  await assert.rejects(registry.reconcileRoot(observed(50,s,{managed:true}),next.incarnation_id),
    /reconciliation refused/i);
});
test('root reconciliation refuses any live descendant and preserves original tree',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tab-repair-descendant-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const registry=createTabRegistry(path.join(dir,'registry.json'));
  const session=randomUUID(),root=observed(70,session);
  await registry.registerRoot(root);
  await registry.registerChild(70,observed(71,session,{managed:true}));
  await assert.rejects(registry.reconcileRoot(observed(70,session),root.incarnation_id),
    /reconciliation refused/i);
  assert.equal(registry.get(70).incarnationId,root.incarnation_id);
  assert.equal(registry.get(71).parentTabId,70);
});
test('corrupt registry stops startup rather than fabricating ownership',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tab-relations-corrupt-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'relations.json');
  fs.writeFileSync(file,'{"schema":1,"tabs":[{"tabId":0}]}');
  assert.throws(()=>createTabRegistry(file),/Corrupt tab registry/);
});