import { createServer as createHttpServer } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GameError, ensure, createGame, joinGame, applyCommand, projectView, storySummary, validateStories,
} from '../functions/engine.mjs';

export const API_PREFIX = '/functions/v1/app/api';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 16 * 1024;
const RETENTION = 60 * 60 * 1000;
const MAX_ROOM_OPERATIONS = 1024;
const TOKEN = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ROOM_ID = /^[A-Za-z0-9]{10}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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
function fingerprint(path, body) {
  // Only this digest is persisted; body tokens never enter room or operation JSON.
  return hash(`POST ${path}\n${canonical(body)}`);
}
function bearer(req) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
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

function checkLocalRequest(req) {
  // Host validation also prevents DNS-rebinding access to the loopback listener.
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { /* rejected below */ }
  ensure(host && LOOPBACK.has(host.hostname) && !host.username && !host.password && host.pathname === '/' && !host.search && !host.hash, 403, 'HOST_FORBIDDEN', '仅允许本机访问。');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let parsed;
    try { parsed = new URL(origin); } catch { /* rejected below */ }
    ensure(parsed && ['http:', 'https:'].includes(parsed.protocol) && LOOPBACK.has(parsed.hostname) && parsed.origin === origin, 403, 'ORIGIN_FORBIDDEN', '不允许这个来源访问本地房间。');
  } else {
    ensure(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'ORIGIN_FORBIDDEN', '不允许跨站访问本地房间。');
  }
}

function readJson(req) {
  ensure(/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(req.headers['content-type'] ?? ''), 400, 'INVALID_CONTENT_TYPE', '请使用 application/json 请求。');
  const declared = req.headers['content-length'];
  if (declared !== undefined) ensure(/^\d+$/.test(declared) && Number(declared) <= MAX_BODY, 400, 'BODY_TOO_LARGE', '请求不能超过 16KB。');
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!failed) reject(new GameError(400, 'BODY_TOO_LARGE', '请求不能超过 16KB。'));
        failed = true;
        chunks = [];
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        ensure(object(body), 400, 'INVALID_BODY', '请求必须是 JSON 对象。');
        resolveBody(body);
      } catch (error) {
        reject(error instanceof GameError ? error : new GameError(400, 'INVALID_JSON', '请求不是有效的 JSON。'));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new GameError(400, 'ABORTED', '请求已中断。')));
  });
}

