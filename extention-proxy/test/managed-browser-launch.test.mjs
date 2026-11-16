import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {findInstalledBrowser,installedBrowserCandidates,
  normalizeManagedBrowser,managedProfilePath,managedBrowserLaunchArgs,
  matchesManagedEnrollment} from '../desktop/managed-browser.mjs';

const env={PROGRAMFILES:'C:\\Program Files','PROGRAMFILES(X86)':'C:\\Program Files (x86)',
  LOCALAPPDATA:'C:\\Users\\Test\\AppData\\Local'};
test('browser selection does not assume an existing personal profile',()=>{
  assert.equal(normalizeManagedBrowser('none'),'none');
  assert.equal(normalizeManagedBrowser('edge'),'edge');
  assert.throws(()=>normalizeManagedBrowser('../chrome'),/Select/);
  assert.equal(findInstalledBrowser('none',{env,exists:()=>true}),null);
  const exe=installedBrowserCandidates('edge',env);
  assert.ok(exe.every((p)=>p.endsWith(path.join('Microsoft','Edge','Application','msedge.exe'))));
  assert.equal(findInstalledBrowser('edge',{env,exists:(p)=>p===exe[1]}),exe[1]);
});
test('managed launch uses dedicated user data with no debugging or extension-bypass flags',()=>{
  const data=path.resolve('C:/Temp/chat-orchestrator');
  const profile=managedProfilePath(data,'edge');
  assert.ok(profile.includes(path.join('managed-browser','edge')));
  const args=managedBrowserLaunchArgs('edge',profile);
  assert.ok(args[0].startsWith('--user-data-dir='));
  assert.equal(args.at(-1),'https://chatgpt.com/');
  assert.ok(!args.some((arg)=>/remote-debug|load-extension|disable-features/i.test(arg)));
  assert.equal(managedBrowserLaunchArgs('edge',profile,{openExtensions:true}).at(-1),
    'edge://extensions/');
  assert.throws(()=>managedProfilePath(data,'../other'),/Invalid/);
});

test('persisted browser approval is not live extension attestation after restart or reconnection',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const session='22222222-2222-4222-8222-222222222222';
  const saved={browser:'edge',profileInstallId:id};
  const live={browser_product:'edge',profile_install_id:id,extension_version:'0.1.3',
    browser_session_id:session};
  assert.equal(matchesManagedEnrollment(saved,'edge',null,true),false,
    'saved identity alone never grants live verified status');
  assert.equal(matchesManagedEnrollment(saved,'edge',live,false),false,
    'disconnect revokes the live attestation');
  assert.equal(matchesManagedEnrollment(saved,'edge',live,true),true);
  assert.equal(matchesManagedEnrollment(saved,'chrome',live,true),false);
  assert.equal(matchesManagedEnrollment(saved,'edge',{...live,profile_install_id:
    '33333333-3333-4333-8333-333333333333'},true),false);
  assert.equal(matchesManagedEnrollment(saved,'edge',{...live,browser_product:'chrome'},true),false);
  assert.equal(matchesManagedEnrollment(saved,'edge',{...live,browser_session_id:''},true),false);
  assert.equal(matchesManagedEnrollment(saved,'edge',{...live,extension_version:null},true),false);
  assert.equal(matchesManagedEnrollment(null,'edge',live,true),false);
});
