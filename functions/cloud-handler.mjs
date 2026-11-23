import {
  GameError, ensure, createGame, joinGame, applyCommand, projectView, storySummary, validateStories,
} from './engine.mjs';

const MAX_BODY = 16 * 1024;
const MAX_RECEIPTS = 128;
const ATTEMPTS = 4;
const TOKEN = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const FUNCTION_PATH = /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new Error('Service unavailable.');
const hash = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

function exactKeys(body, keys) {
  ensure(object(body) && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key)), 400, 'INVALID_BODY', '请求字段不正确。');
}
function validToken(token) {
  ensure(typeof token === 'string' && TOKEN.test(token), 400, 'INVALID_TOKEN', '成员凭证格式不正确。');
}
function validRequestId(id) {
  ensure(typeof id === 'string' && REQUEST_ID.test(id), 400, 'INVALID_REQUEST_ID', '请求编号须为 1–80 位字母、数字、下划线或连字符。');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (path, body) => hash(`POST ${path}\n${canonical(body)}`);
function bearer(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '');
  ensure(match, 401, 'UNAUTHORIZED', '请提供有效的成员凭证。');
  return hash(match[1]);
}
function validateCommand(body) {
  const fields = {
    ready: [], compose: ['intentId', 'lineId'], clarify: [], interpret: ['guessId', 'response'],
    repair: ['index'], 'repair-compose': ['lineId'], 'repair-interpret': ['guessId'], 'repair-end': [], leave: [],
  };
  ensure(object(body) && typeof body.action === 'string' && Object.hasOwn(fields, body.action), 400, 'INVALID_COMMAND', '未知的房间操作。');
  exactKeys(body, ['revision', 'requestId', 'action', ...fields[body.action]]);
  validRequestId(body.requestId);
  ensure(Number.isSafeInteger(body.revision) && body.revision >= 0, 400, 'INVALID_REVISION', '版本号须为非负整数。');
  for (const key of ['intentId', 'lineId', 'guessId']) {
    if (Object.hasOwn(body, key)) ensure(typeof body[key] === 'string' && body[key].length > 0 && body[key].length <= 100, 400, 'INVALID_CHOICE', '选项编号不正确。');
  }
  if (body.action === 'repair') ensure(Number.isSafeInteger(body.index) && body.index >= 0 && body.index < 3, 400, 'INVALID_INDEX', '轮次须为 0–2 的整数。');
  if (body.action === 'interpret') ensure(['accept', 'boundary'].includes(body.response), 400, 'INVALID_RESPONSE', '请选择回应方式。');
}

