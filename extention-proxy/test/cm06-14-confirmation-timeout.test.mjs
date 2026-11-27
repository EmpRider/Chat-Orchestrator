// CM-06 / CM-14 — the submission-confirmation budget.
//
// The catalog states the same contract twice:
//   CM-14 "No submission evidence within 12s poll window" -> SUBMISSION_UNCERTAIN
//   CM-06 "No evidence path satisfied within 12s"          -> SUBMISSION_UNCERTAIN,
//          no blind retry
// The source pins it at content.js:1329 (`},12000,200)`), and the refusal is
// thrown at content.js:1346-1352 with code SUBMISSION_UNCERTAIN.
//
// This file drives the REAL content.js through the shared harness (extracted
// verbatim from chatgpt-composer.test.mjs so that suite stays untouched). The
// stimulus is: a working composer, a Send control that fires, and then a page
// that produces NO confirmation evidence — no new user turn, no route change,
// no generation — the `hideNewUserTurn` fixture with no route/generating flags.
//
// Both scenarios are asserted in ONE execution because they are one contract;
// splitting them would duplicate a 12-second wait to prove the same line.
import test from 'node:test';
import assert from 'node:assert/strict';
import {composerHarness} from './support/composer-harness.mjs';
import {randomUUID} from 'node:crypto';

function batch() {
  return '<queue_batch>{"batch_id":"' + randomUUID() + '","events":[]}</queue_batch>';
}

test('CM-14/CM-06 no confirmation evidence inside the 12s window is SUBMISSION_UNCERTAIN, with no blind retry', {
  // The 12s poll budget is real wall clock; leave room for a poll cycle either
  // side. A bound test that does not wait cannot prove a bound.
  timeout: 40000,
}, async () => {
  const h = composerHarness({textarea: false, extraEnabledButton: false,
    hideNewUserTurn: true});
  const startedAt = Date.now();
  const result = await h.call(batch());
  const elapsed = Date.now() - startedAt;

  // ---- the outcome the catalog names --------------------------------------
  assert.equal(result.uncertain, true,
    'an unconfirmed submission must be reported uncertain, never confirmed: ' + JSON.stringify(result));
  assert.equal(result.ok, false);

  // ---- no blind retry (catalog CM-06, "no blind retry") -------------------
  assert.equal(h.info().primaryClicks, 1,
    'exactly one Send — uncertainty must never trigger an automatic second click');
  assert.equal(h.info().secondaryClicks, 0, 'no fallback Send either');
  assert.equal(h.info().nativeSubmissions, 0,
    'and no native form submission as a retry path');

  // ---- the 12s bound is observed, not assumed -----------------------------
  // content.js:1329 is the poll budget. One 200ms poll of slack on each side.
  assert.ok(elapsed >= 11500,
    'must hold for the documented 12s confirmation budget; held ' + elapsed + 'ms');
  assert.ok(elapsed <= 14500,
    'must not exceed the 12s budget by more than a poll cycle; took ' + elapsed + 'ms');

  // ---- the diagnostic proves WHY, and that nothing claimed otherwise ------
  const end = h.diagnostics().find((e) => e.step === 'submission_confirmation_end');
  assert.ok(end, 'the confirmation end must be logged with its measured duration');
  assert.equal(end.confirmed, false, 'confirmed must stay false');
  assert.ok(end.durationMs >= 11500,
    'the logged duration must agree with the observed wait; got ' + end.durationMs + 'ms');
  assert.equal(end.accountChanged, false,
    'this is a genuine timeout, not an account-switch refusal — that is CM-07');

  const evidence = h.diagnostics().filter((e) => e.step === 'submission_confirmation_evidence');
  assert.deepEqual(evidence, [],
    'NO evidence event may be emitted when nothing was confirmed');

  const errorEvent = h.diagnostics().find((e) => e.step === 'error');
  assert.ok(errorEvent, 'the failure must be classified in the diagnostics');
  assert.equal(errorEvent.code, 'SUBMISSION_UNCERTAIN',
    'the error code is the catalog assertion for both CM-06 and CM-14');
});

test('CM-14 a confirmed submission does NOT report uncertain (the control)', {
  timeout: 20000,
}, async () => {
  // Without this control the test above would pass even if content.js simply
  // returned uncertain:true for everything.
  const h = composerHarness({textarea: false, extraEnabledButton: false});
  const startedAt = Date.now();
  const result = await h.call(batch());
  const elapsed = Date.now() - startedAt;

  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.notEqual(result.uncertain, true);
  assert.equal(h.info().primaryClicks, 1);
  assert.ok(elapsed < 11500,
    'a confirmed submission must finish well inside the 12s budget; took ' + elapsed + 'ms');
  assert.equal(h.diagnostics().some((e) =>
    e.step === 'error' && e.code === 'SUBMISSION_UNCERTAIN'), false);
});
