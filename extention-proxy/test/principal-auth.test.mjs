import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createPrincipalCredential, listPrincipalCredentials,
  revokePrincipalCredential, resolvePrincipalCredential,
} from '../principal-auth.mjs';

const enrollment = {
  role: 'pm', workspaceId: 'web-chat-automation', projectId: '4',
  orchestratorId: 'p0', parentTaskId: '65', callerTabId: 101,
  browserSessionId: randomUUID(), managerIncarnationId: randomUUID(),
};

test('scoped credentials bind metadata, never persist plaintext, revoke immediately', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-principal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'coordination-principals.json');
  const a = createPrincipalCredential(file, enrollment);
  const b = createPrincipalCredential(file, { ...enrollment, role: 'tl', callerTabId: 102, managerIncarnationId: randomUUID() });
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.principal.credentialId, b.principal.credentialId);
  assert.equal(a.principal.callerTabId, 101);
  assert.equal(resolvePrincipalCredential(file, a.token).role, 'pm');
  assert.equal(resolvePrincipalCredential(file, b.token).role, 'tl');
  assert.equal(resolvePrincipalCredential(file, 'not-a-token'), null);
  assert.equal(listPrincipalCredentials(file).length, 2);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(a.token));
  assert.equal(revokePrincipalCredential(file, a.principal.credentialId), true);
  assert.equal(resolvePrincipalCredential(file, a.token), null);
  assert.equal(resolvePrincipalCredential(file, b.token).callerTabId, 102);
  assert.equal(revokePrincipalCredential(file, a.principal.credentialId), true);
});

test('invalid scopes and altered registry fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-orch-principal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'coordination-principals.json');
  assert.throws(() => createPrincipalCredential(file, { ...enrollment, callerTabId: 0 }), /Invalid principal tab/);
  assert.throws(() => createPrincipalCredential(file, { ...enrollment, role: 'owner' }), /Unsupported principal role/);
  assert.throws(() => createPrincipalCredential(file, { ...enrollment, browserSessionId: undefined }), /attestation required/);
  const { token } = createPrincipalCredential(file, enrollment);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.credentials[0].connectionGeneration = -1;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => resolvePrincipalCredential(file, token), /Invalid principal registry entry/);
  assert.throws(() => listPrincipalCredentials(file), /Invalid principal registry entry/);
  assert.throws(() => revokePrincipalCredential(file, saved.credentials[0].credentialId), /Invalid principal registry entry/);
});