async function readJson(request) {
  ensure(/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers.get('content-type') ?? ''), 400, 'INVALID_CONTENT_TYPE', '请使用 application/json 请求。');
  const declared = request.headers.get('content-length');
  if (declared !== null) ensure(/^\d+$/.test(declared) && Number(declared) <= MAX_BODY, 400, 'BODY_TOO_LARGE', '请求不能超过 16KB。');
  const reader = request.body?.getReader();
  ensure(reader, 400, 'INVALID_JSON', '请求不是有效的 JSON。');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        // Do not wait for an untrusted upstream to acknowledge cancellation.
        void reader.cancel().catch(() => {});
        throw new GameError(400, 'BODY_TOO_LARGE', '请求不能超过 16KB。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GameError) throw error;
    throw new GameError(400, 'ABORTED', '请求已中断。');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new GameError(400, 'INVALID_JSON', '请求不是有效的 JSON。'); }
  ensure(object(body), 400, 'INVALID_BODY', '请求必须是 JSON 对象。');
  return body;
}
function freeze(value) {
  if (object(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const open = (game) => ensure(game.phase !== 'closed', 410, 'ROOM_CLOSED', '房间已经关闭，不能继续操作或加入。');
function member(state, actorHash) {
  const role = ['A', 'B'].find((candidate) => state.members[candidate]?.actorHash === actorHash);
  ensure(role, 403, 'FORBIDDEN', '这个凭证不是房间成员。');
  return role;
}
function previous(state, actorHash, requestId, digest) {
  // Creation metadata survives the leave escape hatch and remains immutable.
  const receipt = state.creation.ownerHash === actorHash && state.creation.requestId === requestId
    ? state.creation : state.receipts.find((item) => item.actorHash === actorHash && item.requestId === requestId);
  ensure(!receipt || receipt.digest === digest, 409, 'IDEMPOTENCY_CONFLICT', '这个请求编号已经用于不同的操作。');
  return Boolean(receipt);
}
function remember(state, actorHash, requestId, digest, leaving = false) {
  ensure(leaving || state.receipts.length < MAX_RECEIPTS, 429, 'ROOM_OPERATION_LIMIT', '房间操作次数已达上限，请结束房间并重新开始。');
  // Only closing may displace a receipt. Closed rooms prohibit all other command
  // replays, so eviction cannot execute an old action again. Leave remains retryable.
  if (leaving && state.receipts.length >= MAX_RECEIPTS) state.receipts.shift();
  state.receipts.push({ actorHash, requestId, digest });
}

/** Request -> Response; application authentication is independent of site context. */
export function application({ store, stories, origin, now = Date.now }) {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) throw new Error('A fixed HTTPS origin is required.');
  const catalog = new Map(validateStories(freeze(structuredClone(stories))).map((story) => [story.id, story]));
  const summaries = [...catalog.values()].map(storySummary);
  const load = async (id) => {
    const row = await store.getRoom(id);
    ensure(row !== null, 404, 'ROOM_NOT_FOUND', '找不到这个房间。');
    if (!row || row.id !== id) throw unavailable();
    ensure(row.expires_at > now() && row.state.game.expiresAt > now(), 410, 'ROOM_EXPIRED', '房间已超过 24 小时有效期。');
    return row;
  };
  const view = (state, role) => {
    const partner = state.members[role === 'A' ? 'B' : 'A'];
    return { view: projectView(state.game, role, {
      partnerJoined: Boolean(partner), partnerOnline: Boolean(partner && now() - partner.lastSeen < 60_000),
    }) };
  };
  const change = async (id, work) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const row = await load(id);
      const state = structuredClone(row.state);
      const { role, unchanged = false } = work(state);
      if (unchanged) return view(state, role);
      const saved = await store.casRoom({ ...row, version: row.version + 1, state }, row.version);
      if (saved === null) continue; // Only a verified empty affected-row result.
      if (!saved || saved.id !== id || saved.version !== row.version + 1) throw unavailable();
      return view(saved.state, role);
    }
    throw unavailable();
  };
  const recoverCreation = (row, actorHash, requestId, digest) => {
    const { creation } = row.state;
    ensure(creation.ownerHash === actorHash && creation.requestId === requestId && creation.digest === digest,
      409, 'IDEMPOTENCY_CONFLICT', '这个请求编号已经用于不同的操作。');
    ensure(row.expires_at > now() && row.state.game.expiresAt > now(), 410, 'ROOM_EXPIRED', '房间已超过 24 小时有效期。');
    open(row.state.game);
    return view(row.state, member(row.state, actorHash));
  };

  async function dispatch(request) {
    const requestOrigin = request.headers.get('origin');
    ensure((request.method === 'GET' && requestOrigin === null) || requestOrigin === origin,
      403, 'ORIGIN_FORBIDDEN', '不允许这个来源访问房间。');
    const url = new URL(request.url);
    ensure(!url.search && !url.hash, 400, 'INVALID_URL', '接口不接受查询参数；凭证请放在请求头中。');
    const normalized = FUNCTION_PATH.exec(url.pathname);
    ensure(normalized, 404, 'NOT_FOUND', '找不到这个接口。');
    const path = normalized[1] || '/';
    if (request.method === 'GET' && path === '/api/health') {
      await store.health();
      return { ok: true, environment: 'cloud', persistence: 'database' };
    }
    if (request.method === 'GET' && path === '/api/stories') return { stories: summaries };
    if (request.method === 'POST' && path === '/api/rooms') {
      const body = await readJson(request);
      exactKeys(body, ['storyId', 'mode', 'token', 'requestId']);
      validToken(body.token);
      validRequestId(body.requestId);
      ensure(typeof body.storyId === 'string' && body.storyId.length > 0 && body.storyId.length <= 100, 400, 'INVALID_STORY', '故事编号不正确。');
      ensure(['solo', 'duo'].includes(body.mode), 400, 'INVALID_MODE', '请选择单人或双人模式。');
      const actorHash = await hash(body.token);
      const digest = await fingerprint(path, body);
      const id = (await hash(actorHash + body.requestId)).slice(0, 24);
      // Cleanup is bounded, best effort, and BEFORE any creation commit. No
      // provider message, identifier, credential or request body enters logs.
      try { await store.cleanupExpired(now()); } catch { console.warn('cloud: cleanup failed'); }
      const existing = await store.getRoom(id);
      if (existing !== null) {
        if (!existing || existing.id !== id) throw unavailable();
        return recoverCreation(existing, actorHash, body.requestId, digest);
      }
      const story = catalog.get(body.storyId);
      ensure(story, 404, 'STORY_NOT_FOUND', '找不到这个故事。');
      // Failed or racing creations may conservatively consume a daily slot.
      await store.consumeCreateBudget(now());
      const time = now();
      const game = createGame({ id, mode: body.mode, story, now: time });
      const state = {
        game, members: { A: { actorHash, lastSeen: time } },
        creation: { ownerHash: actorHash, requestId: body.requestId, digest },
        receipts: [{ actorHash, requestId: body.requestId, digest }],
      };
      const inserted = await store.insertRoom({ id, version: 0, expires_at: game.expiresAt, state });
      if (inserted === null) return recoverCreation(await load(id), actorHash, body.requestId, digest);
      if (!inserted || inserted.id !== id || inserted.version !== 0) throw unavailable();
      return view(inserted.state, 'A');
    }
    const match = /^\/api\/rooms\/([a-f0-9]{24})(?:\/(join|commands|presence))?$/.exec(path);
    ensure(match, 404, 'NOT_FOUND', '找不到这个接口。');
    const [, id, operation] = match;
    if (request.method === 'GET' && !operation) {
      const actorHash = await bearer(request);
      const { state } = await load(id);
      return view(state, member(state, actorHash)); // Deliberately no writes.
    }
    if (request.method === 'POST' && operation === 'join') {
      const body = await readJson(request);
      exactKeys(body, ['token', 'requestId']);
      validToken(body.token);
      validRequestId(body.requestId);
      const actorHash = await hash(body.token);
      const digest = await fingerprint(path, body);
      return change(id, (state) => {
        open(state.game);
        if (previous(state, actorHash, body.requestId, digest)) return { role: member(state, actorHash), unchanged: true };
        ensure(state.game.mode === 'duo', 409, 'SOLO_ROOM', '单人房间不能加入其他玩家。');
        let role = ['A', 'B'].find((candidate) => state.members[candidate]?.actorHash === actorHash);
        if (!role) {
          ensure(!state.members.B, 409, 'ROOM_FULL', '房间已经有两位玩家。');
          state.game = joinGame(state.game);
          role = 'B';
          state.members.B = { actorHash, lastSeen: now() };
        }
        remember(state, actorHash, body.requestId, digest);
        state.members[role].lastSeen = now();
        return { role };
      });
    }
    if (request.method === 'POST' && operation === 'presence') {
      const actorHash = await bearer(request);
      exactKeys(await readJson(request), []);
      return change(id, (state) => {
        const role = member(state, actorHash);
        open(state.game);
        state.members[role].lastSeen = now();
        return { role }; // Storage version changes, not game revision or receipts.
      });
    }
    if (request.method === 'POST' && operation === 'commands') {
      const actorHash = await bearer(request);
      const body = await readJson(request);
      validateCommand(body);
      const digest = await fingerprint(path, body);
      return change(id, (state) => {
        const role = member(state, actorHash);
        const cached = previous(state, actorHash, body.requestId, digest);
        if (state.game.phase === 'closed') {
          if (cached && body.action === 'leave') return { role, unchanged: true };
          open(state.game);
        }
        if (cached) return { role, unchanged: true };
        const mergeReady = body.action === 'ready' && ['waiting', 'briefing'].includes(state.game.phase)
          && body.revision <= state.game.revision && !state.game.ready[role];
        ensure(body.revision === state.game.revision || mergeReady, 409, 'REVISION_CONFLICT', '房间已有更新，请刷新后重试。');
        remember(state, actorHash, body.requestId, digest, body.action === 'leave');
        state.game = applyCommand(state.game, role, body);
        state.members[role].lastSeen = now();
        return { role };
      });
    }
    throw new GameError(404, 'NOT_FOUND', '找不到这个接口。');
  }

  return async (request) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    try { return new Response(JSON.stringify(await dispatch(request)), { status: 200, headers }); }
    catch (error) {
      const known = error instanceof GameError;
      const status = known ? error.status : 503;
      if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
      if (status === 429) headers['Retry-After'] = '60';
      return new Response(JSON.stringify({ error: {
        code: known ? error.code : 'SERVICE_UNAVAILABLE',
        message: known ? error.message : '服务暂时不可用，请稍后使用原请求重试。',
      } }), { status, headers });
    }
  };
}
