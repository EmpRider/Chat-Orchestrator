# ChatGPT focus, visibility, and browser automation findings

**Investigation date:** 2026-11-16–17 (capture timestamps span UTC/local dates).  
**Status:** Selected interactions observed working in a minimized Edge window. **Not a controlled proof that focus emulation is necessary, sufficient, or reliable unattended.**  
**Audience:** Developers maintaining this repository's browser extension and ChatGPT UI automation.

## 1. Executive summary

The connected ChatGPT build accepted prompt insertion and `HTMLFormElement.requestSubmit()` while its Edge window was minimized. A response containing `MINIMIZED_OK` appeared, and the Stop control disappeared. Model selection and reasoning-effort changes also worked during the minimized-window sequence.

The observed controls were:

| Activity | Observed handle |
|---|---|
| Composer | `.ProseMirror` contenteditable; accessibility name `Ask ChatGPT` |
| Send | Composer's enclosing `form`; `button[type="submit"][aria-label="Send"]` |
| Model picker | `button[aria-label="Select ChatGPT model"]` |
| Model choice | `[role="menuitemradio"]`, exact visible label |
| Selected model | `aria-checked="true"`; selected item also had `data-model-selected="true"` |
| Reasoning control | `[data-reasoning-slider]`, `role="menuitem"`, accessible name `Power` |
| Effort value | Descendant `[role="slider"]` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax` |
| Generation indicator | `button[aria-label="Stop"]` |

**Most important distinction:** page-facing focus, operating-system focus, page visibility, browser scheduling, and successful submission are different things. Returning `true` from `document.hasFocus()` does not make the OS window foreground, create trusted user input, or prevent browser freezing/discarding.

The existing repository already contains a managed-page focus shim. This investigation does **not** justify replacing it with a broad prototype patch or removing its foreground-submit protections.

## 2. Corrections to earlier session conclusions

Earlier messages and subagent reports overstated several results. Use this document's qualifications instead.

1. **“Visibilitychange never fires on Edge minimize/tab switching” is not established.** No such event was recorded in several attached, patched trials. Browser automation, debugger attachment, existing extensions, late listener installation, and uncertain tab activation confound those observations. Ordinarily, document visibility is a supported browser signal for backgrounding.
2. **“hasFocus patching is dead code” is not established.** No literal `hasFocus` occurred in eight extracted files. The initial REA inventory contained 151 script records. Other chunks, dependencies, computed property access, and future builds remain outside that negative result.
3. **“hidden_or_unmounted stops SSE” is unverified.** The source excerpt establishes a cleanup callback and reason string, not the callback's downstream network behavior. No verified trace to a stream abort or server timeout was produced.
4. **The prototype is not required for normal `document.visibilityState` reads.** An own-property getter also intercepts them. Patching the top document's prototype does not patch an iframe's separate JavaScript realm.
5. **CDP focus emulation was not tested.** The claim that `Emulation.setFocusEmulationEnabled` only works after a focus transition was unsupported. Its effects on visibility and scheduling must be measured on the actual Edge build.
6. **Browser launch flags were not tested.** They are candidate controls, not required settings established by this run.
7. **The final combined event-suppression snippet was not tested as a unit.** Earlier evaluations changed getters and recorded events; those are not equivalent to installing that complete snippet before app startup.
8. **Zero recorded events does not prove an event interceptor worked.** Some test listeners only recorded events, and later reloads replaced instrumentation.
9. **Model/effort persistence is unresolved.** Searching a few storage-key names does not establish server-side storage. A complete controlled before/after persistence experiment was not performed.
10. **Text in the entire page is not sufficient response verification.** `SHIM_OK` also occurred in its user prompt. The `MINIMIZED_OK` capture was stronger: it explicitly included `ChatGPT said:` followed by the answer. The later `SHIM_OK` test did not isolate the assistant response.
11. **Stop disappearing is not sufficient proof of success.** Cancellation, network failure, route changes, and failed generation can also remove it.
12. **Default-profile remote-debugging behavior is version-dependent.** Explicitly passing the default user-data directory is not a universal workaround for Chromium default-profile restrictions.

## 3. Environment and evidence scope

- Windows 11; Microsoft Edge `146.0.3856.109`.
- Default Edge profile (`--profile-directory=Default`).
- CDP endpoint: `http://127.0.0.1:9222`.
- Browser MCP controlled the existing authenticated browser session.
- REA listed targets and produced passive inspection evidence.
- ECC DevTools initially listed an `about:blank` page; the later live proof used Browser MCP and Windows window-state APIs. It was not an ECC-only validation.
- Two subagents investigated focus detection and ordinary UI automation. Their reports were checked selectively; unverified conclusions are not treated as facts.
- Third-party page extensions were present, including Quillbot and ChatGPT Optimizer. Their effect on DOM, scheduling, and focus was not isolated.

