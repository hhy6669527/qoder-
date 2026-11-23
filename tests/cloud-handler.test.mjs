import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { application } from '../functions/cloud-handler.mjs';
import { createCloudStore } from '../functions/cloud-store.mjs';

const ORIGIN = 'https://test.example';
const ROOMS = 'wavelength_rooms';
const LIMITS = 'wavelength_limits';
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 29, 12);
const clone = (value) => structuredClone(value);
const token = () => randomBytes(32).toString('hex');
const key = () => randomUUID();
const sha = (text) => createHash('sha256').update(text).digest('hex');
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
      { id: `i${index}a`, label: `一起吃饭 ${index}`, clarification: `SELECTED_CLARIFICATION_${index}` },
      { id: `i${index}b`, label: `休息 ${index}`, clarification: `OTHER_CLARIFICATION_${index}` },
    ],
    lines: [
      { id: `l${index}hint`, text: `HINT_${index}`, style: 'hint' },
      { id: `l${index}direct`, text: `DIRECT_${index}`, style: 'direct' },
    ],
    replies: { accept: `ACCEPT_${index}`, boundary: `BOUNDARY_REPLY_${index}` },
    npc: { intent: `i${index}a`, line: `l${index}hint`, guessByLine: { [`l${index}hint`]: `i${index}b`, [`l${index}direct`]: `i${index}a` } },
    insight: `INSIGHT_${index}`,
  })),
  endings: { clarified: 'ENDING_CLARIFIED', boundary: 'ENDING_BOUNDARY', open: 'ENDING_OPEN' },
  takeaway: '不是心理评分，只是回看表达。',
};

// Credential-free atomic SDK fixture. This executes the real store adapter, but
// does NOT establish live provider CAS, ingress or row-policy guarantees.
class AtomicDatabase {
  tables = { [ROOMS]: new Map(), [LIMITS]: new Map() };
  calls = [];
  failures = [];
  conflicts = 0;
  gate = null;
  beforeDelete = null;
  from(table) {
    assert.ok(this.tables[table], `Unexpected table ${table}`);
    const db = this;
    const q = { table, kind: 'select', filters: [], cap: Infinity };
    const builder = {
      select(fields) { q.fields = fields; return builder; },
      eq(field, value) { q.filters.push([field, value]); return builder; },
      limit(value) { q.cap = value; return builder; },
      order(field, options) { q.order = { field, ...options }; return builder; },
      insertIfAbsent(row, options) { assert.equal(options.onConflict, 'id'); q.kind = 'insert'; q.row = clone(row); return builder; },
      update(row) { q.kind = 'update'; q.row = clone(row); return builder; },
      delete() { q.kind = 'delete'; return builder; },
      then(resolve, reject) { return db.execute(q).then(resolve, reject); },
    };
    return builder;
  }
  fail(table, kind, mode, count = 1) { this.failures.push({ table, kind, mode, count }); }
  synchronizeReads(table, id, count = 2) { this.gate = { table, id, count, waiting: [] }; }
  async execute(q) {
    this.calls.push(clone(q));
    const failure = this.failures.find((item) => item.count && item.table === q.table && item.kind === q.kind);
    if (failure) failure.count -= 1;
    if (failure?.mode === 'throw') throw new Error('PRIVATE_PROVIDER_CREDENTIAL');
    if (failure?.mode === 'error') return { data: [], error: { message: 'PRIVATE_PROVIDER_CREDENTIAL' } };
    if (failure?.mode === 'unknown') return { data: null, error: null };
    if (failure?.mode === 'conflict') { this.conflicts += 1; return { data: [], error: null }; }
    if (q.kind === 'delete' && this.beforeDelete) this.beforeDelete(q, this.tables[q.table]);
    const table = this.tables[q.table];
    let found = [...table.values()].filter((row) => q.filters.every(([field, value]) => row[field] === value));
    if (q.order) found.sort((a, b) => (a[q.order.field] - b[q.order.field]) * (q.order.ascending ? 1 : -1));
    found = found.slice(0, q.cap);
    let data;
    if (q.kind === 'insert') {
      if (table.has(q.row.id)) { data = []; this.conflicts += 1; }
      else { table.set(q.row.id, clone(q.row)); data = [q.row]; }
    } else if (q.kind === 'update') {
      assert.equal(q.filters.some(([field]) => field === 'id'), true);
      assert.equal(q.filters.some(([field]) => field === 'version'), true);
      data = found.map((row) => ({ ...row, ...clone(q.row) }));
      for (const row of data) table.set(row.id, row);
      if (!data.length) this.conflicts += 1;
    } else if (q.kind === 'delete') {
      assert.deepEqual(q.filters.map(([field]) => field), ['id', 'version']);
      data = found;
      for (const row of found) table.delete(row.id);
    } else data = found;
    data = data.map((row) => Object.fromEntries(q.fields.split(',').map((field) => [field, clone(row[field])])));
    if (failure?.mode === 'lost') throw new Error('PRIVATE_PROVIDER_RESPONSE_LOST');
    if (failure?.mode === 'lost-unknown') return { error: null };
    const gate = this.gate;
    if (q.kind === 'select' && !q.order && gate?.table === q.table && q.filters.some(([field, value]) => field === 'id' && value === gate.id)) {
      await new Promise((resolve) => {
        gate.waiting.push(resolve);
        if (gate.waiting.length === gate.count) {
          this.gate = null;
          for (const release of gate.waiting) release();
        }
      });
    }
    return { data, error: null };
  }
}

