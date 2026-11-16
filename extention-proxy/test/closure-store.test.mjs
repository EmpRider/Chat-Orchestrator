import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createClosureStore} from '../desktop/closure-store.mjs';

const session='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const incarnation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('closure decisions persist, deduplicate, enforce 5s gate and never auto-select',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'closure-store-'));
  try{
    let now=1000;const file=path.join(dir,'closures.json');
    const store=createClosureStore(file,{now:()=>now});
    const observation={browser_session_id:session,old_tab_id:101,
      incarnation_id:incarnation,role:'parent',site:'chatgpt',
      url:'https://chatgpt.com/c/a',active_descendants:[201]};
    const first=store.record(observation);
    assert.equal(store.record(observation).id,first.id);
    assert.throws(()=>store.begin(first.id,'Yes'),/five seconds/);
    now=6001;
    const reopened=createClosureStore(file,{now:()=>now});
    assert.equal(reopened.pending().length,1);
    assert.equal(reopened.pending()[0].phase,'pending');
    reopened.begin(first.id,'Accident');
    assert.equal(reopened.pending()[0].phase,'restoring');
    const retried=createClosureStore(file,{now:()=>now});
    assert.equal(retried.pending()[0].phase,'restoring',
      'process restart must never imply successful restoration');
    retried.finish(first.id,{outcome:'RESTORE_FAILED',error:'Tab identity changed'});
    assert.equal(retried.pending()[0].phase,'failed');
    retried.retry(first.id);
    retried.begin(first.id,'Cancel');
    retried.finish(first.id,{outcome:'DETACHED'});
    assert.equal(retried.pending().length,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