Observed browser-process flags included remote debugging, a wildcard remote-origin allowance, an explicit user-data directory, and the Default profile. **No background-throttling flags were present.** The wildcard allowance is not recommended as a default.

REA inspection reported:

| Inventory | Count |
|---|---:|
| DOM nodes | 1,626 |
| Accessibility nodes | 771 |
| Script records | 151 |
| Resource records | 61 |

The inspection was **policy-filtered and attach-limited**, not a complete execution trace. Network records captured after attachment do not reconstruct earlier requests.

### Local evidence locations

These are investigation-machine paths, not portable repository assets:

- `%USERPROFILE%\.claude\projects\d--web-chat-automation\066e57e3-080b-4d4a-96e6-b38efbc124d0\tool-results\mcp-rea-inspect_web_page-1794855311263.txt`
- `%LOCALAPPDATA%\Temp\gptjs\` — eight extracted bundle files examined locally.
- `%LOCALAPPDATA%\Temp\gptjs_hits\` — subagent-reported hit excerpts.

REA inspection evidence ID: `ev_29a3eda1b02bebf52d8ef3eb9a52446ab4ff7cd9610df5814efcb2817639cf0a`.

Bundle names changed between the original inventory and later extraction. Do not assume all excerpts belong to one immutable frontend deployment. Offsets below are character offsets in the extracted text, not source-map line numbers.

## 4. What the frontend source actually showed

### 4.1 Conversation presentation cleanup

File: `261147.a1bd1126d4.js`, near character **120092**:

```js
let e = () => {
  let e = l.get(sC.a, i);
  null != e && (0, sC.b)(l, i, e, "hidden_or_unmounted");
};
let t = () => {
  "visible" !== document.visibilityState && e();
};
document.addEventListener("visibilitychange", t);
window.addEventListener("pagehide", e);
// Effect cleanup removes both listeners and invokes e().
```

**Verified:** non-visible state on a visibility event invokes the callback; pagehide and effect teardown also invoke it.  
**Unverified:** whether `sC.b` affects cosmetic presentation, polling, network streaming, or some combination. The surrounding `ClientDelightPresentation` name is not proof of transport cancellation.

### 4.2 Widget refresh visibility guard

File: `321772.932143dfbd.js`, near **41372**:

```js
isVisible: t = () => "visible" === document.visibilityState
// ...
if (!i && r.get(a) === e && !e.inFlight && t()) {
  e.inFlight = true;
  // refreshWidget(...)
}
```

A helper near **41020** subscribes to document `visibilitychange` and window `focus`. This gates widget refresh attempts. It is not evidence that all chat generation pauses.

### 4.3 Intersection plus page visibility

Same file, near **59882** and **59994**:

```js
i && "visible" === s.visibilityState
// ... timer callback checks visibility again ...
i = e.isIntersecting && e.intersectionRatio >= 1 &&
    e.boundingClientRect.height > 0 && e.boundingClientRect.width > 0;
