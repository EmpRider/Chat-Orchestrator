const $ = id => document.getElementById(id);
$('bridge-url').textContent='ws://'+location.host+'/bridge';
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value,null,2);
const element = (tag,text) => Object.assign(document.createElement(tag),{textContent:text ?? ''});
const human = key => key.replace(/^coordination_/,'Queue · ').replaceAll('_',' ');
const known = new Map(), drafts = new Map(), context = {};
let selected, counter = 0, latest = 0;
function bucket(key) {
  return ({caller_tab_id:'tab_id',worker_tab_id:'tab_id',share_context_from:'tab_id',
    event_ids:'event_id',ref:'event_id',full_report_ref:'event_id'})[key] || key;
}
function remember(key,value) {
  key = bucket(key);
  if (!['tab_id','task_id','event_id','browser_session_id','confirmation_nonce','batch_id','snapshot_sha256','idempotency_key'].includes(key)) return;
  if (!known.has(key)) known.set(key,new Set());
  known.get(key).add(String(value));
}
function collect(value,key='') {
  if (Array.isArray(value)) value.forEach(v => collect(v,key));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => collect(v,k));
  else if (value != null) remember(key,value);
}
function log(kind,payload,at=new Date().toISOString(),failed=false) {
  const row = element('details');
  const summary = element('summary',at.slice(11,23) + ' UTC · ' + kind);
  if (failed) summary.className='error';
  row.append(summary);
  row.ontoggle = () => {
    if (row.open && row.children.length === 1) row.append(element('pre',pretty(payload)));
  };
  $('log').prepend(row);
  if ($('log').childElementCount > 500) $('log').lastElementChild.remove();
}
async function request(url,body,label) {
  const id = ++counter;
  log('#' + id + ' → ' + label,{method:body ? 'POST' : 'GET',url,body});
  try {
    const res = await fetch(url,body ? {method:'POST',headers:{'Content-Type':'application/json',
      Accept:'application/json, text/event-stream'},body:JSON.stringify(body)} : {});
    const raw = await res.text();
    const events = raw.split(/\r?\n/).filter(line => line.startsWith('data:'));
    let data;
    try {data=JSON.parse(events.length ? events.at(-1).slice(5) : raw);}
    catch {
      log('#' + id + ' Invalid response · ' + label,{status:res.status,raw},undefined,true);
      throw new Error('Invalid response (HTTP ' + res.status + ')');
    }
    const failed = !res.ok || Boolean(data.error || data.result?.isError);
    log('#' + id + (failed ? ' Failed · ' : ' OK · ') + label,{status:res.status,raw},undefined,failed);
    if (failed) throw new Error(pretty(data.error || data.result?.content || data));
    return data;
  } catch (err) {
    log('#' + id + ' Error · ' + label,err.message,undefined,true);
    throw err;
  }
}
const rpc = (method,params) => request('/mcp',{jsonrpc:'2.0',id:crypto.randomUUID(),method,params},params.name || method);
function decoded(result) {
  const text = result.content?.[0]?.text;
  try {return JSON.parse(text);} catch {return text ?? result;}
}
const stream = new EventSource('/events');
stream.onmessage = ({data}) => {
  const item = JSON.parse(data);
  if (item.kind === 'Connection') {
    const {online,sessions} = item.payload;
    $('connection').textContent = !online ? 'Bridge offline' : sessions.length ? 'Connected · ' + sessions.length + ' profile(s)' : 'Waiting for extension';
    sessions.forEach(s => remember('browser_session_id',s));
    updateSuggestions();
  } else {
    log(item.kind + (item.session ? ' · ' + item.session : ''),item.payload,item.at,item.kind.includes('error'));
    if (item.kind.startsWith('WS ')) {
      try {collect(JSON.parse(item.payload)); updateSuggestions();} catch {}
    }
  }
};
stream.onerror = () => $('connection').textContent = 'Tester disconnected · reconnecting…';
function updateSuggestions() {
  for (const list of $('fields').querySelectorAll('datalist')) {
    const values = known.get(bucket(list.dataset.key)) || [];
    if (list.children.length === values.size) continue;
    list.replaceChildren(...Array.from(values,v => new Option(v,v)));
  }
}
const friendly = {list_tabs:'Get tab list',spawn_worker:'Spawn worker tab',send_to_tab:'Send message',get_result:'Get result',read_chat:'Read chat'};
function register(group,op) {
  const button = element('button',friendly[op.name] || human(op.name));
  button.onclick = () => select(op,button);
  $(group).append(button);
  if (!selected) select(op,button);
}
function inputs() {return Array.from($('fields').querySelectorAll('[name]'));}
function select(op,button) {
  if (selected) drafts.set(selected.name,Object.fromEntries(inputs().map(el => [el.name,el.value])));
  selected=op;
  document.querySelector('button[aria-current]')?.removeAttribute('aria-current');
  button.setAttribute('aria-current','true');
  $('title').textContent=op.title || button.textContent;
  $('description').textContent=op.description || '';
  $('fields').replaceChildren();
  for (const [key,schema] of Object.entries(op.inputSchema?.properties || {})) {
    const choices=schema.enum || (schema.const !== undefined ? [schema.const] : schema.type==='boolean' ? ['true','false'] : null);
    const el=element(choices ? 'select' : ['task','text','summary','reason'].includes(key) || key.startsWith('prompt.') ? 'textarea' : 'input');
    el.name=key; el.id='field-'+key;
    if (choices) el.append(new Option('Select…',''),...choices.map(v=>new Option(v,v)));
    const label=element('label',human(key) + (op.inputSchema.required?.includes(key) ? ' *' : ''));
    label.htmlFor=el.id;
    $('fields').append(label,el);
    if (schema.description || schema.type==='array') $('fields').append(element('small',schema.description || 'Enter IDs in order, separated by commas.'));
    if (el.tagName==='INPUT') {
      const list=element('datalist'); list.id='options-'+key; list.dataset.key=key;
      el.setAttribute('list',list.id); $('fields').append(list);
    }
    el.value=drafts.get(op.name)?.[key] ?? context[key] ?? op.defaults?.[key] ?? '';
    if (key==='idempotency_key') {
      const gen=element('button','Generate UUID'); gen.type='button';
      gen.onclick=()=>el.value=crypto.randomUUID(); $('fields').append(gen);
    }
    if (key==='event_ids') {
      const pick=element('select'); pick.setAttribute('aria-label','Append a known event');
      pick.append(new Option('Append a known event…',''),...Array.from(known.get('event_id') || [],v=>new Option(v,v)));
      pick.onchange=()=>{if(pick.value) el.value=[el.value,pick.value].filter(Boolean).join(', ');pick.value='';};
      $('fields').append(pick);
    }
  }
  updateSuggestions(); $('run').disabled=false;
}
$('form').onsubmit=async e=>{
  e.preventDefault();
  const op=selected, invocation=++latest;
  const args={};
  for (const el of inputs()) {
    if (['caller_tab_id','browser_session_id'].includes(el.name)) context[el.name]=el.value;
    if (el.value==='') continue;
    const type=op.inputSchema.properties[el.name].type;
    let value=el.value;
    if ((type==='integer' || type==='number') && Number.isFinite(Number(value))) value=Number(value);
    if (type==='boolean') value=value==='true';
    if (type==='array') value=value.split(',').map(s=>s.trim());
    args[el.name]=value;
  }
  $('outcome').textContent='Running · '+op.name; $('result').textContent='';
  try {
    const value=op.run ? await op.run(args) : decoded((await rpc('tools/call',{name:op.name,arguments:args})).result);
    collect(value); updateSuggestions();
    if (invocation===latest) show('Succeeded · '+op.name,value,false);
  } catch(err) {if(invocation===latest) show('Failed · '+op.name,err.message,true);}
};
function show(label,value,failed) {
  $('outcome').className=failed?'error':'success'; $('outcome').textContent=label; $('result').textContent=pretty(value);
}
$('clear').onclick=async()=>{try {await request('/manual/clear',{},'Clear logs'); $('log').replaceChildren();} catch(err){show('Clear failed',err.message,true);}};
const props={tab_id:{type:'integer'},browser_session_id:{type:'string'},confirmation_nonce:{type:'string'}};
function local(name,properties,run,options={}) {
  register('desktop',{name,inputSchema:{properties},run,...options});
}
try {
  const catalog=(await rpc('tools/list',{})).result.tools;
  for(const tool of catalog) register('tools',tool);
  for(const name of ['set_orchestrator','diagnose','close_legacy_workers','inspect_root_repair','confirm_root_repair']) {
    const fields={...props};
    if(name!=='confirm_root_repair') delete fields.confirmation_nonce;
    if(name==='close_legacy_workers') delete fields.tab_id;
    local(name,fields,args=>request('/manual/desktop',{action:name,...args},name));
  }
  local('health',{},()=>request('/health',null,'Health'));
  local('desktop_dashboard',{},()=>request('/manual/dashboard',null,'Desktop dashboard'));
  const settings=await request('/manual/settings',null,'Read test profile settings');
  const defaults={...settings};
  delete defaults.promptModules; delete defaults.promptSchema;
  const fields={enabled:{type:'boolean'},maxWorkers:{type:'integer'},maxTasksPerHour:{type:'integer'},taskTimeoutMin:{type:'integer'}};
  for(const [k,v] of Object.entries(settings.promptModules)){
    fields['prompt.'+k]={type:'string'}; defaults['prompt.'+k]=v;
  }
  local('apply_extension_settings',fields,args=>{
    const body={promptModules:{}};
    for(const [k,v] of Object.entries(args)) {
      if(k.startsWith('prompt.')) body.promptModules[k.slice(7)]=v; else body[k]=v;
    }
    return request('/manual/settings',body,'Apply extension settings');
  },{defaults,description:'Apply test-profile limits and prompt modules to connected extensions.'});
  for(const mode of ['disconnect','offline','online']) local('bridge_'+mode,
    mode==='disconnect'?{browser_session_id:props.browser_session_id}:{},
    args=>request('/manual/network',{mode,session:args.browser_session_id},'Bridge '+mode),
    {description:{disconnect:'Disconnect the selected profile, or all profiles if blank. The extension can retry immediately.',
      offline:'Disconnect all profiles and reject reconnects until Bridge online is clicked.',online:'Accept extension reconnects again.'}[mode]});
} catch(err){show('Setup failed',err.message,true);}