function harness() {
  const db = new AtomicDatabase();
  const store = createCloudStore(db);
  let time = START;
  const stories = [clone(fixture)];
  const app = application({ store, stories, origin: ORIGIN, now: () => time });
  async function api(method, path, { body, credential, headers = {}, raw, prefix = '/functions/v1/app', handler = app } = {}) {
    const requestHeaders = new Headers({ ...(method === 'POST' ? { Origin: ORIGIN } : {}), ...headers });
    if (body !== undefined || raw !== undefined) {
      if (!requestHeaders.has('content-type')) requestHeaders.set('Content-Type', 'application/json');
    }
    if (credential) requestHeaders.set('Authorization', `Bearer ${credential}`);
    for (const [name, value] of Object.entries(headers)) if (value === null) requestHeaders.delete(name);
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const response = await handler(new Request(`${ORIGIN}${prefix}${path}`, {
      method, headers: requestHeaders, body: payload, ...(payload instanceof ReadableStream ? { duplex: 'half' } : {}),
    }));
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function read(session) {
    const result = await api('GET', `/api/rooms/${session.id}`, { credential: session.token });
    success(result);
    return result.json.view;
  }
  async function create(mode = 'duo') {
    const body = { storyId: fixture.id, mode, token: token(), requestId: key() };
    const result = await api('POST', '/api/rooms', { body });
    success(result);
    return { id: result.json.view.id, token: body.token, view: result.json.view, body };
  }
  async function join(session, credential = token(), requestId = key()) {
    const result = await api('POST', `/api/rooms/${session.id}/join`, { body: { token: credential, requestId } });
    return { result, session: { id: session.id, token: credential, view: result.json.view }, body: { token: credential, requestId } };
  }
  async function command(session, body, revision, requestId = key()) {
    return api('POST', `/api/rooms/${session.id}/commands`, {
      credential: session.token, body: { revision: revision ?? (await read(session)).revision, requestId, ...body },
    });
  }
  async function act(session, body) { const result = await command(session, body); success(result); return result.json.view; }
  async function duo() {
    const a = await create();
    const b = await join(a);
    success(b.result);
    await act(a, { action: 'ready' });
    await act(b.session, { action: 'ready' });
    return { a, b: b.session };
  }
  return { db, store, app, stories, api, read, create, join, command, act, duo,
    setTime: (next) => { time = next; }, time: () => time,
    row: (id) => clone(db.tables[ROOMS].get(id)),
  };
}
function success(result) { assert.equal(result.status, 200, JSON.stringify(result.json)); }
function errorIs(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.json.error.code, code);
  assert.deepEqual(Object.keys(result.json), ['error']);
  assert.deepEqual(Object.keys(result.json.error).sort(), ['code', 'message']);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(result.json).includes('PRIVATE_PROVIDER'), false);
}
const writes = (db, table = ROOMS) => db.calls.filter((call) => call.table === table && call.kind !== 'select');
function hidden(view, role) {
  const text = JSON.stringify(view);
  assert.equal(text.includes(`PRIVATE_${role === 'A' ? 'B' : 'A'}_`), false);
  for (const secret of ['guessByLine', 'intentId', 'guessedId']) assert.equal(text.includes(secret), false);
  assert.equal(view.story.rounds, undefined);
  assert.equal(view.reveal, undefined);
}

