import { GameError } from './engine.mjs';

const ROOMS = 'wavelength_rooms';
const LIMITS = 'wavelength_limits';
const ROOM_FIELDS = 'id,version,expires_at,state';
const LIMIT_FIELDS = 'id,version,value,expires_at';
const ATTEMPTS = 4;
const DAY = 86_400_000;
const unavailable = () => new Error('Database operation unavailable.');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only an explicit, successful data: [] means a known write conflict. Missing
// data, provider errors and thrown/ambiguous writes must never cause replay.
async function rows(query) {
  let result;
  try { result = await query; } catch { throw unavailable(); }
  if (!result || result.error || !Array.isArray(result.data)) throw unavailable();
  return result.data;
}
function one(data, valid) {
  if (data.length === 0) return null;
  if (data.length !== 1 || !valid(data[0])) throw unavailable();
  return data[0];
}
const versioned = (row) => object(row) && typeof row.id === 'string'
  && Number.isSafeInteger(row.version) && row.version >= 0 && row.version < 2_147_483_647
  && Number.isSafeInteger(row.expires_at);
const roomRow = (row) => versioned(row) && object(row.state);
const limitRow = (row) => versioned(row) && Number.isSafeInteger(row.value) && row.value >= 0;

/**
 * Inject the Function SDK database client (its default schema is app).
 * getRoom -> row|null; insertRoom / casRoom -> row|null (null = known conflict).
 * Room rows are {id, version, expires_at, state}. casRoom(next, expectedVersion)
 * requires next.version === expectedVersion + 1. Unknown results always throw.
 * health is read-only; consumeCreateBudget(time) is durable; cleanupExpired(time)
 * scans at most 40 oldest rows per table and deletes by id AND observed version.
 */
export function createCloudStore(db) {
  return {
    async health() {
      await rows(db.from(ROOMS).select('id').limit(1));
    },
    async getRoom(id) {
      return one(await rows(db.from(ROOMS).select(ROOM_FIELDS).eq('id', id).limit(1)), roomRow);
    },
    async insertRoom(row) {
      if (!roomRow(row)) throw unavailable();
      return one(await rows(db.from(ROOMS).insertIfAbsent(row, { onConflict: 'id' }).select(ROOM_FIELDS)), roomRow);
    },
    async casRoom(next, expectedVersion) {
      if (!roomRow(next) || next.version !== expectedVersion + 1) throw unavailable();
      const { version, expires_at, state } = next;
      return one(await rows(db.from(ROOMS).update({ version, expires_at, state })
        .eq('id', next.id).eq('version', expectedVersion).select(ROOM_FIELDS)), roomRow);
    },
    async consumeCreateBudget(time) {
      const id = `create:${new Date(time).toISOString().slice(0, 10)}`;
      const expires_at = (Math.floor(time / DAY) + 1) * DAY;
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const current = one(await rows(db.from(LIMITS).select(LIMIT_FIELDS).eq('id', id).limit(1)), limitRow);
        if (current && current.value >= 500) {
          throw new GameError(429, 'CREATE_LIMIT', '今天的新房间名额已用完，请明天再来。已有房间仍可继续。');
        }
        const next = { id, version: current ? current.version + 1 : 0, value: current ? current.value + 1 : 1, expires_at };
        const query = current
          ? db.from(LIMITS).update({ version: next.version, value: next.value, expires_at })
            .eq('id', id).eq('version', current.version).select(LIMIT_FIELDS)
          : db.from(LIMITS).insertIfAbsent(next, { onConflict: 'id' }).select(LIMIT_FIELDS);
        if (one(await rows(query), limitRow) !== null) return;
      }
      throw unavailable();
    },
    async cleanupExpired(time) {
      for (const table of [ROOMS, LIMITS]) {
        const oldest = await rows(db.from(table).select('id,version,expires_at')
          .order('expires_at', { ascending: true }).limit(40));
        // Retain expired rows for one hour. Never reset a table or delete a row
        // whose version changed since the bounded scan. Do not retry deletions.
        for (const row of oldest.slice(0, 40)) {
          if (!versioned(row)) throw unavailable();
          if (row.expires_at < time - 3_600_000) {
            const removed = await rows(db.from(table).delete().eq('id', row.id).eq('version', row.version).select('id'));
            if (removed.length > 1 || removed.some((item) => item.id !== row.id)) throw unavailable();
          }
        }
      }
    },
  };
}
