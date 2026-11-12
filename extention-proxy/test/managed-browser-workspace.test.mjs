// Source-only regression coverage for the dedicated browser workspace.
// Do not execute until the owner's single coordinated E2E test round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = readFileSync(new URL('../../extention/background.js',import.meta.url),'utf8')
  .replace(/\nconnect\(\);\s*$/, '\n'); // No live WebSocket/reconnect timers in isolated unit tests.
const SESSION='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT_A='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOT_B='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function harness() {
  const tabs = new Map([
    [101,{id:101,url:'https://chatgpt.com/c/root-a',windowId:1}],
    [201,{id:201,url:'https://claude.ai/chat/root-b',windowId:2}],
  ]);
  const windows = new Map([[1,{id:1,type:'normal'}],[2,{id:2,type:'normal'}]]);
  const groups = new Map();
  const storage={browserSessionId:SESSION,managerIncarnations:{101:ROOT_A,201:ROOT_B}};
  const events={windowCreates:0,tabCreates:0,tabFocuses:0,groupCreates:0,startupSequence:[],
    transientFocusFailures:0};
  let nextTabId=300,nextWindowId=10,nextGroupId=1;
  const runtime={getURL:(file)=>'chrome-extension://unit-extension/'+file,
    onInstalled:{addListener(){}},onStartup:{addListener(){}},
    onMessage:{addListener(){}}};
  const chrome={
    runtime,
    storage:{session:{get:async()=>storage,set:async(data)=>Object.assign(storage,data)},
      local:{get:async()=>({orchestratorTabId:101})},onChanged:{addListener(){}}},
    tabs:{
      get:async(id)=>tabs.get(id) || null,
      query:async(filter={})=>[...tabs.values()].filter((tab)=>
        (filter.windowId==null || tab.windowId===filter.windowId) &&
        (filter.groupId==null || tab.groupId===filter.groupId)),
      create:async({windowId,url,active})=>{
        assert.equal(active,false);
        assert.ok(windows.has(windowId));
        const tab={id:nextTabId++,windowId,url,active,groupId:-1};
        events.tabCreates++;
        events.startupSequence.push('create:'+tab.id);
        if(active)events.tabFocuses++;
        tabs.set(tab.id,tab);
        return tab;
      },
      update:async(id,{url,active})=>{const tab=tabs.get(id);if(!tab)throw Error('missing worker tab');
        if(active===true && events.transientFocusFailures>0) {
          events.transientFocusFailures--;
          throw Error('Tabs cannot be edited right now (user may be dragging a tab).');
        }
        if(url){events.startupSequence.push('navigate:'+id);tab.url=url;tab.status='complete';}
        if(active===true){for(const item of tabs.values())if(item.windowId===tab.windowId)item.active=false;
          tab.active=true;events.startupSequence.push('focus:'+id);events.tabFocuses++;}
        return tab;},
      group:async({tabIds,groupId,createProperties})=>{
        assert.equal(tabIds.length,1);
        const tab=tabs.get(tabIds[0]);
        if(groupId==null){
          assert.equal(createProperties?.windowId,undefined,
            'new groups inherit their already-created managed tab window');
          groupId=nextGroupId++;
          groups.set(groupId,{id:groupId,windowId:tab.windowId,title:''});
          events.groupCreates++;
        }
        assert.equal(groups.get(groupId)?.windowId,tab.windowId);
        tab.groupId=groupId;
        return groupId;
      },
      remove:async(id)=>{tabs.delete(id);},
      onRemoved:{addListener(){}},onUpdated:{addListener(){}},
    },
    windows:{
      update:async(id,patch)=>{assert.ok(windows.has(id));events.startupSequence.push('windowFocus:'+id);return {...windows.get(id),...patch};},
      get:async(id)=>windows.get(id)||null,
      create:async({url,focused,type})=>{
        assert.equal(focused,false);
        assert.equal(type,'normal');
        const window={id:nextWindowId++,type};
        windows.set(window.id,window);
        const tab={id:nextTabId++,windowId:window.id,url,active:true,groupId:-1};
        tabs.set(tab.id,tab);
        events.windowCreates++;
        return {...window,tabs:[tab]};
      },
    },
    tabGroups:{
      get:async(id)=>groups.get(id)||null,
      update:async(id,update)=>{Object.assign(groups.get(id),update);},
      move:async(id,{windowId})=>{
        assert.ok(groups.has(id));
        assert.ok(windows.has(windowId));
        groups.get(id).windowId=windowId;
        for(const tab of tabs.values())if(tab.groupId===id)tab.windowId=windowId;
      },
    },
    alarms:{onAlarm:{addListener(){}},create(){}},
  };
  const ctx=createContext({chrome,crypto:webcrypto,URL,console,
    setTimeout,clearTimeout,setInterval,clearInterval});
  runInContext(source,ctx);
  const ready=runInContext('stateReady',ctx);
  const create=runInContext('createManagedWorkerTab',ctx);
  const register=(tab)=>runInContext('workers.push('+tab.id+'); workerOwners['+tab.id+']="credential:test"',ctx);
  const first={__trustedPrincipal:{mode:'profile',browserSessionId:SESSION},
    __rootTabId:101,__rootIncarnationId:ROOT_A};
  const second={...first,__rootTabId:201,__rootIncarnationId:ROOT_B};
  return {ready,create,register,first,second,tabs,windows,groups,events,storage,ctx,chrome};
}

