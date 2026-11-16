import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Other Chromium derivatives use an explicit executable selected by the user.
// We never guess brands from Chrome-compatible User-Agent strings.
export const BROWSER_CHOICES = Object.freeze(['none','edge','chrome','chromium']);

export function normalizeManagedBrowser(value) {
  if (typeof value !== 'string' || !BROWSER_CHOICES.includes(value))
    throw new Error('Select Chrome, Edge, another Chromium browser, or none');
  return value;
}

export function normalizeChromiumExecutablePath(value) {
  if(typeof value!=='string' || value.length>1024 || !path.isAbsolute(value) ||
     !/\.exe$/i.test(value) || /^[\\/]{2}/.test(value) ||
     /["\r\n]/.test(value))
    throw new Error('Select a local absolute Chromium-based browser .exe path');
  return path.normalize(value);
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

export function findInstalledBrowser(browser,{
  env=process.env,exists=fs.existsSync,customExecutablePath=null,
}={}) {
  normalizeManagedBrowser(browser);
  if (browser==='none') return null;
  if(browser==='chromium'){
    const executable=normalizeChromiumExecutablePath(customExecutablePath);
    return exists(executable)?executable:null;
  }
  return installedBrowserCandidates(browser,env).find((file)=>exists(file))||null;
}

export function managedBrowserLaunchArgs(browser,profileDir,{openExtensions=false}={}) {
  if (!['edge','chrome','chromium'].includes(browser) ||
      typeof profileDir!=='string' || !path.isAbsolute(profileDir))
    throw new Error('Installed browser and dedicated absolute profile path required');
  // Intentional: no CDP, remote debugging, browser-wide policy override,
  // unsupported automatic extension injection or existing personal profile.
  return ['--user-data-dir='+profileDir,'--no-first-run','--new-window',
    openExtensions ? (browser==='edge'?'edge://extensions/':'chrome://extensions/')
      : 'https://chatgpt.com/'];
}

export function managedProfilePath(dataDir,browser,{executablePath=null}={}) {
  if (!['edge','chrome','chromium'].includes(browser) ||
      typeof dataDir!=='string' || !path.isAbsolute(dataDir))
    throw new Error('Invalid dedicated browser profile location');
  if(browser==='chromium'){
    const executable=normalizeChromiumExecutablePath(executablePath);
    const fingerprint=crypto.createHash('sha256').update(executable.toLowerCase()).digest('hex').slice(0,12);
    return path.join(dataDir,'managed-browser','chromium-'+fingerprint);
  }
  return path.join(dataDir,'managed-browser',browser);
}

// Stored approval alone does not attest the extension currently connected to
// the Proxy. Reverify the active installation after every disconnect/restart.
export function matchesManagedEnrollment(saved,selected,live,connected=true){
  return connected===true && ['edge','chrome','chromium'].includes(selected) &&
    saved?.browser===selected &&
    /^[0-9a-f-]{36}$/i.test(saved.profileInstallId||'') &&
    (selected==='chromium' ? ['chrome','chromium'].includes(live?.browser_product)
      : live?.browser_product===selected) &&
    live?.profile_install_id===saved.profileInstallId &&
    typeof live?.extension_version==='string' && live.extension_version.length>0 &&
    /^[0-9a-f-]{36}$/i.test(live?.browser_session_id||'');
}
