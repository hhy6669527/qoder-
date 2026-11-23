import test from 'node:test';
import assert from 'node:assert/strict';
import { getAttempt, clearAttempt, storePending, loadPending, clearPending } from '../src/recovery.ts';
const values = new Map();
globalThis.sessionStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
test('a lost join response retains the exact membership token and idempotency ID for refresh recovery', () => {
  const before = getAttempt('join:testroom01');
  const after = getAttempt('join:testroom01');
  assert.deepEqual(after, before);
  assert.match(after.token, /^[a-f0-9]{64}$/);
  assert.notEqual(getAttempt('join:testroom02').token, before.token);
  clearAttempt('join:testroom01');
  assert.notEqual(getAttempt('join:testroom01').token, before.token);
});
test('unconfirmed commands survive navigation and are strictly scoped to their room', () => {
  const operation = { session: { roomId: 'testroom01', token: 'a'.repeat(64), mode: 'duo' }, revision: 5, id: 'original-request', command: { action: 'compose', intentId: 'i1', lineId: 'l2' } };
  storePending(operation);
  assert.deepEqual(loadPending('testroom01'), operation);
  assert.equal(loadPending('testroom02'), null);
  assert.equal(loadPending('testroom01').revision, 5);
  clearPending('testroom01');
  assert.equal(loadPending('testroom01'), null);
});
test('malformed or disabled storage never crashes recovery helpers', () => {
  values.set('wavelength:pending:broken', '{');
  values.set('wavelength:attempt:broken', 'null');
  assert.equal(loadPending('broken'), null);
  assert.match(getAttempt('broken').token, /^[a-f0-9]{64}$/);
});