test('concurrent roots share one unfocused managed window and get isolated native groups',async()=>{
  const h=harness();
  await h.ready;
  const [a,b]=await Promise.all([
    h.create('https://chatgpt.com/',h.first,101),
    h.create('https://claude.ai/new',h.second,201),
  ]);
  for (const tab of [a,b]) {
    assert.deepEqual(h.events.startupSequence.filter(x=>x.endsWith(':'+tab.id)),
      ['create:'+tab.id], 'worker creation no longer attaches CDP');
  }
  h.register(a);h.register(b);
  assert.equal(h.events.windowCreates,1);
  assert.equal(h.events.tabFocuses,0);
  assert.equal(a.windowId,b.windowId);
  assert.notEqual(a.groupId,b.groupId);
  const sibling=await h.create('https://chatgpt.com/',h.first,101);
  assert.equal(sibling.groupId,a.groupId,'same root reuses its native group');
  const grandchild=await h.create('https://chatgpt.com/',{
    ...h.first,__trustedPrincipal:{...h.first.__trustedPrincipal,callerTabId:a.id},
  },a.id);
  assert.equal(grandchild.groupId,a.groupId,'grandchildren stay in their root group');
  assert.equal(h.events.groupCreates,2);
  assert.equal(h.events.windowCreates,1);
});

test('initial prompts are focused and submitted one at a time; completed handoffs do not wait for model replies', async()=>{
  const h=harness();
  await h.ready;
  const firstTab=await h.create('https://chatgpt.com/',h.first,101);
  h.register(firstTab);
  const secondTab=await h.create('https://chatgpt.com/',h.first,101);
  h.register(secondTab);
  runInContext('waitReady=async()=>{}; confirmTabIdle=async()=>{};',h.ctx);
  const starts=[];
  const submissions=[];
  h.chrome.tabs.sendMessage=async(tabId,msg)=>{
    if(msg.cmd!=='run_prompt')throw new Error('Unexpected message '+msg.cmd);
    starts.push(tabId);
    return new Promise(resolve=>submissions.push({tabId,resolve}));
  };
  const startTask=runInContext('startTask',h.ctx);
  const cfg={taskTimeoutMin:1};
  const first=startTask(firstTab.id,'chatgpt','first prompt',0,cfg,false,'credential:test');
  const second=startTask(secondTab.id,'chatgpt','second prompt',0,cfg,false,'credential:test');
  const until=async(fn)=>{
    for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}
    throw new Error('Startup handoff did not advance');
  };
  await until(()=>starts.length===1);
  assert.equal(starts[0],firstTab.id);
  assert.equal(h.tabs.get(firstTab.id).active,true);
  assert.equal(h.tabs.get(secondTab.id).active,false,
    'later worker must not steal focus before earlier submission is confirmed');
  submissions[0].resolve({ok:true,submitted:true});
  const resultA=await first;
  assert.equal(resultA.status,'running','response is not required for next startup');
  await until(()=>starts.length===2);
  assert.equal(starts[1],secondTab.id);
  assert.equal(h.tabs.get(secondTab.id).active,true);
  assert.equal(h.tabs.get(firstTab.id).active,false);
  submissions[1].resolve({ok:true,submitted:true});
  const resultB=await second;
  assert.equal(resultB.status,'running');
  assert.notEqual(resultA.task_id,resultB.task_id);
  assert.deepEqual(h.events.startupSequence.filter(s=>s.startsWith('focus:')),
    ['focus:'+firstTab.id,'focus:'+secondTab.id]);
});

test('transient Edge tab-edit lock retries focus without creating another worker',async()=>{
  const h=harness();
  await h.ready;
  const tab=await h.create('https://chatgpt.com/',h.first,101);
  h.register(tab);
  h.events.transientFocusFailures=2;
  await runInContext('focusWorkerForStartup',h.ctx)(tab.id);
  assert.equal(h.events.transientFocusFailures,0);
  assert.equal(h.tabs.get(tab.id).active,true);
  assert.equal(h.events.tabCreates,1);
  assert.equal(h.events.tabFocuses,1);
});

test('stale anchor is not adopted; root groups cannot hijack a recycled group ID',async()=>{
  const h=harness();
  await h.ready;
  const a=await h.create('https://chatgpt.com/',h.first,101);
  h.register(a);
  const original=JSON.parse(JSON.stringify(h.storage.workspaceWindow));
  h.tabs.delete(original.anchorTabId);
  const b=await h.create('https://claude.ai/new',h.second,201);
  h.register(b);
  assert.equal(h.events.windowCreates,2,'missing anchor requires a new dedicated workspace');
  assert.notEqual(a.windowId,b.windowId);
  assert.equal(h.events.tabFocuses,0);
  // Simulate unrelated browser reuse of the cached numeric group ID.
  h.groups.get(b.groupId).title='Unrelated user group';
  const c=await h.create('https://claude.ai/new',h.second,201);
  assert.notEqual(c.groupId,b.groupId,'do not adopt a group with unexpected identity');
});