```

**Verified:** an action is gated on full intersection, nonzero dimensions, a delay, and visible document state. The precise product purpose was not fully traced.

### 4.4 Task-output-shown telemetry

Same file, near **147107**:

```js
g && m && "visible" === a.visibilityState
// ...
type: "CHATGPT_TASKS_EVENT_TYPE_TASK_OUTPUT_SHOWN"
```

This supports visibility-dependent task-output telemetry. It does not prove model generation stops when hidden.

### 4.5 Layout, progress, and canvas work

Same file:

| Character offset | Observed condition | Supported interpretation |
|---:|---|---|
| 353644 | `if(g || d.hidden || !t.isConnected || e.closest("[inert]")) return` | Layout/viewport work skips hidden or disconnected content. |
| 616693 | `n && !a.hidden && 99 > s()` before `setInterval(s,500)` | A progress-like interval depends on element and document visibility. |
| 622659 | `b = S && "hidden" !== j.visibilityState` | A canvas animation schedules/cancels rAF according to visibility. |
| around 405123 | `window.addEventListener("pagehide",T,true)` | Stream-presentation-related cleanup subscription exists; downstream transport behavior unverified. |

Do not suppress `pagehide`: it also represents navigation/session lifecycle cleanup, not ordinary tab blur.

### 4.6 Negative findings

A local search found no literal `hasFocus` across the eight extracted files. This is a limited text-search result, **not** proof that the complete application never uses it.

## 5. Live scenarios and results

All statuses refer to this session's existing browser profile. No clean-profile control was completed.

| ID | Scenario | Result | Limits |
|---|---|---|---|
| T01 | Active-page baseline | `visibilityState=visible`, `hidden=false`, `hasFocus=true` | Attached session only. |
| T02 | Inspect visibility getter | Native-looking configurable getter on `Document.prototype`; no own property in that sample | Does not exclude other instrumentation. |
| T03 | Patch getters and `hasFocus` | Page-facing reads returned visible/false/true | Tests changed observations, not OS focus. |
| T04 | Open/select another tab | Samples often stayed visible/focused; logs incomplete | Browser MCP selection did not reliably establish real tab activation. Inconclusive. |
| T05 | Minimize Edge using `ShowWindow(...,6)` | `IsIconic=True`, not foreground; window rect around `-32000` | Verified window state at sampled times. |
| T06 | Read state during minimized tests | Top page reported visible/false/true; fresh iframe reported visible/false/false | Different document/realm; not a pristine top-frame baseline. |
| T07 | Short top-frame rAF sample | Approximately 2 callbacks in a nominal one-second sample | Not a controlled benchmark; timing and attachment confounded. |
| T08 | Hidden iframe rAF sample | One callback in a short interval | Hidden iframe adds a separate confound; discard as top-frame evidence. |
| T09 | Three chained 50 ms timers | Elapsed marks 52, 110, 161 ms; three interval ticks | Short observation only; cannot exclude later intensive throttling. |
| T10 | Insert prompt while minimized | Composer contained 32 characters | Send button was found on a later read, not the immediate insertion read. |
| T11 | Send using `form.requestSubmit()` | Draft emptied; `Stop` appeared | Existing conversation URL did not change, as expected. |
| T12 | Receive `MINIMIZED_OK` | Page excerpt included user prompt, `ChatGPT said:`, then `MINIMIZED_OK`; Stop absent | Observed success in attached, modified environment. |
| T13 | Open model menu while minimized | Real menu items and slider discovered | Build/account-specific UI. |
| T14 | Decrease effort twice | 2/High → 1/Medium → 0/Instant | Browser MCP delivered ArrowLeft; ordinary synthetic DOM KeyboardEvents not tested. |
| T15 | Switch model | `GPT-6:false`, `GPT-5.6 Sol:true`; trigger became `Thinking effort / 5.6 Instant` | Menu remained open. |
| T16 | Escape closes menu | Reasoning-slider element absent afterward | Verified in this build. |
| T17 | Search storage keys | No definitive model/effort key identified | Not a full controlled storage diff or persistence test. |
| T18 | Fresh page, getter overrides, minimize | Patched reads stayed visible/focused; recorded event array empty | No proof that a combined event interceptor ran or was needed. |
| T19 | Send `SHIM_OK` with Enter, then minimize | Stop appeared, later disappeared; completion text observed | Send occurred before minimize. Page-wide SHIM_OK search also matches user prompt. |
| T20 | Launch with throttling flags | **Not run** | Candidate only. |
| T21 | CDP focus emulation on/off comparison | **Not run** | Candidate only. |
| T22 | Default profile without Browser MCP/debugger | **Not run** | Essential control still missing. |
| T23 | Long minimized generation, sleeping/discarded tab | **Not run** | No unattended reliability claim. |
| T24 | Attachments, edit, regenerate, reasoning expansion | **Not verified** | Outside completed coverage. |

Browser windows were restored after minimize experiments. Test messages were submitted to a real conversation; extra tabs were created. Full cleanup of tabs, model preferences, instrumentation, and conversation messages was not verified. No messages should be deleted automatically as cleanup.

## 6. Reproducible connection and measurement snippets

The snippets below are **proposed reproducible versions**, not all scripts executed verbatim in this session. They avoid known flaws in the ad hoc experiments.

### 6.1 Start Edge with loopback CDP

Save work and close Edge normally first. Do not force-kill a personal browser: that can lose unsaved work. Remote debugging exposes authenticated browser control to local clients; use a dedicated test profile when possible.

```powershell
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$profile = Join-Path $env:LOCALAPPDATA "ChatGPT-CDP-Test"
Start-Process $edge -ArgumentList @(
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9222',
  ('--user-data-dir="{0}"' -f $profile),
  '--profile-directory=Default',
  'https://chatgpt.com/'
)
curl.exe --fail --silent --show-error http://127.0.0.1:9222/json/version
```

This creates/uses a separate profile, not the existing signed-in Default profile. Sign in normally if needed. Do not copy cookies or credential stores. If reusing the default profile is mandatory, check the installed Edge version's supported debugging behavior first.

Do not add `--remote-allow-origins=*` by default. Keep the endpoint private and stop the debug-enabled browser after testing.

### 6.2 REA inspection

Select the exact target from the listing; never reuse a stale target ID after a restart.

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "allowed_origins": ["https://chatgpt.com"]
}
```