function makeLimiter() {
  const buckets = new Map();
  return (ip, category, now) => {
    // Expired entries are discarded; even repeated connections cannot grow this map indefinitely.
    for (const [key, bucket] of buckets) if (now >= bucket.until) buckets.delete(key);
    const key = `${ip}:${category}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      ensure(buckets.size < 2048, 503, 'SERVER_BUSY', '本地服务繁忙，请稍后重试。');
      bucket = { count: 0, until: now + 60_000 };
      buckets.set(key, bucket);
    }
    const limit = category === 'membership' ? 60 : 240;
    ensure(++bucket.count <= limit, 429, 'RATE_LIMITED', '操作太频繁，请稍后重试。');
  };
}

/** Starts a loopback-only HTTP server. Await its result; close() also closes SQLite. */
export async function createServer({
  port = process.env.PORT === undefined ? 8788 : Number(process.env.PORT),
  dbPath = resolve(ROOT, '.local/rooms.sqlite'),
  storiesPath = resolve(ROOT, 'content/stories.json'),
} = {}) {
  ensure(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 400, 'INVALID_PORT', '端口号不正确。');
  const stories = validateStories(JSON.parse(readFileSync(storiesPath, 'utf8')));
  const catalog = new Map(stories.map((story) => [story.id, story]));
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires_at);
      CREATE INDEX IF NOT EXISTS rooms_closed ON rooms(closed_at);
      CREATE TABLE IF NOT EXISTS members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('A', 'B')), token_hash TEXT NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY(room_id, role), UNIQUE(room_id, token_hash)
      );
      CREATE TABLE IF NOT EXISTS operations (
        actor_hash TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        response TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(actor_hash, request_id)
      );
      CREATE INDEX IF NOT EXISTS operations_room ON operations(room_id);
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const sql = {
    room: db.prepare('SELECT * FROM rooms WHERE id = ?'),
    member: db.prepare('SELECT * FROM members WHERE room_id = ? AND token_hash = ?'),
    partner: db.prepare('SELECT last_seen FROM members WHERE room_id = ? AND role <> ?'),
    touch: db.prepare('UPDATE members SET last_seen = ? WHERE room_id = ? AND token_hash = ?'),
    insertRoom: db.prepare('INSERT INTO rooms(id, state, expires_at) VALUES (?, ?, ?)'),
    insertMember: db.prepare('INSERT INTO members(room_id, role, token_hash, last_seen) VALUES (?, ?, ?, ?)'),
    save: db.prepare('UPDATE rooms SET state = ?, closed_at = ? WHERE id = ?'),
    operation: db.prepare('SELECT * FROM operations WHERE actor_hash = ? AND request_id = ?'),
    insertOperation: db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)'),
    operationCount: db.prepare('SELECT COUNT(*) AS count FROM operations WHERE room_id = ?'),
    activeCount: db.prepare('SELECT COUNT(*) AS count FROM rooms WHERE expires_at > ? AND closed_at IS NULL'),
    retainedCount: db.prepare('SELECT COUNT(*) AS count FROM rooms'),
    cleanup: db.prepare('DELETE FROM rooms WHERE expires_at <= ?'),
  };
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const cleanup = (now) => {
    // Expired rooms retain 410 responses for one hour, then cascade-delete.
    // Closed rooms keep their original expiry too: retries cannot resurrect a closed session.
    // Receipts are never evicted during the room's 24-hour lifetime.
    sql.cleanup.run(now - RETENTION);
  };
  cleanup(Date.now());
  const cleanupTimer = setInterval(() => {
    try { cleanup(Date.now()); } catch { /* A busy database is retried on the next interval. */ }
  }, 60_000);
  cleanupTimer.unref();
  const limit = makeLimiter();
  const load = (id, now) => {
    const row = sql.room.get(id);
    ensure(row, 404, 'ROOM_NOT_FOUND', '找不到这个房间。');
    ensure(row.expires_at > now, 410, 'ROOM_EXPIRED', '房间已超过 24 小时有效期。');
    return JSON.parse(row.state);
  };
  const member = (id, actor) => {
    const row = sql.member.get(id, actor);
    ensure(row, 403, 'FORBIDDEN', '这个凭证不是房间成员。');
    return row;
  };
  const open = (game) => ensure(game.phase !== 'closed', 410, 'ROOM_CLOSED', '房间已经关闭，不能继续操作或加入。');
  const view = (game, role, now) => {
    const partner = sql.partner.get(game.id, role);
    return { view: projectView(game, role, { partnerJoined: Boolean(partner), partnerOnline: Boolean(partner && now - partner.last_seen < 20_000) }) };
  };
  const previous = (actor, requestId, digest) => {
    const operation = sql.operation.get(actor, requestId);
    ensure(!operation || operation.fingerprint === digest, 409, 'IDEMPOTENCY_CONFLICT', '这个请求编号已经用于不同的操作。');
    return operation;
  };
  const operationSpace = (id, leaving = false) => {
    ensure(leaving || sql.operationCount.get(id).count < MAX_ROOM_OPERATIONS, 503, 'ROOM_OPERATION_LIMIT', '房间操作次数已达上限，请结束房间并重新开始。');
  };
  const remember = (actor, body, digest, game, result, now) => {
    sql.insertOperation.run(actor, body.requestId, digest, game.id, JSON.stringify(result), now);
    return result;
  };
  const save = (game, now) => sql.save.run(JSON.stringify(game), game.phase === 'closed' ? now : null, game.id);

  const dispatch = async (req) => {
    checkLocalRequest(req);
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { throw new GameError(400, 'INVALID_URL', '请求地址不正确。'); }
    ensure(!url.search && !url.hash, 400, 'INVALID_URL', '接口不接受查询参数；凭证请放在请求头中。');
    const path = url.pathname;
    let now = Date.now();
    if (req.method === 'GET' && path === `${API_PREFIX}/health`) return { ok: true, environment: 'local', persistence: 'sqlite' };
    if (req.method === 'GET' && path === `${API_PREFIX}/stories`) return { stories: stories.map(storySummary) };
    if (req.method === 'POST' && path === `${API_PREFIX}/rooms`) {
      limit(req.socket.remoteAddress, 'membership', now);
      const body = await readJson(req);
      exactKeys(body, ['storyId', 'mode', 'token', 'requestId']);
      validToken(body.token);
      validRequestId(body.requestId);
      ensure(typeof body.storyId === 'string' && body.storyId.length > 0 && body.storyId.length <= 100, 400, 'INVALID_STORY', '故事编号不正确。');
      ensure(['solo', 'duo'].includes(body.mode), 400, 'INVALID_MODE', '请选择单人或双人模式。');
      const actor = hash(body.token);
      const digest = fingerprint(path, body);
      return transaction(() => {
        // Timestamp after body parsing / lock acquisition, not at connection arrival.
        now = Date.now();
        const cached = previous(actor, body.requestId, digest);
        if (cached) {
          const game = load(cached.room_id, now);
          open(game);
          member(game.id, actor);
          sql.touch.run(now, game.id, actor);
          return JSON.parse(cached.response);
        }
        const story = catalog.get(body.storyId);
        ensure(story, 404, 'STORY_NOT_FOUND', '找不到这个故事。');
        cleanup(now);
        ensure(sql.activeCount.get(now).count < 500 && sql.retainedCount.get().count < 1000, 503, 'ROOM_CAPACITY', '本地房间已满，请稍后再试。');
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let id;
        do { id = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (sql.room.get(id));
        const game = createGame({ id, mode: body.mode, story, now });
        sql.insertRoom.run(id, JSON.stringify(game), game.expiresAt);
        sql.insertMember.run(id, 'A', actor, now);
        return remember(actor, body, digest, game, view(game, 'A', now), now);
      });
    }
    const match = new RegExp(`^${API_PREFIX}/rooms/([A-Za-z0-9]{10})(?:/(join|commands))?$`).exec(path);
    ensure(match && ROOM_ID.test(match[1]), 404, 'NOT_FOUND', '找不到这个接口。');
    const [, id, operation] = match;
    if (req.method === 'GET' && !operation) {
      const actor = bearer(req);
      return transaction(() => {
        // Timestamp after body parsing / lock acquisition, not at connection arrival.
        now = Date.now();
        const game = load(id, now);
        const self = member(id, actor);
        sql.touch.run(now, id, actor);
        return view(game, self.role, now);
      });
    }
    if (req.method === 'POST' && operation === 'join') {
      limit(req.socket.remoteAddress, 'membership', now);
      const body = await readJson(req);
      exactKeys(body, ['token', 'requestId']);
      validToken(body.token);
      validRequestId(body.requestId);
      const actor = hash(body.token);
      const digest = fingerprint(path, body);
      return transaction(() => {
        // Timestamp after body parsing / lock acquisition, not at connection arrival.
        now = Date.now();
        const cached = previous(actor, body.requestId, digest);
        let game = load(id, now);
        open(game);
        if (cached) {
          member(id, actor);
          sql.touch.run(now, id, actor);
          return JSON.parse(cached.response);
        }
        operationSpace(id);
        ensure(game.mode === 'duo', 409, 'SOLO_ROOM', '单人房间不能加入其他玩家。');
        let self = sql.member.get(id, actor);
        if (!self) {
          ensure(!sql.partner.get(id, 'A'), 409, 'ROOM_FULL', '房间已经有两位玩家。');
          game = joinGame(game);
          sql.insertMember.run(id, 'B', actor, now);
          self = { role: 'B' };
          save(game, now);
        }
        sql.touch.run(now, id, actor);
        return remember(actor, body, digest, game, view(game, self.role, now), now);
      });
    }
    if (req.method === 'POST' && operation === 'commands') {
      const actor = bearer(req);
      limit(req.socket.remoteAddress, 'commands', now);
      const body = await readJson(req);
      validateCommand(body);
      const digest = fingerprint(path, body);
      return transaction(() => {
        // Timestamp after body parsing / lock acquisition, not at connection arrival.
        now = Date.now();
        let game = load(id, now);
        const self = member(id, actor);
        const cached = previous(actor, body.requestId, digest);
        if (game.phase === 'closed') {
          // Repeating the same leave is a receipt lookup, never a new mutation.
          if (cached && body.action === 'leave') return JSON.parse(cached.response);
          open(game);
        }
        if (cached) {
          sql.touch.run(now, id, actor);
          return JSON.parse(cached.response);
        }
        // Readiness is an independent per-member flag: simultaneous clicks merge
        // within briefing. Story choices still require an exact revision.
        const mergeReady = body.action === 'ready' && ['waiting', 'briefing'].includes(game.phase)
          && body.revision <= game.revision && !game.ready[self.role];
        ensure(body.revision === game.revision || mergeReady, 409, 'REVISION_CONFLICT', '房间已有更新，请刷新后重试。');
        operationSpace(id, body.action === 'leave');
        game = applyCommand(game, self.role, body);
        save(game, now);
        sql.touch.run(now, id, actor);
        return remember(actor, body, digest, game, view(game, self.role, now), now);
      });
    }
    throw new GameError(404, 'NOT_FOUND', '找不到这个接口。');
  };

  const server = createHttpServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Deliberately no CORS headers: the UI uses its same-origin development proxy.
    try {
      const result = await dispatch(req);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof GameError;
      const status = known ? error.status : 503;
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (status === 429) res.setHeader('Retry-After', '60');
      if (!req.complete) {
        res.setHeader('Connection', 'close');
        req.resume();
      }
      res.writeHead(status);
      res.end(JSON.stringify({ error: { code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : '本地服务暂时不可用，请稍后再试。' } }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  server.on('close', () => { clearInterval(cleanupTimer); db.close(); });
  try {
    await new Promise((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolveListening();
      });
    });
  } catch (error) {
    clearInterval(cleanupTimer);
    db.close();
    throw error;
  }
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createServer();
  console.log(`同频不同词 local API: http://127.0.0.1:${server.address().port}${API_PREFIX}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