test('missing root attestation fails before any window or worker is created',async()=>{
  const h=harness();
  await h.ready;
  await assert.rejects(h.create('https://chatgpt.com/',{
    ...h.first,__rootIncarnationId:ROOT_B,
  },101),/Root orchestrator session\/incarnation changed/);
  assert.equal(h.events.windowCreates,0);
  assert.equal(h.events.tabCreates,0);
});

test('grouping error rolls back only the unstarted worker tab, not the workspace',async()=>{
  const h=harness();
  await h.ready;
  h.chrome.tabGroups.update=async()=>{throw new Error('Group permissions unavailable');};
  await assert.rejects(
    h.create('https://chatgpt.com/',h.first,101),
    /Could not place worker in its root tab group/,
  );
  assert.equal(h.events.windowCreates,1);
  assert.equal(h.events.tabCreates,1);
  assert.equal([...h.tabs.values()].filter((tab)=>tab.url==='https://chatgpt.com/').length,0,
    'failed, unstarted tab is removed');
  assert.ok(h.storage.workspaceWindow,'workspace anchor is preserved after grouping failure');
});

test('Edge delays group membership after create: bounded regroup reuses same worker tab',async()=>{
  const h=harness();
  await h.ready;
  const original=h.chrome.tabs.group;
  let delayedOnce=false;
  h.chrome.tabs.group=async(args)=>{
    const groupId=await original(args);
    if(!delayedOnce && args.groupId==null){
      delayedOnce=true;
      h.tabs.get(args.tabIds[0]).groupId=-1;
    }
    return groupId;
  };
  const t=await h.create('https://chatgpt.com/',h.first,101);
  assert.equal(h.events.tabCreates,1,'retry must not duplicate worker tabs');
  assert.equal(t.windowId,h.storage.workspaceWindow.windowId);
  assert.ok(t.groupId>0);
});
test('browser moves newly grouped worker into another window: restore only owned group',async()=>{
  const h=harness();
  await h.ready;
  const nativeGroup=h.chrome.tabs.group;
  h.chrome.tabs.group=async(args)=>{
    const id=await nativeGroup(args);
    if(args.groupId==null){
      h.groups.get(id).windowId=1;
      for(const tab of h.tabs.values())if(tab.groupId===id)tab.windowId=1;
    }
    return id;
  };
  const tab=await h.create('https://chatgpt.com/',h.first,101);
  assert.equal(tab.windowId,h.storage.workspaceWindow.windowId);
  assert.equal(h.groups.get(tab.groupId).windowId,tab.windowId);
  assert.equal(h.events.windowCreates,1);
  assert.equal(h.events.tabFocuses,0);
});

test('failed group update does not persist a poisoned root-group cache',async()=>{
  const h=harness();
  await h.ready;
  const update=h.chrome.tabGroups.update;
  let failOnce=true;
  h.chrome.tabGroups.update=async(...args)=>{
    if(failOnce){failOnce=false;throw new Error('Browser group update rejected');}
    return update(...args);
  };
  await assert.rejects(
    h.create('https://chatgpt.com/',h.first,101),
    /Could not place worker in its root tab group.*group_update.*Browser group update rejected/,
  );
  assert.equal(Object.keys(h.storage.workspaceGroups || {}).length,0,
    'unconfirmed groups must not become cached worker ownership');
  assert.equal(h.events.tabCreates,1);
  const next=await h.create('https://chatgpt.com/',h.first,101);
  assert.equal(next.windowId,h.storage.workspaceWindow.windowId);
  assert.equal(h.events.tabCreates,2,
    'later requests create one fresh worker, not duplicate fallback tabs');
});

test('group update failure emits stage-specific diagnostics and preserves workspace',async()=>{
  const h=harness();
  await h.ready;
  let output='';
  const original=h.ctx.console.error;
  h.ctx.console.error=(...parts)=>{output+=parts.join(' ')+'\n';};
  try {
    h.chrome.tabGroups.update=async()=>{throw Error('No tabGroups permission');};
    await assert.rejects(h.create('https://chatgpt.com/',h.first,101),
      /No tabGroups permission/);
  } finally {h.ctx.console.error=original;}
  assert.match(output,/"event":"worker.placement_failed"/);
  assert.match(output,/"reason":"group_update"/);
  assert.doesNotMatch(output,/No tabGroups permission/,
    'diagnostics must not leak arbitrary error-message content');
  assert.equal(h.events.windowCreates,1);
});
test('Edge group becomes visible after tabs.group resolves: wait before updating',async()=>{
  const h=harness();
  await h.ready;
  const get=h.chrome.tabGroups.get;
  let misses=0;
  h.chrome.tabGroups.get=async(id)=>{
    if(misses++ < 3) return null;
    return get(id);
  };
  const tab=await h.create('https://chatgpt.com/',h.first,101);
  assert.ok(misses >= 4);
  assert.equal(tab.windowId,h.storage.workspaceWindow.windowId);
  assert.equal(h.events.tabCreates,1);
});