Pass that object to `list_browser_targets`. For passive inspection:

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "target_id": "TARGET_FROM_LISTING",
  "allowed_origins": ["https://chatgpt.com"],
  "observation_ms": 600,
  "include_accessibility_text": false,
  "include_script_sources": false
}
```

Use `analyze_web_bundle`, not `inspect_web_page`, when source capture is needed. Source capture can be large; preserve coverage and truncation metadata. Restrict capture to the selected origin and avoid collecting account/session storage values unnecessarily.

### 6.3 Capture original getters before changing anything

Run on a fresh test page before any shim. “Original” means original at probe installation, not guaranteed native if extensions already patched it.

```js
(() => {
  if (window.__focusProbe) throw new Error('Probe already installed');
  const proto = Document.prototype;
  const stateGetter = Object.getOwnPropertyDescriptor(proto, 'visibilityState').get;
  const hiddenGetter = Object.getOwnPropertyDescriptor(proto, 'hidden').get;
  const hasFocus = proto.hasFocus;
  const events = [];
  const read = () => ({
    time: performance.now(),
    originalState: stateGetter.call(document),
    originalHidden: hiddenGetter.call(document),
    originalFocus: hasFocus.call(document),
    exposedState: document.visibilityState,
    exposedHidden: document.hidden,
    exposedFocus: document.hasFocus()
  });
  const bindings = [
    [document, 'visibilitychange'],
    [window, 'blur'],
    [window, 'focus'],
    [window, 'pagehide'],
    [document, 'freeze'],
    [document, 'resume']
  ].map(([target, name]) => {
    const listener = event => {
      if (events.length >= 200) events.shift();
      events.push({type: event.type, trusted: event.isTrusted, ...read()});
    };
    target.addEventListener(name, listener, true);
    return [target, name, listener];
  });
  window.__focusProbe = {
    read, events,
    stop() {
      for (const [target, name, listener] of bindings)
        target.removeEventListener(name, listener, true);
      delete window.__focusProbe;
    }
  };
  return read();
})()
```

Read via the same CDP target without `Page.bringToFront` or selecting/activating the tab. Preserve the native getter **before** patching; this was initially done incorrectly during the session.

### 6.4 Bounded scheduler sample

An rAF-only promise can hang when rAF stops. This probe uses a timer and cancels its rAF callback afterward. The external CDP caller still needs its own timeout because the browser may suspend timers too.

```js
async function sampleScheduler(durationMs = 1500) {
  const start = performance.now();
  let frames = 0;
  let ticks = 0;
  let frame;
  const tick = () => { frames++; frame = requestAnimationFrame(tick); };
  frame = requestAnimationFrame(tick);
  const interval = setInterval(() => ticks++, 50);
  try {
    await new Promise(resolve => setTimeout(resolve, durationMs));
    const elapsedMs = performance.now() - start;
    return {elapsedMs, frames, framesPerSecond: frames * 1000 / elapsedMs, ticks};
  } finally {
    cancelAnimationFrame(frame);
    clearInterval(interval);
  }
}
```

Compare foreground, inactive tab, minimized, and restored states. Use actual elapsed time, not the requested duration, for rates.

### 6.5 Native minimized-window verification

Use an inspected handle for the intended test window. Do not blindly minimize the first Edge process.

```powershell
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowProbe {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Get-Process msedge |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  ForEach-Object {
    [pscustomobject]@{
      Handle = $_.MainWindowHandle
      Title = $_.MainWindowTitle
      Minimized = [WindowProbe]::IsIconic($_.MainWindowHandle)
      Foreground = [WindowProbe]::GetForegroundWindow() -eq $_.MainWindowHandle
    }
  }
```

### 6.6 CDP focus emulation candidate

Send through a CDP session attached to the specific page:

```json
{"id":1,"method":"Emulation.setFocusEmulationEnabled","params":{"enabled":true}}
```

Reset afterward:

```json
{"id":2,"method":"Emulation.setFocusEmulationEnabled","params":{"enabled":false}}
```

**Not verified in this investigation.** Compare original/exposed getters, events, rAF, actual window state, and successful submission before calling it a solution.

### 6.7 Minimal reversible page-facing shim experiment

Prefer the repository's existing managed-tab implementation for production. This isolated diagnostic changes only the current document's exposed values, keeps restoration descriptors, and deliberately does **not** swallow lifecycle or blur events.

```js
(() => {
  if (window.__undoFocusShim) throw new Error('Shim already installed');
  const values = {visibilityState: 'visible', hidden: false, hasFocus: () => true};
  const originals = new Map();
  const restore = () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(document, name, descriptor);
      else delete document[name];
    }
  };
  try {
    for (const [name, value] of Object.entries(values)) {
      originals.set(name, Object.getOwnPropertyDescriptor(document, name));
      Object.defineProperty(document, name, {configurable: true, value});
    }
    console.assert(document.visibilityState === 'visible');
    console.assert(document.hidden === false);
    console.assert(document.hasFocus() === true);
    window.__undoFocusShim = () => {
      restore();
      delete window.__undoFocusShim;
    };
  } catch (error) {
    restore();
    throw error;
  }
})()
```

Undo with `window.__undoFocusShim()`. For before-app testing, use CDP `Page.addScriptToEvaluateOnNewDocument`, then reload an approved test page. Record the returned script identifier and remove it with `Page.removeScriptToEvaluateOnNewDocument` afterward; removing registration does not undo patches already installed in a loaded document.

This snippet is proposed, not live-verified verbatim. It does not change scheduler policy, other realms, OS focus, trusted-event flags, or server behavior.

### 6.8 Background scheduling flags: experiment only

Candidate launch switches:

```text
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
```

These were **not used or compared** during the successful minimized send. Do not claim they guarantee rAF cadence, stop sleeping tabs, or prevent discard. Test one change at a time. Never substitute silent-audio tricks: the subagent's oscillator example was not silent and was not tested.

## 7. Prompt input and submission

### 7.1 Selector policy

Prefer semantic controls scoped to the composer or open menu. Require exactly one visible enabled target. Re-query after React updates and navigation. Do not cache snapshot references, hashed CSS classes, or generated menu IDs.

`.ProseMirror` is an editor-library class, not a contractual API. `#prompt-textarea` was an initial candidate, but the later live recipe relied on `.ProseMirror`. Inspect both rather than assume an ID exists in every rollout.

