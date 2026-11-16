// Conservative, consent-first release discovery and quiescence gate.
// This module never downloads, executes or trusts an unverified installer.
const VERSION=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_ORIGIN='https://github.com/EmpRider/Chat-Orchestrator/releases/tag/';
export const RELEASE_API='https://api.github.com/repos/EmpRider/Chat-Orchestrator/releases/latest';

export function versionParts(value){
  const match=typeof value==='string' && VERSION.exec(value.trim());
  return match?match.slice(1).map(Number):null;
}
export function isNewerVersion(candidate,current){
  const a=versionParts(candidate),b=versionParts(current);
  if(!a||!b)return false;
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return false;
}
export function verifiedRelease(record,currentVersion){
  if(!record || record.draft===true || record.prerelease===true ||
      !isNewerVersion(record.tag_name,currentVersion))return null;
  const tag=record.tag_name;
  if(record.html_url!==RELEASE_ORIGIN+tag)return null;
  return Object.freeze({
    version:tag.replace(/^v/,''),tag,url:record.html_url,
    title:typeof record.name==='string'?record.name.slice(0,140):tag,
  });
}
export async function checkLatestRelease(currentVersion,{fetchImpl=fetch}={}){
  const response=await fetchImpl(RELEASE_API,{
    headers:{Accept:'application/vnd.github+json','User-Agent':'Chat-Orchestrator-Updater'},
    signal:AbortSignal.timeout(7000),
  });
  if(!response.ok)throw new Error('Trusted release feed unavailable (HTTP '+response.status+')');
  return verifiedRelease(await response.json(),currentVersion);
}
export function stillApprovedRelease(approvedVersion,previous,latest){
  return typeof approvedVersion==='string' &&
    previous?.version===approvedVersion &&
    latest?.version===approvedVersion &&
    typeof previous?.url==='string' && previous.url===latest.url;
}
export function evaluateUpdateReadiness(extension,snapshot,{queueEnabled=true,now=Date.now()}={}){
  const blockers=[];
  if(extension?.ready!==true)
    blockers.push('Child completion and Parent review are not verified');
  if(!Array.isArray(extension?.blockers))
    blockers.push('Child completion status is unavailable');
  else blockers.push(...extension.blockers);
  if(!Number.isFinite(extension?.checked_at) ||
      extension.checked_at>now+1000 || now-extension.checked_at>15000)
    blockers.push('Fresh extension task and review observation unavailable');
  if(!snapshot || !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
      Date.parse(snapshot.generatedAt)>now+1000 ||
      now-Date.parse(snapshot.generatedAt)>15000)
    blockers.push('Fresh Proxy queue snapshot unavailable');
  else {
    if(snapshot.registryError===true)blockers.push('Proxy registry requires reconciliation');
    if(snapshot.browserTabs?.status!=='observed')
      blockers.push('Live browser inventory is unavailable');
    else if(!Number.isFinite(Date.parse(snapshot.browserTabs.observedAt)) ||
        Date.parse(snapshot.browserTabs.observedAt)>now+1000 ||
        now-Date.parse(snapshot.browserTabs.observedAt)>15000)
      blockers.push('Browser inventory observation is stale');
    if(queueEnabled && snapshot.storageReady!==true)
      blockers.push('Persistent FIFO journal has not been verified');
    if(snapshot.hiddenPending!==0)
      blockers.push('Unresolved or unobserved FIFO events may remain');
    if(!Array.isArray(snapshot.queue))
      blockers.push('Queue event phases unavailable');
    else if(snapshot.queue.some((event)=>!['PROCESSED','SAGA_CONFIRMED'].includes(event.phase)))
      blockers.push('Parent FIFO delivery or ACK still pending');
  }
  return {ready:blockers.length===0,blockers};
}