test('logical and physical normalization, anonymous catalog, read-only database health and safe failures', async () => {
  const h = harness();
  for (const prefix of ['/app', '/functions/v1/app', `/app-d${'a'.repeat(32)}`, `/functions/v1/app-d${'0'.repeat(32)}`]) {
    const result = await h.api('GET', '/api/health', { prefix });
    success(result);
    assert.deepEqual(result.json, { ok: true, environment: 'cloud', persistence: 'database' });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(h.db.calls.length, 4);
  assert.ok(h.db.calls.every((call) => call.kind === 'select' && call.cap === 1 && !call.order));
  const catalog = await h.api('GET', '/api/stories', { headers: { user: 'admin', 'x-qoder-user-id': 'admin', clientrole: 'admin' } });
  success(catalog);
  for (const secret of ['PRIVATE_', 'PROMPT_', 'CLARIFICATION_', 'ENDING_', 'npc', 'rounds', 'roles', 'takeaway']) assert.equal(JSON.stringify(catalog.json).includes(secret), false);
  assert.deepEqual(catalog.json.stories[0].cast, { A: { name: '阿青', identity: '朋友 A' }, B: { name: '小白', identity: '朋友 B' } });
  for (const prefix of ['', '/other', '/application', '/app-extra', `/app-d${'a'.repeat(31)}`, `/app-d${'A'.repeat(32)}`]) errorIs(await h.api('GET', '/api/health', { prefix }), 404, 'NOT_FOUND');
  errorIs(await h.api('GET', '/api/health?token=hidden'), 400, 'INVALID_URL');
  h.db.fail(ROOMS, 'select', 'error');
  errorIs(await h.api('GET', '/api/health'), 503, 'SERVICE_UNAVAILABLE');
  assert.equal(writes(h.db).length, 0);
});

test('all writes require the exact fixed origin; membership ignores platform headers', async () => {
  const h = harness();
  const a = await h.create();
  for (const origin of [null, 'null', 'https://evil.example', `${ORIGIN}/`, `${ORIGIN}:443`, 'https://test.example.evil.example', 'http://test.example']) {
    for (const path of ['/api/rooms', `/api/rooms/${a.id}/join`, `/api/rooms/${a.id}/commands`, `/api/rooms/${a.id}/presence`]) {
      errorIs(await h.api('POST', path, { body: {}, credential: a.token, headers: { Origin: origin } }), 403, 'ORIGIN_FORBIDDEN');
    }
  }
  success(await h.api('GET', `/api/rooms/${a.id}`, { credential: a.token }));
  errorIs(await h.api('GET', `/api/rooms/${a.id}`, { headers: { user: a.token, 'x-qoder-user-id': a.token, clientrole: 'A' } }), 401, 'UNAUTHORIZED');
  errorIs(await h.api('GET', `/api/rooms/${a.id}`, { credential: token() }), 403, 'FORBIDDEN');
  errorIs(await h.api('POST', `/api/rooms/${a.id}/presence`, { credential: a.token, body: { role: 'B' } }), 400, 'INVALID_BODY');
  assert.throws(() => application({ store: h.store, stories: [fixture], origin: `${ORIGIN}/` }));
});

test('deterministic creation, hashed-only private storage, immutable stories and current-view recovery', async () => {
  const h = harness();
  h.stories[0].roles.A.goal = 'CHANGED_AFTER_FACTORY';
  const a = await h.create('solo');
  assert.equal(a.id, sha(sha(a.token) + a.body.requestId).slice(0, 24));
  assert.equal(a.view.ownRole.goal, 'PRIVATE_A_GOAL');
  assert.equal(a.view.expiresAt, START + DAY);
  hidden(a.view, 'A');
  const stored = h.row(a.id);
  assert.equal(stored.state.creation.ownerHash, sha(a.token));
  assert.equal(stored.state.members.A.actorHash, sha(a.token));
  assert.equal(JSON.stringify([...h.db.tables[ROOMS].values()]).includes(a.token), false);
  assert.equal(JSON.stringify(a.view).includes(sha(a.token)), false);
  const current = await h.act(a, { action: 'ready' });
  const before = h.row(a.id);
  const restarted = application({ store: h.store, stories: [{ ...clone(fixture), title: 'NEW_CATALOG_TITLE' }], origin: ORIGIN, now: h.time });
  const replay = await h.api('POST', '/api/rooms', { handler: restarted, prefix: `/app-d${'a'.repeat(32)}`, body: { requestId: a.body.requestId, token: a.token, mode: 'solo', storyId: fixture.id } });
  success(replay);
  assert.deepEqual(replay.json.view, current);
  assert.deepEqual(h.row(a.id), before);
  errorIs(await h.api('POST', '/api/rooms', { body: { ...a.body, mode: 'duo' } }), 409, 'IDEMPOTENCY_CONFLICT');
  errorIs(await h.api('POST', '/api/rooms', { body: { ...a.body, storyId: 'missing' } }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal(h.db.tables[LIMITS].get('create:2026-11-29').value, 1);
});

test('simultaneous deterministic creation recovers one room or rejects a different original payload', async () => {
  for (const conflicting of [false, true]) {
    const h = harness();
    const body = { storyId: fixture.id, mode: 'duo', token: token(), requestId: key() };
    const id = sha(sha(body.token) + body.requestId).slice(0, 24);
    h.db.synchronizeReads(ROOMS, id);
    const results = await Promise.all([
      h.api('POST', '/api/rooms', { body }),
      h.api('POST', '/api/rooms', { body: conflicting ? { ...body, mode: 'solo' } : body }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), conflicting ? [200, 409] : [200, 200]);
    if (conflicting) errorIs(results.find((result) => result.status === 409), 409, 'IDEMPOTENCY_CONFLICT');
    else assert.deepEqual(results[0].json, results[1].json);
    assert.equal(h.db.tables[ROOMS].size, 1);
    assert.equal(h.row(id).version, 0);
    assert.equal(h.row(id).state.receipts.length, 1);
    assert.equal(h.db.tables[LIMITS].get('create:2026-11-29').value, 2); // Conservative reservations are permitted.
  }
});

test('bounded streaming JSON, content type and strict fields/revisions/choice identifiers', async () => {
  const h = harness();
  for (const [raw, code] of [['{', 'INVALID_JSON'], ['[]', 'INVALID_BODY'], ['null', 'INVALID_BODY']]) errorIs(await h.api('POST', '/api/rooms', { raw }), 400, code);
  errorIs(await h.api('POST', '/api/rooms', { body: {}, headers: { 'Content-Type': 'text/plain' } }), 400, 'INVALID_CONTENT_TYPE');
  errorIs(await h.api('POST', '/api/rooms', { body: {}, headers: { 'Content-Length': '16385' } }), 400, 'BODY_TOO_LARGE');
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { cancelled = true; },
  });
  errorIs(await h.api('POST', '/api/rooms', { raw: stream, headers: { 'Content-Length': '1' } }), 400, 'BODY_TOO_LARGE');
  assert.equal(cancelled, true);
  const body = { storyId: fixture.id, mode: 'duo', token: token(), requestId: key() };
  for (const extra of [{ role: 'B' }, { user: 'admin' }, { token: 'x' }, { requestId: '../bad' }, { storyId: {} }]) {
    const result = await h.api('POST', '/api/rooms', { body: { ...body, ...extra } });
    assert.equal(result.status, 400);
  }
  const a = await h.create('solo');
  for (const [command, code] of [
    [{ action: 'ready', revision: -1 }, 'INVALID_REVISION'],
    [{ action: 'ready', revision: 1.1 }, 'INVALID_REVISION'],
    [{ action: 'ready', revision: '0' }, 'INVALID_REVISION'],
    [{ action: 'ready', extra: true }, 'INVALID_BODY'],
    [{ action: 'compose', intentId: {}, lineId: 'x' }, 'INVALID_CHOICE'],
    [{ action: 'compose', intentId: 'x'.repeat(101), lineId: 'x' }, 'INVALID_CHOICE'],
    [{ action: 'repair', index: 3 }, 'INVALID_INDEX'],
    [{ action: 'repair', index: 0.5 }, 'INVALID_INDEX'],
    [{ action: 'interpret', guessId: 'x', response: 'yes' }, 'INVALID_RESPONSE'],
    [{ action: '__proto__' }, 'INVALID_COMMAND'],
  ]) errorIs(await h.command(a, command, 0), 400, code);
  assert.equal(h.row(a.id).version, 0);
});

test('simultaneous joins uniquely assign B; token recovery cannot add a replacement', async () => {
  const h = harness();
  const a = await h.create();
  h.db.synchronizeReads(ROOMS, a.id);
  const results = await Promise.all([h.join(a), h.join(a)]);
  assert.deepEqual(results.map((entry) => entry.result.status).sort(), [200, 409]);
  const winner = results.find((entry) => entry.result.status === 200);
  const loser = results.find((entry) => entry.result.status === 409);
  errorIs(loser.result, 409, 'ROOM_FULL');
  assert.equal(winner.result.json.view.role, 'B');
  assert.equal(h.row(a.id).state.members.B.actorHash, sha(winner.session.token));
  assert.equal(h.row(a.id).state.game.revision, 1);
  assert.equal(h.db.conflicts, 1);
  const recovered = await h.join(a, winner.session.token);
  success(recovered.result);
  assert.equal(recovered.result.json.view.role, 'B');
  assert.equal(recovered.result.json.view.revision, 1);
  const before = h.row(a.id);
  const exact = await h.api('POST', `/api/rooms/${a.id}/join`, { body: winner.body });
  success(exact);
  assert.deepEqual(h.row(a.id), before);
  errorIs((await h.join(a)).result, 409, 'ROOM_FULL');
});

test('simultaneous ready CAS safely merges flags, while future or late readiness conflicts', async () => {
  const h = harness();
  const a = await h.create();
  const joined = await h.join(a);
  success(joined.result);
  h.db.synchronizeReads(ROOMS, a.id);
  const results = await Promise.all([h.command(a, { action: 'ready' }, 1), h.command(joined.session, { action: 'ready' }, 1)]);
  results.forEach(success);
  const view = await h.read(a);
  assert.equal(view.phase, 'playing');
  assert.deepEqual(view.ready, { A: true, B: true });
  assert.equal(view.revision, 3);
  assert.equal(h.row(a.id).version, 3);
  assert.equal(h.row(a.id).state.receipts.length, 4);
  assert.equal(h.db.conflicts, 1);
  errorIs(await h.command(a, { action: 'ready' }, 1), 409, 'REVISION_CONFLICT');
  const waiting = await h.create();
  errorIs(await h.command(waiting, { action: 'ready' }, 4), 409, 'REVISION_CONFLICT');
  await h.act(waiting, { action: 'ready' });
  const b = await h.join(waiting);
  success(b.result);
  const merged = await h.command(b.session, { action: 'ready' }, 0);
  success(merged);
  assert.equal(merged.json.view.phase, 'playing');
});

test('duo flow preserves role privileges and hidden intent until reveal; meaningful stale CAS never rebases', async () => {
  const h = harness();
  const { a, b } = await h.duo();
  hidden(await h.read(a), 'A');
  hidden(await h.read(b), 'B');
  errorIs(await h.command(b, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' }), 403, 'WRONG_ACTOR');
  const revision = (await h.read(a)).revision;
  h.db.synchronizeReads(ROOMS, a.id);
  const racing = await Promise.all([
    h.command(a, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' }, revision),
    h.command(a, { action: 'compose', intentId: 'i0b', lineId: 'l0direct' }, revision),
  ]);
  assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);
  errorIs(racing.find((result) => result.status === 409), 409, 'REVISION_CONFLICT');
  const beforeClarify = await h.read(b);
  hidden(beforeClarify, 'B');
  assert.equal(beforeClarify.round.incoming.clarification, undefined);
  const clarified = await h.act(b, { action: 'clarify' });
  const selectedId = h.row(a.id).state.game.pending.intentId;
  const selected = fixture.rounds[0].intents.find((intent) => intent.id === selectedId);
  const unselected = fixture.rounds[0].intents.find((intent) => intent.id !== selectedId);
  assert.equal(clarified.round.incoming.clarification, selected.clarification);
  assert.equal(JSON.stringify(clarified).includes(unselected.clarification), false);
  hidden(clarified, 'B');
  await h.act(b, { action: 'interpret', guessId: 'i0b', response: 'accept' });
  for (const index of [1, 2]) {
    const sender = index === 1 ? b : a;
    const receiver = index === 1 ? a : b;
    await h.act(sender, { action: 'compose', intentId: `i${index}a`, lineId: `l${index}hint` });
    if (index === 1) hidden(await h.read(a), 'A');
    await h.act(receiver, { action: 'interpret', guessId: `i${index}b`, response: 'accept' });
  }
  const view = await h.read(a);
  assert.equal(view.phase, 'reveal');
  assert.equal(view.reveal.records.length, 3);
  assert.equal(view.reveal.roles.B.goal, 'PRIVATE_B_GOAL');
  errorIs(await h.command(a, { action: 'repair', index: 1 }), 403, 'WRONG_ACTOR');
  await h.act(b, { action: 'repair', index: 1 });
  await h.act(b, { action: 'repair-compose', lineId: 'l1direct' });
  await h.act(a, { action: 'repair-interpret', guessId: 'i1a' });
  const repaired = await h.act(a, { action: 'repair-end' });
  assert.deepEqual(repaired.reveal.records, view.reveal.records);
});

test('solo NPC flow and post-reveal role swap repair preserve original records', async () => {
  const h = harness();
  const a = await h.create('solo');
  errorIs((await h.join(a)).result, 409, 'SOLO_ROOM');
  await h.act(a, { action: 'ready' });
  const first = await h.act(a, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' });
  assert.equal(first.roundIndex, 1);
  assert.equal(first.stage, 'interpret');
  hidden(first, 'A');
  await h.act(a, { action: 'interpret', guessId: 'unsure', response: 'boundary' });
  const reveal = await h.act(a, { action: 'compose', intentId: 'unsure', lineId: 'l2hint' });
  assert.equal(reveal.phase, 'reveal');
  assert.equal(reveal.reveal.ending, 'ENDING_BOUNDARY');
  assert.equal(reveal.reveal.records[2].matched, false);
  const swapped = await h.act(a, { action: 'repair', index: 1 });
  assert.equal(swapped.role, 'A');
  assert.equal(swapped.repair.speaker, 'B');
  assert.ok(swapped.repair.lines.some((line) => line.id === 'l1direct'));
  const repaired = await h.act(a, { action: 'repair-compose', lineId: 'l1direct' });
  assert.equal(repaired.repair.stage, 'done');
  assert.deepEqual(repaired.reveal.records, reveal.reveal.records);
  assert.equal((await h.act(a, { action: 'repair-end' })).phase, 'reveal');
});

test('GET and exact retries never write; presence has 60-second visibility and independent storage version', async () => {
  const h = harness();
  const a = await h.create();
  const b = await h.join(a);
  success(b.result);
  const baseline = h.row(a.id);
  const writeCount = writes(h.db).length;
  h.setTime(START + 59_999);
  assert.equal((await h.read(a)).partnerOnline, true);
  h.setTime(START + 60_000);
  assert.equal((await h.read(a)).partnerOnline, false);
  assert.equal((await h.read(b.session)).partnerOnline, false);
  assert.deepEqual(h.row(a.id), baseline);
  assert.equal(writes(h.db).length, writeCount);
  success(await h.api('POST', `/api/rooms/${a.id}/presence`, { credential: b.session.token, body: {} }));
  assert.equal((await h.read(a)).partnerOnline, true);
  assert.equal(h.row(a.id).version, baseline.version + 1);
  assert.equal(h.row(a.id).state.game.revision, baseline.state.game.revision);
  assert.deepEqual(h.row(a.id).state.receipts, baseline.state.receipts);
  const revision = (await h.read(a)).revision;
  const requestId = key();
  success(await h.command(a, { action: 'ready' }, revision, requestId));
  await h.act(b.session, { action: 'ready' });
  h.setTime(START + 120_000);
  const beforeReplay = h.row(a.id);
  const replay = await h.command(a, { action: 'ready' }, revision, requestId);
  success(replay);
  assert.equal(replay.json.view.phase, 'playing');
  assert.equal(replay.json.view.partnerOnline, false);
  assert.deepEqual(h.row(a.id), beforeReplay);
  h.db.synchronizeReads(ROOMS, a.id);
  const result = await Promise.all([
    h.api('POST', `/api/rooms/${a.id}/presence`, { credential: b.session.token, body: {} }),
    h.command(a, { action: 'compose', intentId: 'i0a', lineId: 'l0hint' }, beforeReplay.state.game.revision),
  ]);
  result.forEach(success);
  assert.equal(h.row(a.id).state.game.revision, beforeReplay.state.game.revision + 1);
  assert.equal(h.row(a.id).version, beforeReplay.version + 2);
});

test('expiry is exactly 24 hours; closed room is readable but only the exact leave receipt can replay', async () => {
  const h = harness();
  const a = await h.create('solo');
  const readyId = key();
  success(await h.command(a, { action: 'ready' }, 0, readyId));
  const leaveId = key();
  const closed = await h.command(a, { action: 'leave' }, 1, leaveId);
  success(closed);
  assert.equal((await h.read(a)).phase, 'closed');
  const before = h.row(a.id);
  success(await h.command(a, { action: 'leave' }, 1, leaveId));
  assert.deepEqual(h.row(a.id), before);
  errorIs(await h.command(a, { action: 'ready' }, 0, readyId), 410, 'ROOM_CLOSED');
  errorIs(await h.command(a, { action: 'leave' }, 2), 410, 'ROOM_CLOSED');
  errorIs(await h.api('POST', `/api/rooms/${a.id}/presence`, { credential: a.token, body: {} }), 410, 'ROOM_CLOSED');
  errorIs((await h.join(a)).result, 410, 'ROOM_CLOSED');
  h.setTime(START + DAY);
  errorIs(await h.api('GET', `/api/rooms/${a.id}`, { credential: a.token }), 410, 'ROOM_EXPIRED');
  errorIs(await h.command(a, { action: 'leave' }, 1, leaveId), 410, 'ROOM_EXPIRED');
  errorIs(await h.api('POST', '/api/rooms', { body: a.body }), 410, 'ROOM_EXPIRED');
  errorIs(await h.api('POST', `/api/rooms/${a.id}/presence`, { credential: a.token, body: {} }), 410, 'ROOM_EXPIRED');
  errorIs((await h.join(a)).result, 410, 'ROOM_EXPIRED');
  assert.deepEqual(h.row(a.id), before);
});

test('duplicate concurrent commands commit one receipt and reject altered payloads', async () => {
  const h = harness();
  const a = await h.create('solo');
  const requestId = key();
  h.db.synchronizeReads(ROOMS, a.id);
  const results = await Promise.all([h.command(a, { action: 'ready' }, 0, requestId), h.command(a, { action: 'ready' }, 0, requestId)]);
  results.forEach(success);
  assert.equal(h.row(a.id).version, 1);
  assert.equal(h.row(a.id).state.receipts.filter((item) => item.requestId === requestId).length, 1);
  errorIs(await h.command(a, { action: 'leave' }, 0, requestId), 409, 'IDEMPOTENCY_CONFLICT');
  errorIs(await h.command(a, { action: 'ready' }, 1, requestId), 409, 'IDEMPOTENCY_CONFLICT');
  errorIs(await h.command(a, { action: 'ready' }, 1, a.body.requestId), 409, 'IDEMPOTENCY_CONFLICT');
});

test('daily budget is durable, atomic at 500, independent of IP headers, and exact creation retries are free', async () => {
  const h = harness();
  const a = await h.create();
  const id = 'create:2026-11-29';
  const limit = h.db.tables[LIMITS].get(id);
  limit.value = 499;
  h.db.synchronizeReads(LIMITS, id);
  const bodies = [0, 1].map(() => ({ storyId: fixture.id, mode: 'duo', token: token(), requestId: key() }));
  const results = await Promise.all(bodies.map((body) => h.api('POST', '/api/rooms', { body, headers: { 'x-forwarded-for': token(), 'x-real-ip': token() } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 429]);
  errorIs(results.find((result) => result.status === 429), 429, 'CREATE_LIMIT');
  assert.equal(h.db.tables[LIMITS].get(id).value, 500);
  assert.equal(h.db.tables[ROOMS].size, 2);
  success(await h.api('POST', '/api/rooms', { body: a.body }));
  const freshApp = application({ store: createCloudStore(h.db), stories: [fixture], origin: ORIGIN, now: h.time });
  errorIs(await h.api('POST', '/api/rooms', { body: { ...a.body, requestId: key() }, handler: freshApp }), 429, 'CREATE_LIMIT');
  h.setTime(START + DAY);
  await h.create();
  assert.equal(h.db.tables[LIMITS].get('create:2026-11-30').value, 1);
});

test('initial daily limiter insert races and bounded conflicts use only supported atomic operations', async () => {
  const h = harness();
  const id = 'create:2026-11-29';
  h.db.synchronizeReads(LIMITS, id);
  await Promise.all([h.store.consumeCreateBudget(START), h.store.consumeCreateBudget(START)]);
  assert.equal(h.db.tables[LIMITS].get(id).value, 2);
  assert.equal(h.db.conflicts, 1);
  h.db.fail(LIMITS, 'update', 'conflict', 4);
  const before = writes(h.db, LIMITS).length;
  await assert.rejects(h.store.consumeCreateBudget(START));
  assert.equal(writes(h.db, LIMITS).length - before, 4);
  h.db.fail(LIMITS, 'update', 'lost');
  await assert.rejects(h.store.consumeCreateBudget(START));
  assert.equal(h.db.tables[LIMITS].get(id).value, 3);
  assert.equal(writes(h.db, LIMITS).length - before, 5);
});

test('128-receipt bound rejects excess commands but presence and an exactly retryable leave remain available', async () => {
  const h = harness();
  const a = await h.create();
  await h.act(a, { action: 'ready' });
  for (let i = 2; i < 128; i += 1) await h.act(a, { action: 'ready' });
  const before = h.row(a.id);
  assert.equal(before.state.receipts.length, 128);
  errorIs(await h.command(a, { action: 'ready' }), 429, 'ROOM_OPERATION_LIMIT');
  assert.deepEqual(h.row(a.id), before);
  success(await h.api('POST', `/api/rooms/${a.id}/presence`, { credential: a.token, body: {} }));
  const leaveId = key();
  const revision = before.state.game.revision;
  const left = await h.command(a, { action: 'leave' }, revision, leaveId);
  success(left);
  assert.equal(left.json.view.phase, 'closed');
  assert.equal(h.row(a.id).state.receipts.length, 128);
  const closed = h.row(a.id);
  success(await h.command(a, { action: 'leave' }, revision, leaveId));
  assert.deepEqual(h.row(a.id), closed);
});

test('bounded cleanup scans 40 per table, filters retention in JS and deletes exact observed versions', async () => {
  const h = harness();
  for (const table of [ROOMS, LIMITS]) {
    for (let i = 0; i < 45; i += 1) h.db.tables[table].set(`old-${i}`, { id: `old-${i}`, version: 0, expires_at: START - 3_600_001 - (45 - i), value: 1, state: {} });
    h.db.tables[table].set('retained', { id: 'retained', version: 0, expires_at: START - 3_600_000, value: 1, state: {} });
  }
  h.db.beforeDelete = (q, table) => { if (q.filters[0][1] === 'old-0') table.get('old-0').version += 1; };
  await h.store.cleanupExpired(START);
  for (const table of [ROOMS, LIMITS]) {
    assert.equal(h.db.tables[table].size, 7);
    assert.equal(h.db.tables[table].has('old-0'), true);
    assert.equal(h.db.tables[table].has('old-40'), true);
    assert.equal(h.db.tables[table].has('retained'), true);
  }
  assert.equal(h.db.calls.filter((call) => call.kind === 'delete').length, 80);
  assert.ok(h.db.calls.filter((call) => call.kind === 'select').every((call) => call.cap === 40 && call.order.field === 'expires_at' && call.order.ascending));
  const retention = harness();
  retention.db.tables[LIMITS].set('boundary', { id: 'boundary', version: 0, expires_at: START - 3_600_000, value: 1 });
  await retention.store.cleanupExpired(START);
  assert.equal(retention.db.tables[LIMITS].has('boundary'), true);
});

test('cleanup is create-only and best effort, with safe phase-only logging before a committed create', async (t) => {
  const h = harness();
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  h.db.fail(ROOMS, 'select', 'throw');
  const a = await h.create();
  assert.deepEqual(warnings, [['cloud: cleanup failed']]);
  assert.equal(h.db.tables[ROOMS].has(a.id), true);
  const scans = h.db.calls.filter((call) => call.order).length;
  await h.read(a);
  await h.act(a, { action: 'ready' });
  success(await h.api('GET', '/api/health'));
  success(await h.api('GET', '/api/stories'));
  success(await h.api('POST', `/api/rooms/${a.id}/presence`, { credential: a.token, body: {} }));
  assert.equal(h.db.calls.filter((call) => call.order).length, scans);
});

for (const mode of ['lost', 'lost-unknown']) {
  test(`lost creation/join/command responses (${mode}) return 503 without replay; explicit retries recover current views`, async () => {
    const h = harness();
    const body = { storyId: fixture.id, mode: 'duo', token: token(), requestId: key() };
    h.db.fail(ROOMS, 'insert', mode);
    errorIs(await h.api('POST', '/api/rooms', { body }), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(writes(h.db).length, 1);
    assert.equal(h.db.tables[ROOMS].size, 1);
    const recovered = await h.api('POST', '/api/rooms', { body });
    success(recovered);
    const a = { id: recovered.json.view.id, token: body.token };
    assert.equal(writes(h.db).length, 1);
    assert.equal(h.db.tables[LIMITS].get('create:2026-11-29').value, 1);
    h.db.fail(ROOMS, 'update', mode);
    const joined = await h.join(a);
    errorIs(joined.result, 503, 'SERVICE_UNAVAILABLE');
    const b = await h.join(a, joined.body.token, joined.body.requestId);
    success(b.result);
    assert.equal(writes(h.db).length, 2);
    const requestId = key();
    h.db.fail(ROOMS, 'update', mode);
    errorIs(await h.command(a, { action: 'ready' }, 1, requestId), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(writes(h.db).length, 3);
    assert.equal(h.row(a.id).state.game.revision, 2);
    assert.equal(h.row(a.id).state.receipts.some((receipt) => receipt.requestId === requestId), true);
    await h.act(b.session, { action: 'ready' });
    const before = h.row(a.id);
    const retried = await h.command(a, { action: 'ready' }, 1, requestId);
    success(retried);
    assert.equal(retried.json.view.phase, 'playing');
    assert.deepEqual(h.row(a.id), before);
    assert.equal(writes(h.db).length, 4);
  });
}

test('unknown writes never retry, only explicit zero-row conflicts retry up to four attempts', async () => {
  for (const mode of ['throw', 'error', 'unknown']) {
    const h = harness();
    const a = await h.create('solo');
    const before = h.row(a.id);
    h.db.fail(ROOMS, 'update', mode);
    errorIs(await h.command(a, { action: 'ready' }, 0), 503, 'SERVICE_UNAVAILABLE');
    assert.equal(writes(h.db).length, 2);
    assert.deepEqual(h.row(a.id), before);
  }
  const h = harness();
  const a = await h.create('solo');
  const before = h.row(a.id);
  h.db.fail(ROOMS, 'update', 'conflict', 4);
  errorIs(await h.command(a, { action: 'ready' }, 0), 503, 'SERVICE_UNAVAILABLE');
  assert.equal(writes(h.db).length, 5);
  assert.deepEqual(h.row(a.id), before);
  h.db.fail(ROOMS, 'update', 'conflict', 1);
  success(await h.command(a, { action: 'ready' }, 0));
  assert.equal(h.row(a.id).version, 1);
  assert.equal(h.row(a.id).state.receipts.length, 2);
});
