import fs from 'node:fs';
import path from 'node:path';

export const BROWSER_CHOICES = Object.freeze(['none','edge','chrome']);

export function normalizeManagedBrowser(value) {
  if (typeof value !== 'string' || !BROWSER_CHOICES.includes(value))
    throw new Error('Select Chrome, Edge, or no managed browser');
  return value;
}

export function installedBrowserCandidates(browser, env=process.env) {
  if (!['edge','chrome'].includes(browser)) return [];
  const roots=[env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA]
    .filter((dir)=>typeof dir==='string' && path.isAbsolute(dir));
  const relative=browser==='edge'
    ? ['Microsoft','Edge','Application','msedge.exe']
    : ['Google','Chrome','Application','chrome.exe'];
  return [...new Set(roots.map((base)=>path.join(base,...relative)))];
}

export function findInstalledBrowser(browser,{env=process.env,exists=fs.existsSync}={}) {
  normalizeManagedBrowser(browser);
  if (browser==='none') return null;
  return installedBrowserCandidates(browser,env).find((file)=>exists(file))||null;
}

export function managedBrowserLaunchArgs(browser,profileDir,{openExtensions=false}={}) {
  if (!['edge','chrome'].includes(browser) ||
      typeof profileDir!=='string' || !path.isAbsolute(profileDir))
    throw new Error('Installed browser and dedicated absolute profile path required');
  // Intentional: no CDP, remote debugging, browser-wide policy override,
  // unsupported automatic extension injection or existing personal profile.
  return ['--user-data-dir='+profileDir,'--no-first-run','--new-window',
    openExtensions ? (browser==='edge'?'edge://extensions/':'chrome://extensions/')
      : 'https://chatgpt.com/'];
}

export function managedProfilePath(dataDir,browser) {
  if (!['edge','chrome'].includes(browser) ||
      typeof dataDir!=='string' || !path.isAbsolute(dataDir))
    throw new Error('Invalid dedicated browser profile location');
  return path.join(dataDir,'managed-browser',browser);
}

// Stored approval alone does not attest the extension currently connected to
// the Proxy. Reverify the active installation after every disconnect/restart.
export function matchesManagedEnrollment(saved,selected,live,connected=true){
  return connected===true && ['edge','chrome'].includes(selected) &&
    saved?.browser===selected &&
    /^[0-9a-f-]{36}$/i.test(saved.profileInstallId||'') &&
    live?.browser_product===selected &&
    live?.profile_install_id===saved.profileInstallId &&
    typeof live?.extension_version==='string' && live.extension_version.length>0 &&
    /^[0-9a-f-]{36}$/i.test(live?.browser_session_id||'');
}
