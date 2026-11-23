import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createServer, API_PREFIX } from '../dev/server.mjs';

// Deliberately independent of the content agent's catalog and completion time.
const fixture = {
  id: 'fixture', number: '01', relation: 'friends', topic: 'meal', title: '测试晚餐',
  subtitle: '一起说清楚', quote: '一句话，两种理解', location: '餐桌', mood: '温和', duration: '5 分钟',
  setup: '两个人在商量晚餐。', objective: '表达和理解，然后复盘。',
  roles: {
    A: { name: '阿青', identity: '朋友 A', background: 'PRIVATE_A_BACKGROUND', goal: 'PRIVATE_A_GOAL' },
    B: { name: '小白', identity: '朋友 B', background: 'PRIVATE_B_BACKGROUND', goal: 'PRIVATE_B_GOAL' },
  },
  rounds: ['A', 'B', 'A'].map((speaker, index) => ({
    speaker, title: `第 ${index + 1} 轮`, prompt: `PROMPT_${index}`,
    leadIns: { normal: `NORMAL_${index}`, clarified: `CLARIFIED_${index}`, boundary: `BOUNDARY_${index}` },
    intents: [
      { id: `i${index}a`, label: `想一起吃饭 ${index}`, clarification: `ONLY_SELECTED_CLARIFICATION_${index}_A` },
      { id: `i${index}b`, label: `想休息 ${index}`, clarification: `UNSELECTED_CLARIFICATION_${index}_B` },
    ],
    lines: [
      { id: `l${index}hint`, text: `HINT_${index}`, style: 'hint' },
      { id: `l${index}direct`, text: `DIRECT_${index}`, style: 'direct' },
      { id: `l${index}question`, text: `QUESTION_${index}`, style: 'question' },
    ],
    replies: { accept: `ACCEPT_${index}`, boundary: `BOUNDARY_REPLY_${index}` },
    npc: {
      intent: `i${index}a`, line: `l${index}hint`,
      guessByLine: { [`l${index}hint`]: `i${index}b`, [`l${index}direct`]: `i${index}a`, [`l${index}question`]: 'unsure' },
    },
    insight: `INSIGHT_${index}`,
  })),
  endings: { clarified: 'ENDING_CLARIFIED', boundary: 'ENDING_BOUNDARY', open: 'ENDING_OPEN' },
  takeaway: '不是心理评分，只是回看表达。',
};
const token = () => randomBytes(32).toString('hex');
const requestId = () => randomUUID();
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'same-wavelength-backend-'));
  const dbPath = join(dir, 'rooms.sqlite');
  const storiesPath = join(dir, 'stories.json');
  writeFileSync(storiesPath, JSON.stringify([fixture]));
  let server;
  async function start() { server = await createServer({ port: 0, dbPath, storiesPath }); }
  async function close() {
    if (!server) return;
    const closing = server;
    server = undefined;
    await new Promise((resolve, reject) => closing.close((error) => error ? reject(error) : resolve()));
  }
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  await start();
  const base = () => `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  async function api(method, path, { body, token: credential, headers = {}, raw } = {}) {
    const response = await fetch(`${base()}${path}`, {
      method,
      headers: {
        ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers,
      },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function read(session) {
    const result = await api('GET', `/rooms/${session.id}`, { token: session.token });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result.json.view;
  }
  async function create(mode = 'duo') {
    const credential = token();
    const body = { storyId: fixture.id, mode, token: credential, requestId: requestId() };
    const result = await api('POST', '/rooms', { body });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return { id: result.json.view.id, token: credential, view: result.json.view, createBody: body };
  }
  async function joinRoom(host) {
    const credential = token();
    const result = await api('POST', `/rooms/${host.id}/join`, { body: { token: credential, requestId: requestId() } });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return { id: host.id, token: credential, view: result.json.view };
  }
  async function command(session, commandBody, revision, id = requestId()) {
    const current = revision ?? (await read(session)).revision;
    return api('POST', `/rooms/${session.id}/commands`, {
      token: session.token, body: { revision: current, requestId: id, ...commandBody },
    });
  }
  async function act(session, body) {
    const result = await command(session, body);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result.json.view;
  }
  function database(work) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try { return work(db); } finally { db.close(); }
  }
  async function duo() {
    const a = await create();
    const b = await joinRoom(a);
    await act(a, { action: 'ready' });
    await act(b, { action: 'ready' });
    return { a, b };
  }
  async function finishDuo(a, b) {
    for (let index = 0; index < 3; index += 1) {
      const sender = index === 1 ? b : a;
      const receiver = index === 1 ? a : b;
      await act(sender, { action: 'compose', intentId: `i${index}a`, lineId: `l${index}hint` });
      await act(receiver, { action: 'interpret', guessId: `i${index}b`, response: 'accept' });
    }
    return read(a);
  }
  async function finishSolo({ clarify = false, response = 'accept' } = {}) {
    const a = await create('solo');
    assert.equal(a.view.ready.B, true);
    assert.equal(a.view.partnerJoined, true);
    let view = await act(a, { action: 'ready' });
    assert.equal(view.stage, 'compose');
    view = await act(a, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' });
    assert.equal(view.roundIndex, 1);
    assert.equal(view.stage, 'interpret');
    assert.equal(view.round.speaker, 'B');
    assert.deepEqual(view.round.incoming, { text: 'HINT_1' });
    assert.equal(view.records.length, 1);
    if (clarify) await act(a, { action: 'clarify' });
    view = await act(a, { action: 'interpret', guessId: 'i1a', response });
    assert.equal(view.roundIndex, 2);
    assert.equal(view.stage, 'compose');
    view = await act(a, { action: 'compose', intentId: 'unsure', lineId: 'l2question' });
    assert.equal(view.phase, 'reveal');
    assert.equal(view.reveal.records.length, 3);
    return { a, view };
  }
  return { api, read, create, joinRoom, command, act, database, duo, finishDuo, finishSolo, base, restart: async () => { await close(); await start(); } };
}

function publicOnly(records) {
  for (const record of records) {
    for (const field of ['intentId', 'intended', 'guessedId', 'interpreted', 'matched', 'response', 'insight', 'lineId']) {
      assert.equal(Object.hasOwn(record, field), false, `private field ${field} leaked`);
    }
  }
}
function noOpponentPrivate(view, role = 'A') {
  const other = role === 'A' ? 'B' : 'A';
  const json = JSON.stringify(view);
  assert.equal(json.includes(`PRIVATE_${other}_BACKGROUND`), false);
  assert.equal(json.includes(`PRIVATE_${other}_GOAL`), false);
  assert.equal(json.includes('guessByLine'), false);
  assert.equal(Object.hasOwn(view, 'reveal'), false);
  publicOnly(view.records);
}
function errorIs(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.json.error.code, code);
  assert.deepEqual(Object.keys(result.json), ['error']);
  assert.equal(typeof result.json.error.message, 'string');
}

test('health, catalog projection, loopback origin protection and no static/private routes', async (t) => {
  const h = await harness(t);
  const health = await h.api('GET', '/health');
  assert.deepEqual(health.json, { ok: true, environment: 'local', persistence: 'sqlite' });
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  const catalog = (await h.api('GET', '/stories')).json.stories;
  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0].cast, { A: { name: '阿青', identity: '朋友 A' }, B: { name: '小白', identity: '朋友 B' } });
  for (const secret of ['PRIVATE_', 'PROMPT_', 'CLARIFICATION_', 'ENDING_', 'npc', 'rounds', 'roles', 'takeaway']) assert.equal(JSON.stringify(catalog).includes(secret), false);
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1.evil.example', 'http://localhost@evil.example', 'file://']) {
    errorIs(await h.api('GET', '/health', { headers: { Origin: origin } }), 403, 'ORIGIN_FORBIDDEN');
  }
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://[::1]:5173']) {
    assert.equal((await h.api('GET', '/health', { headers: { Origin: origin } })).status, 200);
  }
  errorIs(await h.api('GET', '/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'ORIGIN_FORBIDDEN');
  errorIs(await h.api('GET', '/health?token=secret'), 400, 'INVALID_URL');
  for (const path of ['/content/stories.json', '/.local/rooms.sqlite', '/dev/server.mjs', '/unknown']) assert.equal((await h.api('GET', path)).status, 404);
});

test('create idempotency, hashed credentials, membership authorization and private views', async (t) => {
  const h = await harness(t);
  const a = await h.create();
  assert.match(a.id, /^[A-Za-z0-9]{10}$/);
  assert.equal(a.view.phase, 'waiting');
  assert.equal(a.view.role, 'A');
  noOpponentPrivate(a.view);
  assert.equal(a.view.partnerJoined, false);
  assert.ok(Math.abs(a.view.expiresAt - Date.now() - 86_400_000) < 1000);
  const replay = await h.api('POST', '/rooms', { body: { requestId: a.createBody.requestId, token: a.token, mode: 'duo', storyId: fixture.id } });
  assert.deepEqual(replay.json.view, a.view);
  errorIs(await h.api('POST', '/rooms', { body: { ...a.createBody, mode: 'solo' } }), 409, 'IDEMPOTENCY_CONFLICT');
  errorIs(await h.api('GET', `/rooms/${a.id}`), 401, 'UNAUTHORIZED');
  errorIs(await h.api('GET', `/rooms/${a.id}`, { token: token() }), 403, 'FORBIDDEN');
  errorIs(await h.api('GET', '/rooms/0000000000', { token: a.token }), 404, 'ROOM_NOT_FOUND');
  errorIs(await h.command({ id: a.id, token: token() }, { action: 'ready' }, 0), 403, 'FORBIDDEN');
  const b = await h.joinRoom(a);
  assert.equal(b.view.role, 'B');
  assert.equal(b.view.ownRole.goal, 'PRIVATE_B_GOAL');
  noOpponentPrivate(b.view, 'B');
  const rejoinA = await h.api('POST', `/rooms/${a.id}/join`, { body: { token: a.token, requestId: requestId() } });
  assert.equal(rejoinA.json.view.role, 'A');
  const stored = h.database((db) => ({
    rooms: db.prepare('SELECT * FROM rooms').all(),
    members: db.prepare('SELECT * FROM members').all(),
    operations: db.prepare('SELECT * FROM operations').all(),
  }));
  assert.equal(stored.rooms.length, 1);
  assert.equal(stored.members.length, 2);
  assert.ok(stored.members.some((member) => member.token_hash === sha(a.token)));
  assert.equal(JSON.stringify(stored).includes(a.token), false);
  assert.equal(JSON.stringify(stored).includes(b.token), false);
});

test('double join and simultaneous ready are atomic, roles never replace members', async (t) => {
  const h = await harness(t);
  const a = await h.create();
  const credentials = [token(), token()];
  const bodies = credentials.map((credential) => ({ token: credential, requestId: requestId() }));
  const results = await Promise.all(bodies.map((body) => h.api('POST', `/rooms/${a.id}/join`, { body })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.findIndex((result) => result.status === 200);
  const b = { id: a.id, token: credentials[winner] };
  assert.deepEqual((await h.api('POST', `/rooms/${a.id}/join`, { body: bodies[winner] })).json, results[winner].json);
  errorIs(results[1 - winner], 409, 'ROOM_FULL');
  const revision = (await h.read(a)).revision;
  const ready = await Promise.all([h.command(a, { action: 'ready' }, revision), h.command(b, { action: 'ready' }, revision)]);
  assert.deepEqual(ready.map((result) => result.status).sort(), [200, 200]);
  const view = await h.read(a);
  assert.equal(view.phase, 'playing');
  assert.deepEqual(view.ready, { A: true, B: true });
  assert.equal(view.revision, revision + 2);
  assert.equal(h.database((db) => db.prepare('SELECT COUNT(*) AS n FROM members').get().n), 2);
});

test('waiting host can ready; GET presence never changes revision', async (t) => {
  const h = await harness(t);
  const a = await h.create();
  const waiting = await h.act(a, { action: 'ready' });
  assert.equal(waiting.phase, 'waiting');
  assert.deepEqual(waiting.ready, { A: true, B: false });
  const b = await h.joinRoom(a);
  const started = await h.act(b, { action: 'ready' });
  assert.equal(started.phase, 'playing');
  h.database((db) => db.prepare('UPDATE members SET last_seen = ? WHERE room_id = ? AND role = ?').run(Date.now() - 21_000, a.id, 'B'));
  const stale = await h.read(a);
  assert.equal(stale.partnerJoined, true);
  assert.equal(stale.partnerOnline, false);
  assert.equal(stale.revision, started.revision);
  assert.equal((await h.read(b)).partnerOnline, true);
  const refreshed = await h.read(a);
  assert.equal(refreshed.partnerOnline, true);
  assert.equal(refreshed.revision, started.revision);
});

test('duo full A/B/A progression: actor checks, once-only clarification, privacy and boundary ending', async (t) => {
  const h = await harness(t);
  const { a, b } = await h.duo();
  const before = await h.read(a);
  assert.equal(before.stage, 'compose');
  assert.equal(before.round.intents.at(-1).label, '我还没想清楚');
  assert.deepEqual(before.round.lines.map((line) => line.style), ['hint', 'direct', 'question']);
  const receiverWaiting = await h.read(b);
  assert.equal(receiverWaiting.stage, 'wait');
  assert.equal(receiverWaiting.round.intents, undefined);
  assert.equal(receiverWaiting.round.lines, undefined);
  errorIs(await h.command(b, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' }), 403, 'WRONG_ACTOR');
  errorIs(await h.command(a, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' }, before.revision - 1), 409, 'REVISION_CONFLICT');
  errorIs(await h.command(a, { action: 'compose', intentId: 'bad', lineId: 'l0hint' }), 400, 'INVALID_CHOICE');
  assert.equal((await h.read(a)).revision, before.revision);
  await h.act(a, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' });
  let receiver = await h.read(b);
  noOpponentPrivate(receiver, 'B');
  assert.equal(receiver.stage, 'interpret');
  assert.equal(receiver.round.lines, undefined);
  assert.equal(receiver.round.intents, undefined);
  assert.equal(receiver.round.interpretations.at(-1).label, '我还不能确定');
  assert.deepEqual(receiver.round.incoming, { text: 'HINT_0' });
  errorIs(await h.command(a, { action: 'clarify' }), 403, 'WRONG_ACTOR');
  errorIs(await h.command(a, { action: 'interpret', guessId: 'i0a', response: 'accept' }), 403, 'WRONG_ACTOR');
  const clarifyRevision = receiver.revision;
  const clarifyId = requestId();
  const clarified = await h.command(b, { action: 'clarify' }, clarifyRevision, clarifyId);
  assert.equal(clarified.status, 200);
  assert.equal(clarified.json.view.round.incoming.clarification, 'ONLY_SELECTED_CLARIFICATION_0_A');
  assert.equal(JSON.stringify(clarified.json).includes('UNSELECTED_CLARIFICATION_0_B'), false);
  assert.equal(JSON.stringify(clarified.json).includes('intentId'), false);
  assert.deepEqual((await h.command(b, { action: 'clarify' }, clarifyRevision, clarifyId)).json, clarified.json);
  errorIs(await h.command(b, { action: 'interpret', guessId: 'i0a', response: 'accept' }, clarifyRevision, clarifyId), 409, 'IDEMPOTENCY_CONFLICT');
  const repeated = await h.act(b, { action: 'clarify' });
  assert.equal(repeated.revision, clarified.json.view.revision);
  receiver = await h.act(b, { action: 'interpret', guessId: 'i0b', response: 'boundary' });
  assert.equal(receiver.roundIndex, 1);
  assert.equal(receiver.stage, 'compose');
  assert.equal(receiver.round.leadIn, 'BOUNDARY_1');
  publicOnly(receiver.records);
  assert.equal(receiver.records[0].reply, 'BOUNDARY_REPLY_0');
  assert.equal(receiver.records[0].clarification, 'ONLY_SELECTED_CLARIFICATION_0_A');
  await h.act(b, { action: 'compose', intentId: 'i1b', lineId: 'l1direct' });
  const aReceiving = await h.read(a);
  noOpponentPrivate(aReceiving);
  assert.equal(aReceiving.round.incoming.text, 'DIRECT_1');
  assert.equal(JSON.stringify(aReceiving).includes('UNSELECTED_CLARIFICATION_1_B'), false);
  await h.act(a, { action: 'interpret', guessId: 'unsure', response: 'accept' });
  await h.act(a, { action: 'compose', intentId: 'unsure', lineId: 'l2question' });
  await h.act(b, { action: 'clarify' });
  const final = await h.act(b, { action: 'interpret', guessId: 'unsure', response: 'accept' });
  assert.equal(final.phase, 'reveal');
  assert.equal(final.reveal.ending, 'ENDING_BOUNDARY');
  assert.deepEqual(final.reveal.roles, fixture.roles);
  assert.equal(final.reveal.records[0].intentId, 'i0a');
  assert.equal(final.reveal.records[1].intentId, 'i1b');
  assert.equal(final.reveal.records[1].interpreted, '我还不能确定');
  assert.equal(final.reveal.records[2].intended, '我还没想清楚');
  assert.equal(final.reveal.records[2].matched, false);
  assert.equal(final.reveal.records[2].asked, true);
  assert.deepEqual((await h.read(a)).reveal, final.reveal);
});

test('solo auto-runs only NPC turns, all three ending branches and unsure never matches', async (t) => {
  const h = await harness(t);
  for (const [options, ending] of [[{}, 'ENDING_OPEN'], [{ clarify: true }, 'ENDING_CLARIFIED'], [{ clarify: true, response: 'boundary' }, 'ENDING_BOUNDARY']]) {
    const { view } = await h.finishSolo(options);
    assert.equal(view.reveal.ending, ending);
    assert.equal(view.role, 'A');
    assert.equal(view.reveal.records[0].guessedId, 'i0b');
    assert.equal(view.reveal.records[0].matched, false);
    assert.equal(view.reveal.records[1].intentId, 'i1a');
    assert.equal(view.reveal.records[1].matched, true);
    assert.equal(view.reveal.records[2].intentId, 'unsure');
    assert.equal(view.reveal.records[2].guessedId, 'unsure');
    assert.equal(view.reveal.records[2].matched, false);
    assert.equal(view.reveal.roles.B.goal, fixture.roles.B.goal);
  }
});

test('duo repair is sender-owned, needs the actual receiver and never overwrites records', async (t) => {
  const h = await harness(t);
  const { a, b } = await h.duo();
  errorIs(await h.command(a, { action: 'repair', index: 0 }), 409, 'WRONG_PHASE');
  const final = await h.finishDuo(a, b);
  const original = structuredClone(final.reveal.records);
  errorIs(await h.command(b, { action: 'repair', index: 0 }), 403, 'WRONG_ACTOR');
  errorIs(await h.command(a, { action: 'repair', index: 1 }), 403, 'WRONG_ACTOR');
  const repairing = await h.act(a, { action: 'repair', index: 0 });
  assert.equal(repairing.phase, 'repair');
  assert.equal(repairing.repair.stage, 'compose');
  assert.ok(repairing.repair.lines.length > 0);
  assert.equal(repairing.repair.interpretations, undefined);
  const waiting = await h.read(b);
  assert.equal(waiting.repair.lines, undefined);
  assert.equal(waiting.repair.interpretations, undefined);
  assert.deepEqual(waiting.repair.original, original[0]);
  errorIs(await h.command(b, { action: 'repair-compose', lineId: 'l0direct' }), 403, 'WRONG_ACTOR');
  errorIs(await h.command(a, { action: 'repair-compose', lineId: 'l0hint' }), 400, 'UNCHANGED_LINE');
  const composed = await h.act(a, { action: 'repair-compose', lineId: 'l0direct' });
  assert.equal(composed.repair.stage, 'interpret');
  assert.equal(composed.repair.text, 'DIRECT_0');
  assert.equal(composed.repair.matched, undefined);
  assert.equal(composed.repair.interpretations, undefined);
  const receiving = await h.read(b);
  assert.ok(receiving.repair.interpretations.length > 0);
  assert.equal(receiving.repair.lines, undefined);
  assert.equal(receiving.repair.stage, 'interpret');
  errorIs(await h.command(a, { action: 'repair-interpret', guessId: 'i0a' }), 403, 'WRONG_ACTOR');
  await h.restart();
  assert.equal((await h.read(b)).repair.stage, 'interpret');
  const repaired = await h.act(b, { action: 'repair-interpret', guessId: 'i0a' });
  assert.equal(repaired.repair.stage, 'done');
  assert.equal(repaired.repair.matched, true);
  assert.deepEqual(repaired.reveal.records, original);
  assert.deepEqual((await h.read(a)).repair, repaired.repair);
  assert.equal((await h.act(b, { action: 'repair-end' })).phase, 'reveal');
  await h.act(b, { action: 'repair', index: 1 });
  assert.equal((await h.act(a, { action: 'repair-end' })).phase, 'reveal');
  await h.act(a, { action: 'repair', index: 2 });
  await h.act(a, { action: 'repair-compose', lineId: 'l2direct' });
  assert.equal((await h.act(b, { action: 'repair-end' })).phase, 'reveal');
  assert.deepEqual((await h.read(a)).reveal.records, original);
});

test('solo can swap into B after reveal and repair all three rounds without rewriting history', async (t) => {
  const h = await harness(t);
  const { a, view } = await h.finishSolo();
  const original = structuredClone(view.reveal.records);
  for (const index of [0, 1, 2]) {
    await h.act(a, { action: 'repair', index });
    const result = await h.act(a, { action: 'repair-compose', lineId: `l${index}direct` });
    assert.equal(result.repair.stage, 'done');
    // Fixture rounds 0 and 1 intend i{n}a; round 2 deliberately intends 'unsure'.
    assert.equal(result.repair.matched, index !== 2);
    assert.deepEqual(result.reveal.records, original);
    await h.act(a, { action: 'repair-end' });
  }
});

test('refresh/restart persists hidden pending state, role, ready flags and exact retry receipts', async (t) => {
  const h = await harness(t);
  const { a, b } = await h.duo();
  const revision = (await h.read(a)).revision;
  const id = requestId();
  const body = { action: 'compose', intentId: 'i0a', lineId: 'l0hint' };
  const composed = await h.command(a, body, revision, id);
  await h.act(b, { action: 'clarify' });
  const before = await h.read(b);
  await h.restart();
  assert.deepEqual(await h.read(b), before);
  noOpponentPrivate(await h.read(a));
  assert.deepEqual((await h.command(a, body, revision, id)).json, composed.json);
  assert.equal((await h.read(a)).revision, before.revision);
  assert.deepEqual((await h.api('POST', '/rooms', { body: a.createBody })).json.view, a.view);
  await h.act(b, { action: 'interpret', guessId: 'i0a', response: 'accept' });
  const current = await h.read(a);
  assert.equal(current.roundIndex, 1);
  assert.equal(current.records.length, 1);
});

test('leave is durable and closes both participants without ghost replacement', async (t) => {
  const h = await harness(t);
  const { a, b } = await h.duo();
  const revision = (await h.read(a)).revision;
  const id = requestId();
  const closed = await h.command(a, { action: 'leave' }, revision, id);
  assert.equal(closed.status, 200);
  assert.equal(closed.json.view.phase, 'closed');
  assert.equal(closed.json.view.partnerOnline, false);
  assert.equal((await h.read(b)).phase, 'closed');
  assert.deepEqual((await h.command(a, { action: 'leave' }, revision, id)).json, closed.json);
  for (const participant of [a, b]) errorIs(await h.command(participant, { action: 'ready' }, closed.json.view.revision), 410, 'ROOM_CLOSED');
  errorIs(await h.api('POST', `/rooms/${a.id}/join`, { body: { token: token(), requestId: requestId() } }), 410, 'ROOM_CLOSED');
  errorIs(await h.api('POST', '/rooms', { body: a.createBody }), 410, 'ROOM_CLOSED');
  await h.restart();
  assert.equal((await h.read(b)).phase, 'closed');
  assert.equal(h.database((db) => db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id = ?').get(a.id).n), 2);
});

test('24-hour expiry blocks reads and mutations; retention cleanup cascades operation logs', async (t) => {
  const h = await harness(t);
  const a = await h.create();
  h.database((db) => db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, a.id));
  errorIs(await h.api('GET', `/rooms/${a.id}`, { token: a.token }), 410, 'ROOM_EXPIRED');
  errorIs(await h.command(a, { action: 'ready' }, 0), 410, 'ROOM_EXPIRED');
  errorIs(await h.api('POST', `/rooms/${a.id}/join`, { body: { token: token(), requestId: requestId() } }), 410, 'ROOM_EXPIRED');
  errorIs(await h.api('POST', '/rooms', { body: a.createBody }), 410, 'ROOM_EXPIRED');
  assert.equal(h.database((db) => db.prepare('SELECT COUNT(*) AS n FROM operations').get().n), 1);
  h.database((db) => db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 3_601_000, a.id));
  await h.restart();
  for (const table of ['rooms', 'members', 'operations']) assert.equal(h.database((db) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
  errorIs(await h.api('GET', `/rooms/${a.id}`, { token: a.token }), 404, 'ROOM_NOT_FOUND');
});

test('room expiry is checked after a slow upload, not before reading its body', async (t) => {
  const h = await harness(t);
  const a = await h.create('solo');
  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ action: 'ready', revision: 0, requestId: requestId() });
    const req = httpRequest(`${h.base()}/rooms/${a.id}/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json', Expect: '100-continue' },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.on('continue', () => {
      req.write(body.slice(0, 10));
      // Simulate a request that crosses the expiry boundary while uploading JSON.
      setTimeout(() => {
        try {
          h.database((db) => db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 1, a.id));
          req.end(body.slice(10));
        } catch (error) { req.destroy(); reject(error); }
      }, 30);
    });
    req.flushHeaders();
  });
  errorIs(result, 410, 'ROOM_EXPIRED');
  assert.equal(h.database((db) => JSON.parse(db.prepare('SELECT state FROM rooms WHERE id = ?').get(a.id).state).revision), 0);
});

