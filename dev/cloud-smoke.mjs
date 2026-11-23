// Real deployment acceptance. Uses synthetic gameplay only; never prints tokens.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const origin = process.argv[2];
if (!origin?.startsWith('https://')) throw new Error('Pass the verified published HTTPS origin.');
const root = origin.replace(/\/$/, '') + '/functions/v1/app/api';
const story = JSON.parse(readFileSync(new URL('../content/stories.json', import.meta.url), 'utf8')).find(s => s.id === 'friends-meal');
const outcomes = [];
function pass(check) { console.log(`PASS: ${check}`); outcomes.push({ check, status: 'passed' }); }
async function call(path, body, token, expected = 200) {
  const response = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'manual' });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { throw new Error(`${path} did not return JSON: HTTP ${response.status}`); }
  assert.equal(response.status, expected, `${path}: ${response.status} ${data.error?.code || ''}`);
  return data;
}
async function create(mode) {
  const token = randomBytes(32).toString('hex');
  const body = { storyId: story.id, mode, token, requestId: randomUUID() };
  const { view } = await call('/rooms', body);
  return { token, body, id: view.id, view };
}
async function read(player) { return (await call(`/rooms/${player.id}`, undefined, player.token)).view; }
async function command(player, action) {
  const current = await read(player);
  const body = { revision: current.revision, requestId: randomUUID(), ...action };
  const result = await call(`/rooms/${player.id}/commands`, body, player.token);
  player.view = result.view;
  return result.view;
}
const page = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
assert.equal(page.status, 200);
assert.ok((await page.text()).includes('同频不同词'));
pass('anonymous public homepage opens without login redirect');
const health = await call('/health'); assert.equal(health.environment, 'cloud'); assert.equal(health.persistence, 'database');
pass('published Function reads the real private database');
const catalog = await call('/stories'); assert.equal(catalog.stories.length, 12); assert.ok(!JSON.stringify(catalog).includes(story.roles.B.background));
pass('12-story catalog is public but does not expose private perspectives');
const solo = await create('solo');
assert.equal((await call('/rooms', solo.body)).view.id, solo.id);
await call(`/rooms/${solo.id}`, undefined, undefined, 401);
await call(`/rooms/${solo.id}`, undefined, randomBytes(32).toString('hex'), 403);
await command(solo, { action: 'ready' });
await command(solo, { action: 'compose', intentId: 'i1', lineId: 'l1' });
await command(solo, { action: 'clarify' });
await command(solo, { action: 'interpret', guessId: 'i2', response: 'boundary' });
await command(solo, { action: 'compose', intentId: 'i1', lineId: 'l2' });
assert.equal(solo.view.phase, 'reveal'); assert.equal(solo.view.reveal.records.length, 3);
await command(solo, { action: 'repair', index: 1 });
await command(solo, { action: 'repair-compose', lineId: 'l2' });
assert.equal(solo.view.repair.stage, 'done');
await command(solo, { action: 'repair-end' });
pass('real solo gameplay, clarification and opposite-role replay persist in database');
const a = await create('duo');
const b = { id: a.id, token: randomBytes(32).toString('hex') };
const join = { token: b.token, requestId: randomUUID() };
b.view = (await call(`/rooms/${a.id}/join`, join)).view;
assert.equal((await call(`/rooms/${a.id}/join`, join)).view.role, 'B');
await call(`/rooms/${a.id}/join`, { token: randomBytes(32).toString('hex'), requestId: randomUUID() }, undefined, 409);
assert.ok(!JSON.stringify(await read(a)).includes(story.roles.B.background));
assert.ok(!JSON.stringify(await read(b)).includes(story.roles.A.background));
const before = await read(a);
await Promise.all([a, b].map(p => call(`/rooms/${a.id}/commands`, { action: 'ready', revision: before.revision, requestId: randomUUID() }, p.token)));
assert.equal((await read(a)).phase, 'playing');
pass('two identities join, a third is refused, simultaneous readiness merges atomically');
for (let i = 0; i < 3; i++) {
  const sender = i === 1 ? b : a;
  const receiver = i === 1 ? a : b;
  const v = await read(sender);
  const body = { action: 'compose', intentId: 'i1', lineId: 'l1', revision: v.revision, requestId: randomUUID() };
  const sent = (await call(`/rooms/${a.id}/commands`, body, sender.token)).view;
  const replayed = (await call(`/rooms/${a.id}/commands`, body, sender.token)).view;
  assert.equal(sent.revision, replayed.revision);
  await call(`/rooms/${a.id}/commands`, { ...body, lineId: 'l2' }, sender.token, 409);
  if (i === 0) await command(receiver, { action: 'clarify' });
  await command(receiver, { action: 'interpret', guessId: 'i1', response: 'accept' });
}
const finalA = await read(a), finalB = await read(b);
assert.deepEqual(finalA.reveal, finalB.reveal);
await command(a, { action: 'repair', index: 0 });
await command(a, { action: 'repair-compose', lineId: 'l3' });
assert.equal((await read(a)).repair.stage, 'interpret');
await command(b, { action: 'repair-interpret', guessId: 'i1' });
assert.equal((await read(a)).repair.stage, 'done');
pass('real dual-player synchronization, duplicate suppression, privacy and human-confirmed repair');
await call(`/rooms/${a.id}/presence`, {}, a.token);
await command(a, { action: 'leave' });
assert.equal((await read(b)).phase, 'closed');
await command(solo, { action: 'leave' });
pass('presence and room closure work across independent visitor credentials');
const evidence = { origin, checkedAt: new Date().toISOString(), note: 'Live Function/database functional and room-permission tests; not a general platform penetration audit.', checks: outcomes };
writeFileSync(new URL('../.local/cloud-acceptance.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log('Live acceptance complete. Synthetic rooms closed.');
