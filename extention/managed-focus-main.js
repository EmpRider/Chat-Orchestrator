// Focusly-style, early MAIN-world focus emulation. Installed for supported
// ChatGPT pages, but completely inert until the service worker verifies that
// this exact tab is an approved Parent or an owned Child.
//
// This changes page-facing JS observations, NOT Chrome's real tab activation,
// operating-system focus or browser scheduler. Never suppress pagehide:
// navigation/session cleanup must continue working.
(() => {
  'use strict';
  const key=Symbol.for('chat-orchestrator.managed-focus.v2');
  if(document[key]?.version===2)return;

  // A pre-update tab might still have the old D-052 visibility shim. Restore
  // its original descriptors before capturing native getter behavior here.
  const legacyKey=Symbol.for('chat-orchestrator.managed-visibility.v1');
  const legacy=document[legacyKey];
  if(legacy && typeof legacy==='object'){
    try {
      for(const [name,descriptor] of [['hidden',legacy.hidden],
        ['visibilityState',legacy.state]]){
        if(descriptor)Object.defineProperty(document,name,descriptor);
        else delete document[name];
      }
      delete document[legacyKey];
    }catch{}
  }

  let enabled=false;
  const propertyNames=['hidden','webkitHidden','visibilityState','webkitVisibilityState'];
  const originals=new Map();
  const ownDescriptors=new Map();
  const docPrototype=Document.prototype;
  const originalHasFocus=docPrototype.hasFocus;
  const ownHasFocus=Object.getOwnPropertyDescriptor(docPrototype,'hasFocus');

  function inheritedDescriptor(object,name) {
    for(let current=object;current;current=Object.getPrototypeOf(current)){
      const descriptor=Object.getOwnPropertyDescriptor(current,name);
      if(descriptor)return descriptor;
    }
    return null;
  }
  function originalValue(name){
    const descriptor=originals.get(name);
    if(!descriptor)return undefined;
    return typeof descriptor.get==='function'
      ? descriptor.get.call(document):descriptor.value;
  }
  function restore(){
    for(const name of propertyNames){
      const descriptor=ownDescriptors.get(name);
      try {
        if(descriptor)Object.defineProperty(document,name,descriptor);
        else delete document[name];
      }catch{}
    }
    try {
      if(ownHasFocus)Object.defineProperty(docPrototype,'hasFocus',ownHasFocus);
      else delete docPrototype.hasFocus;
    }catch{}
  }
  try {
    for(const name of propertyNames){
      ownDescriptors.set(name,Object.getOwnPropertyDescriptor(document,name));
      originals.set(name,inheritedDescriptor(document,name));
      Object.defineProperty(document,name,{
        configurable:true,
        enumerable:originals.get(name)?.enumerable ?? false,
        get(){
          if(enabled)return name.toLowerCase().includes('hidden')?false:'visible';
          return originalValue(name);
        },
      });
    }
    // Like Focusly, intercept the *prototype* method. Keep native behavior for
    // non-managed/disabled documents and all other Document instances.
    Object.defineProperty(docPrototype,'hasFocus',{
      configurable:true,
      writable:true,
      value:function(...args){
        if(enabled && this===document)return true;
        return Reflect.apply(originalHasFocus,this,args);
      },
    });
  }catch{
    restore();
    return;
  }

  function suppressFocusLoss(event){
    if(!enabled)return;
    event.stopImmediatePropagation();
    event.stopPropagation();
  }
  // Installed before the app's listeners at document_start. Disabled tabs
  // receive their native events unchanged. Never intercept focus/pagehide.
  const eventTargets=[
    [document,'visibilitychange'],[document,'webkitvisibilitychange'],
    [document,'blur'],[window,'blur'],
  ];
  for(const [target,name] of eventTargets)
    target.addEventListener(name,suppressFocusLoss,true);

  Object.defineProperty(document,key,{
    configurable:false,
    enumerable:false,
    value:Object.freeze({
      version:2,
      setEnabled(value){enabled=value===true;return enabled;},
      status(){return {installed:true,enabled};},
    }),
  });
})();