### 7.2 Insert into an empty composer

The following guarded version reflects the observed `focus()` plus `execCommand('insertText')` mechanism. The guards were not executed verbatim as one script.

```js
function fillEmptyComposer(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Prompt required');
  const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .filter(el => el.getClientRects().length > 0);
  if (editors.length !== 1) throw new Error(`Expected one editor; found ${editors.length}`);
  const editor = editors[0];
  if (editor.innerText.trim()) throw new Error('Existing draft; refusing to overwrite');
  editor.focus();
  if (!document.execCommand('insertText', false, text))
    throw new Error('insertText failed; inspect draft before retrying');
  return editor.innerText;
}
```

Do not use `editor.textContent = ''` to clear a ProseMirror document: that can desynchronize editor state and destroy an existing draft. The earlier subagent recipe used this unsafe shortcut.

`execCommand` is deprecated but worked in the observed session. CDP input or the editor's supported transaction mechanism are alternatives to evaluate, not verified equivalents. `value=` is not a contenteditable input API.

### 7.3 Wait for enabled Send, then submit once

Immediately after insertion, a selector failed to find Send; a subsequent inspection found it enabled. Treat that as a render/state timing issue, not evidence that React portals are unqueryable.

```js
function submitCurrentDraft(expectedText) {
  const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .filter(el => el.getClientRects().length > 0);
  if (editors.length !== 1) throw new Error('Composer missing or ambiguous');
  const editor = editors[0];
  if (editor.innerText !== expectedText) throw new Error('Draft changed; not submitting');
  const form = editor.closest('form');
  const send = form?.querySelector('button[type="submit"][aria-label="Send"]');
  if (!send || send.disabled || send.getAttribute('aria-disabled') === 'true')
    throw new Error('Send not ready');
  form.requestSubmit(send);
}
```