test('strict JSON, 16KB limit, request IDs, finite integers and command contract reject malformed input', async (t) => {
  const h = await harness(t);
  const a = await h.create('solo');
  const good = { storyId: fixture.id, mode: 'solo', token: token(), requestId: requestId() };
  for (const bad of [null, [], 'hello', { ...good, extra: true }, { ...good, token: 'A'.repeat(64) }, { ...good, requestId: '../bad' }, { ...good, requestId: 'x'.repeat(81) }, { ...good, requestId: '' }, { ...good, mode: 'invalid' }]) {
    assert.equal((await h.api('POST', '/rooms', { body: bad })).status, 400);
  }
  errorIs(await h.api('POST', '/rooms', { body: good, headers: { 'Content-Type': 'text/plain' } }), 400, 'INVALID_CONTENT_TYPE');
  errorIs(await h.api('POST', '/rooms', { raw: '{not json' }), 400, 'INVALID_JSON');
  errorIs(await h.api('POST', '/rooms', { raw: ' '.repeat(16 * 1024 + 1) }), 400, 'BODY_TOO_LARGE');
  const chunked = await new Promise((resolve, reject) => {
    const req = httpRequest(`${h.base()}/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(' '.repeat(9000));
    req.end(' '.repeat(9000));
  });
  errorIs(chunked, 400, 'BODY_TOO_LARGE');
  for (const revision of [-1, 1.5, null, Number.MAX_SAFE_INTEGER + 1, '0']) {
    errorIs(await h.api('POST', `/rooms/${a.id}/commands`, { token: a.token, body: { action: 'ready', requestId: requestId(), revision } }), 400, 'INVALID_REVISION');
  }
  for (const extra of [{ token: a.token }, { role: 'B' }, { index: 0 }, { intentId: 'evil' }]) {
    errorIs(await h.api('POST', `/rooms/${a.id}/commands`, { token: a.token, body: { action: 'ready', requestId: requestId(), revision: 0, ...extra } }), 400, 'INVALID_BODY');
  }
  for (const index of [-1, 3, 0.5, null, '0']) errorIs(await h.command(a, { action: 'repair', index }, 0), 400, 'INVALID_INDEX');
  errorIs(await h.command(a, { action: 'constructor' }, 0), 400, 'INVALID_COMMAND');
  errorIs(await h.api('POST', `/rooms/${a.id}/join`, { body: { token: token(), requestId: requestId() } }), 409, 'SOLO_ROOM');
  assert.equal((await h.read(a)).revision, 0);
});

test('per-IP rate limits return JSON 429 and keep independent command allowances', async (t) => {
  const h = await harness(t);
  const a = await h.create('solo');
  for (let i = 1; i < 60; i += 1) assert.equal((await h.api('POST', '/rooms', { body: a.createBody })).status, 200);
  const limited = await h.api('POST', '/rooms', { body: a.createBody });
  errorIs(limited, 429, 'RATE_LIMITED');
  assert.equal(limited.headers.get('retry-after'), '60');
  const readyBody = { action: 'ready', revision: 0, requestId: requestId() };
  for (let i = 0; i < 240; i += 1) {
    assert.equal((await h.api('POST', `/rooms/${a.id}/commands`, { token: a.token, body: readyBody })).status, 200);
  }
  errorIs(await h.api('POST', `/rooms/${a.id}/commands`, { token: a.token, body: readyBody }), 429, 'RATE_LIMITED');
  assert.equal((await h.read(a)).phase, 'playing');
});

test('active-room and per-room receipt caps prevent unbounded storage, but leave remains available', async (t) => {
  const h = await harness(t);
  const a = await h.create('solo');
  h.database((db) => {
    const source = db.prepare('SELECT * FROM rooms WHERE id = ?').get(a.id);
    const insert = db.prepare('INSERT INTO rooms(id, state, expires_at) VALUES (?, ?, ?)');
    const operation = db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 499; i += 1) insert.run(`cap${String(i).padStart(7, '0')}`, source.state, source.expires_at);
    for (let i = 0; i < 1023; i += 1) operation.run(sha(a.token), `receipt-${i}`, 'test-digest', a.id, '{}', Date.now());
    db.exec('COMMIT');
  });
  errorIs(await h.api('POST', '/rooms', { body: { storyId: fixture.id, mode: 'solo', token: token(), requestId: requestId() } }), 503, 'ROOM_CAPACITY');
  errorIs(await h.command(a, { action: 'ready' }, 0), 503, 'ROOM_OPERATION_LIMIT');
  const closed = await h.act(a, { action: 'leave' });
  assert.equal(closed.phase, 'closed');
  h.database((db) => db.prepare('UPDATE rooms SET closed_at = ? WHERE id = ?').run(Date.now() - 3_601_000, a.id));
  await h.restart();
  assert.equal((await h.read(a)).phase, 'closed');
  errorIs(await h.api('POST', '/rooms', { body: a.createBody }), 410, 'ROOM_CLOSED');
  h.database((db) => db.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 3_601_000, a.id));
  await h.restart();
  assert.equal(h.database((db) => db.prepare('SELECT COUNT(*) AS n FROM operations WHERE room_id = ?').get(a.id).n), 0);
  assert.equal(h.database((db) => db.prepare('SELECT COUNT(*) AS n FROM members WHERE room_id = ?').get(a.id).n), 0);
});