**Observed live:** `form.requestSubmit()` without an explicit submitter emptied the composer and started generation while minimized. Passing the discovered submitter above is a proposed variant; verify it separately. Do not use `form.submit()`, which bypasses normal submit-event handling and validation.

After submission, confirm a newly added matching user turn. An unchanged `/c/<id>` URL is normal in an existing conversation. If acknowledgement is uncertain, inspect before retrying; a blind retry can duplicate a real prompt.

## 8. Model and reasoning-effort selection

### 8.1 Menu observed in this account/build

```text
Trigger: Select ChatGPT model
Trigger text before change: Thinking effort / High

menuitem: Select model
  visible text: High
  data-model-picker-view-toggle="true"

menuitem: Power
  data-reasoning-slider="true"
  aria-keyshortcuts="ArrowLeft ArrowRight"
  descendant slider:
    aria-valuemin="0"
    aria-valuemax="2"
    aria-valuenow="2"
    aria-hidden="true"

menuitemradio: GPT-6        aria-checked="true"
menuitemradio: GPT-5.6 Sol  aria-checked="false"
```

Those are **observed UI labels**, not an assertion about globally available models or API identifiers.

The menu was queryable through ordinary `document.querySelectorAll`. Earlier subagent claims that portals prevented DOM queries were incorrect: portals generally relocate nodes within a document rather than making them inaccessible.

### 8.2 Dynamic model selection

```js
function selectVisibleModel(label) {
  const items = [...document.querySelectorAll('[role="menuitemradio"]')]
    .filter(el => el.getClientRects().length > 0 && el.innerText.trim() === label);
  if (items.length !== 1) throw new Error(`Model unavailable or ambiguous: ${label}`);
  if (items[0].getAttribute('aria-disabled') === 'true') throw new Error('Model disabled');
  items[0].click();
}
```

Open the picker first, discover available labels, select an exact label, then re-query `aria-checked` after the UI updates. In this session, selecting `GPT-5.6 Sol` changed checked states and left the menu open.

### 8.3 Effort selection

Observed mapping for the tested menu:

| Slider value | Visible label |
|---:|---|
| 0 | Instant |
| 1 | Medium |
| 2 | High |

Browser MCP command sequence used in substance:

```text
eval "() => document.querySelector('[data-reasoning-slider]').focus()"
press ArrowLeft
```

Read the result after each key:

```js
(() => {
  const control = document.querySelector('[data-reasoning-slider]');
  const slider = control?.querySelector('[role="slider"]');
  return {
    min: slider?.getAttribute('aria-valuemin'),
    max: slider?.getAttribute('aria-valuemax'),
    value: slider?.getAttribute('aria-valuenow'),
    label: document.querySelector('[data-model-picker-view-toggle]')?.innerText.trim()
  };
})()
```

Focus the outer `Power` menuitem, not the `aria-hidden` slider thumb. Read bounds dynamically; do not assume the same range for every model/account. Stop if a key does not change the expected value. Escape closed the tested menu.

Model choice changed the trigger to `Thinking effort / 5.6 Instant`. Later samples returned to `High`; persistence and intervening UI changes were not isolated. Reassert and verify required settings for each job until persistence is understood.

## 9. Completion and answer extraction

Observed generation selector:

```js
Boolean(document.querySelector('button[aria-label="Stop"]'))
```

In this build, queries returned no `[data-message-author-role="assistant"]` or `.result-streaming` matches. Do not interpret missing legacy selectors as “no response.”

Use a stateful completion procedure:

1. Record the current conversation and assistant-turn count before sending.
2. Confirm the new matching user turn was accepted.
3. Observe generation starting or a new completed assistant turn appearing.
4. Wait for Stop to disappear, then confirm the new assistant turn exists.
5. Reject error, cancellation, navigation, authentication, and rate-limit states.
6. Require content stability across separated samples, with an external deadline.
7. Report uncertainty on timeout; do not resend automatically.

The page exposed hidden headings such as `ChatGPT said:`. They are discovery anchors, not a verified universal answer-container selector:

```js
const assistantHeadings = [...document.querySelectorAll('h4')]
  .filter(h => h.textContent.trim() === 'ChatGPT said:');
const latestHeading = assistantHeadings.at(-1);
// Inspect its ancestors before choosing an extraction boundary.
```

No clean, generic answer extractor was validated. Joining every `p`, `span`, and `code` duplicates nested text and omits some tables/lists. Searching all `body.innerText` leaks unrelated UI/history and can match the prompt itself. Build extraction only after validating the actual assistant-turn boundary; retain code and table structure where needed.

## 10. Repository integration

Relevant existing files:

- [managed-focus-main.js](../extention/managed-focus-main.js): early MAIN-world shim; inert until managed-tab authorization; page-facing visibility getters and `Document.prototype.hasFocus`; capture listeners for visibility/blur; preserves pagehide.
- [background.js](../extention/background.js), around lines 1397–1425 at inspection: serializes focus-sensitive submission and optionally acquires a foreground-submit lease. Explicitly rejects minimized worker windows in that path.
- [content.js](../extention/content.js), around lines 804–811 at inspection: rejects pre-submit when its observed `document.visibilityState` is hidden.

A MAIN-world patch is not proof that an isolated-world content script sees the same patched JavaScript properties. Verify execution-world behavior before concluding the shim satisfies the content-script guard.

**No repository implementation change is included in this report.** Do not remove the hidden-tab guard or foreground lease based on this run. First reproduce the successful UI path through the actual extension and managed-agent authorization flow.

## 11. Required controlled acceptance matrix

Run these cases on a dedicated test conversation with harmless unique prompts. Do not overwrite user drafts, force-close the browser, or hide a pending ambiguous send by retrying it.

| Variant | Foreground | Inactive tab | Minimized | Minimized during generation |
|---|---|---|---|---|
| No shim, no CDP focus emulation | Required baseline | Required | Required | Required |
| Existing managed shim only | Required | Required | Required | Required |
| CDP focus emulation only | Required | Required | Required | Required |
| Managed shim plus scheduling flags | Only if needed | Required | Required | Required |
| Actual extension send flow | Required | Required | Required | Required |

For each case record:

- Browser version, launch flags, profile, enabled extensions, exact CDP target.
- Native window minimized/foreground state before and after automation calls.
- Original getter values captured before overrides, exposed getter values, event log.
- Scheduler samples with actual elapsed time; include long-background testing.
- Draft text and enabled Send state; one submission attempt and one matching user turn.
- Chosen model/effort readback before send.
- New assistant turn, final content, errors, elapsed time, and Stop transitions.
- Debugger/Browser MCP attachment state. Repeat without attachment where feasible.
- Restoration of test-only patches, window state, menu state, and preferences.

### Minimal assertions

These assertions are a proposed acceptance outline, not a test executed by this documentation change:

```js
console.assert(sample.exposedState === 'visible', 'Page-facing visibility failed');
console.assert(sample.exposedHidden === false, 'Page-facing hidden failed');
console.assert(sample.exposedFocus === true, 'Page-facing focus failed');
console.assert(osWindow.minimized === true, 'Automation restored the window');
console.assert(newMatchingUserTurns === 1, 'Submission missing or duplicated');
console.assert(newAssistantTurnText.trim() === expectedReply, 'Answer not verified');
```

Passing the first three checks alone proves only the fake values. The last three are the meaningful end-to-end checks.

## 12. Remaining risks and recommendation

- Default-profile extensions and debugger attachment may explain some unusual visibility observations.
- A short timer sample cannot establish behavior after prolonged backgrounding, memory pressure, sleeping tabs, discard, or OS sleep.
- Suppressing all blur events can break editor/menu focus management. Avoid broad interception without a demonstrated need.
- Overriding visibility may keep telemetry and work active unnecessarily, increasing CPU or power use.
- UI labels, menu structure, model availability, and effort ranges can change without notice.
- No reliable answer extraction, exhaustive source coverage, persistence mechanism, or extension-integrated minimized-send test was completed.

**Recommendation:** retain the existing managed-tab safety boundaries. First run a clean A/B test of the current extension with and without its shim, using the verified `requestSubmit()` interaction as a comparison. Add CDP focus emulation or scheduling flags only if a controlled failure demonstrates their need. Treat “always focused” as a page-observation experiment, not a guarantee of an always-running browser.
