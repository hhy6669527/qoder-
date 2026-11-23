// Portable game rules. No filesystem, networking, or Node-specific dependencies.
export const ROOM_TTL = 24 * 60 * 60 * 1000;
export const UNSURE = 'unsure';

export class GameError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'GameError';
    this.status = status;
    this.code = code;
  }
}

export function ensure(condition, status, code, message) {
  if (!condition) throw new GameError(status, code, message);
}

const opposite = (role) => role === 'A' ? 'B' : 'A';
const clone = (value) => structuredClone(value);
const intentFor = (round, id) => id === UNSURE
  ? { id: UNSURE, label: '我还没想清楚', clarification: '我还没想清楚，想再给自己一点时间。' }
  : round.intents.find((intent) => intent.id === id);
const guessLabel = (round, id) => id === UNSURE ? '我还不能确定' : intentFor(round, id)?.label;
const matches = (intent, guess) => intent !== UNSURE && guess !== UNSURE && intent === guess;
const choices = (round, guessing = false) => [
  ...round.intents.map(({ id, label }) => ({ id, label })),
  { id: UNSURE, label: guessing ? '我还不能确定' : '我还没想清楚' },
];

export function storySummary(story) {
  const { id, number, relation, topic, title, subtitle, quote, location, mood, duration, setup, objective } = story;
  return {
    id, number, relation, topic, title, subtitle, quote, location, mood, duration, setup, objective,
    cast: Object.fromEntries(['A', 'B'].map((role) => [role, {
      name: story.roles[role].name, identity: story.roles[role].identity,
    }])),
  };
}

// Fail at startup rather than allow malformed content to strand a persisted game.
export function validateStories(stories) {
  const valid = (condition) => ensure(condition, 503, 'INVALID_STORIES', '本地故事数据格式不正确。');
  const text = (value) => typeof value === 'string' && value.length > 0;
  const ids = new Set();
  valid(Array.isArray(stories) && stories.length > 0);
  for (const story of stories) {
    valid(story && ['id', 'number', 'title', 'subtitle', 'quote', 'location', 'mood', 'duration', 'setup', 'objective', 'takeaway'].every((key) => text(story[key])));
    valid(!ids.has(story.id));
    ids.add(story.id);
    valid(['friends', 'family', 'couple'].includes(story.relation) && ['meal', 'travel', 'message', 'help'].includes(story.topic));
    for (const role of ['A', 'B']) valid(story.roles?.[role] && ['name', 'identity', 'background', 'goal'].every((key) => text(story.roles[role][key])));
    valid(story.endings && ['clarified', 'boundary', 'open'].every((key) => text(story.endings[key])));
    valid(Array.isArray(story.rounds) && story.rounds.length === 3);
    story.rounds.forEach((round, index) => {
      valid(round && round.speaker === ['A', 'B', 'A'][index]);
      valid(['title', 'prompt', 'insight'].every((key) => text(round[key])));
      valid(round.leadIns && ['normal', 'clarified', 'boundary'].every((key) => text(round.leadIns[key])));
      valid(round.replies && ['accept', 'boundary'].every((key) => text(round.replies[key])));
      valid(Array.isArray(round.intents) && round.intents.length > 0 && Array.isArray(round.lines) && round.lines.length > 0);
      valid(round.intents.every((intent) => intent && ['id', 'label', 'clarification'].every((key) => text(intent[key])) && intent.id !== UNSURE));
      valid(new Set(round.intents.map((intent) => intent.id)).size === round.intents.length);
      valid(round.lines.every((line) => line && text(line.id) && text(line.text) && ['hint', 'direct', 'question'].includes(line.style)));
      valid(new Set(round.lines.map((line) => line.id)).size === round.lines.length);
      valid(round.npc && intentFor(round, round.npc.intent) && round.lines.some((line) => line.id === round.npc.line));
      valid(round.npc.guessByLine && typeof round.npc.guessByLine === 'object');
      valid(round.lines.every((line) => intentFor(round, round.npc.guessByLine[line.id])));
    });
  }
  return stories;
}

export function createGame({ id, mode, story, now = Date.now() }) {
  ensure(mode === 'solo' || mode === 'duo', 400, 'INVALID_MODE', '请选择单人或双人模式。');
  return {
    id, mode, story: clone(story), revision: 0,
    phase: mode === 'solo' ? 'briefing' : 'waiting',
    ready: { A: false, B: mode === 'solo' },
    roundIndex: 0, stage: 'wait', records: [], pending: null, repair: null,
    expiresAt: now + ROOM_TTL,
  };
}

export function joinGame(game) {
  ensure(game.mode === 'duo' && game.phase === 'waiting', 409, 'ROOM_FULL', '房间已经满员或无法加入。');
  const next = clone(game);
  next.phase = 'briefing';
  next.revision += 1;
  return next;
}

function compose(game, intentId, lineId) {
  const round = game.story.rounds[game.roundIndex];
  const intent = intentFor(round, intentId);
  const line = round.lines.find((candidate) => candidate.id === lineId);
  ensure(intent && line, 400, 'INVALID_CHOICE', '请选择本轮提供的意图和表达。');
  game.pending = { intentId, lineId, text: line.text, asked: false };
  game.stage = 'interpret';
}

function interpret(game, guessId, response) {
  const round = game.story.rounds[game.roundIndex];
  ensure(intentFor(round, guessId), 400, 'INVALID_CHOICE', '请选择本轮提供的理解。');
  ensure(['accept', 'boundary'].includes(response), 400, 'INVALID_RESPONSE', '请选择回应方式。');
  const pending = game.pending;
  const record = {
    index: game.roundIndex, speaker: round.speaker, title: round.title,
    text: pending.text, reply: round.replies[response], asked: pending.asked,
    intentId: pending.intentId, intended: intentFor(round, pending.intentId).label,
    guessedId: guessId, interpreted: guessLabel(round, guessId),
    matched: matches(pending.intentId, guessId), response,
    insight: pending.intentId === UNSURE || guessId === UNSURE
      ? '这一轮有人还没确定自己的意思或理解。留白也是有效选择，不需要替对方补出一个结论。'
      : matches(pending.intentId, guessId)
        ? (pending.asked ? '这一轮先补上了本人确认的解释，随后记录的理解与所选本意一致。' : '这一轮记录的理解与所选本意一致。这只描述本局这一句话，不是对整段关系的评分。')
        : `本局选定的本意是“${intentFor(round, pending.intentId).label}”，记录的理解是“${guessLabel(round, guessId)}”。这两个选择没有重合，可以保留本意，试试另一种说法。`,
    lineId: pending.lineId,
  };
  if (pending.asked) record.clarification = pending.clarification;
  game.records.push(record);
  game.pending = null;
  if (game.roundIndex === game.story.rounds.length - 1) {
    game.phase = 'reveal';
    game.stage = 'wait';
  } else {
    game.roundIndex += 1;
    game.stage = 'compose';
  }
}

function repairInterpret(game, guessId) {
  const repair = game.repair;
  const round = game.story.rounds[repair.index];
  ensure(intentFor(round, guessId), 400, 'INVALID_CHOICE', '请选择本轮提供的理解。');
  repair.guessId = guessId;
  repair.interpreted = guessLabel(round, guessId);
  repair.matched = matches(game.records[repair.index].intentId, guessId);
  repair.stage = 'done';
}

function runNpc(game) {
  if (game.mode !== 'solo') return;
  while (game.phase === 'playing') {
    const round = game.story.rounds[game.roundIndex];
    const actor = game.stage === 'compose' ? round.speaker : opposite(round.speaker);
    if (actor !== 'B') break;
    if (game.stage === 'compose') compose(game, round.npc.intent, round.npc.line);
    else interpret(game, round.npc.guessByLine[game.pending.lineId] ?? UNSURE, 'accept');
  }
  if (game.phase === 'repair' && game.repair.stage === 'interpret') {
    const round = game.story.rounds[game.repair.index];
    repairInterpret(game, round.npc.guessByLine[game.repair.lineId] ?? UNSURE);
  }
}

export function applyCommand(game, role, command) {
  ensure(role === 'A' || role === 'B', 403, 'FORBIDDEN', '你不是这个房间的成员。');
  ensure(!(game.mode === 'solo' && role === 'B'), 403, 'FORBIDDEN', '单人模式的另一角色由系统扮演。');
  ensure(game.phase !== 'closed', 410, 'ROOM_CLOSED', '房间已经关闭。');
  const next = clone(game);
  const phase = (...phases) => ensure(phases.includes(next.phase), 409, 'WRONG_PHASE', '当前阶段无法执行这个操作。');
  const actor = (expected) => ensure(role === expected, 403, 'WRONG_ACTOR', '请等待另一位玩家操作。');
  const stage = (expected, actual = next.stage) => ensure(actual === expected, 409, 'WRONG_STAGE', '当前步骤已经变化，请刷新房间。');
  const round = next.story.rounds[next.roundIndex];
  switch (command.action) {
    case 'ready':
      phase('waiting', 'briefing');
      if (next.ready[role]) return next;
      next.ready[role] = true;
      if (next.phase === 'briefing' && next.ready.A && next.ready.B) {
        next.phase = 'playing';
        next.stage = 'compose';
      }
      break;
    case 'compose':
      phase('playing');
      actor(round.speaker);
      stage('compose');
      compose(next, command.intentId, command.lineId);
      break;
    case 'clarify':
      phase('playing');
      actor(opposite(round.speaker));
      stage('interpret');
      if (next.pending.asked) return next;
      next.pending.asked = true;
      next.pending.clarification = intentFor(round, next.pending.intentId).clarification;
      break;
    case 'interpret':
      phase('playing');
      actor(opposite(round.speaker));
      stage('interpret');
      interpret(next, command.guessId, command.response);
      break;
    case 'repair': {
      phase('reveal');
      ensure(Number.isSafeInteger(command.index) && command.index >= 0 && command.index < next.records.length, 400, 'INVALID_INDEX', '请选择已完成的一轮。');
      const original = next.records[command.index];
      if (next.mode === 'duo') actor(original.speaker);
      next.phase = 'repair';
      next.repair = { index: command.index, speaker: original.speaker, stage: 'compose' };
      break;
    }
    case 'repair-compose': {
      phase('repair');
      if (next.mode === 'duo') actor(next.repair.speaker);
      stage('compose', next.repair.stage);
      const line = next.story.rounds[next.repair.index].lines.find((candidate) => candidate.id === command.lineId);
      ensure(line, 400, 'INVALID_CHOICE', '请选择这一轮提供的表达。');
      ensure(line.id !== next.records[next.repair.index].lineId, 400, 'UNCHANGED_LINE', '修复时请尝试另一种表达。');
      next.repair.lineId = line.id;
      next.repair.text = line.text;
      next.repair.stage = 'interpret';
      break;
    }
    case 'repair-interpret':
      phase('repair');
      actor(opposite(next.repair.speaker));
      stage('interpret', next.repair.stage);
      repairInterpret(next, command.guessId);
      break;
    case 'repair-end':
      phase('repair');
      next.phase = 'reveal';
      next.repair = null;
      break;
    case 'leave':
      next.phase = 'closed';
      next.stage = 'wait';
      next.repair = null;
      break;
    default:
      throw new GameError(400, 'INVALID_COMMAND', '未知的房间操作。');
  }
  runNpc(next);
  next.revision += 1;
  return next;
}

function publicRecord(record) {
  const { index, speaker, title, text, reply, asked } = record;
  const result = { index, speaker, title, text, reply, asked };
  if (asked) result.clarification = record.clarification;
  return result;
}

export function projectView(game, role, { partnerJoined = false, partnerOnline = false } = {}) {
  ensure(role === 'A' || role === 'B', 403, 'FORBIDDEN', '你不是这个房间的成员。');
  const view = {
    id: game.id, mode: game.mode, revision: game.revision, phase: game.phase, role,
    story: storySummary(game.story), ownRole: clone(game.story.roles[role]), ready: { ...game.ready },
    partnerJoined: game.mode === 'solo' || partnerJoined,
    partnerOnline: game.phase !== 'closed' && (game.mode === 'solo' || partnerOnline),
    roundIndex: game.roundIndex, stage: 'wait', records: game.records.map(publicRecord), expiresAt: game.expiresAt,
  };
  if (game.phase === 'playing') {
    const round = game.story.rounds[game.roundIndex];
    const previous = game.records.at(-1);
    const lead = previous?.response === 'boundary' ? 'boundary' : previous?.asked ? 'clarified' : 'normal';
    view.round = { index: game.roundIndex, speaker: round.speaker, title: round.title, prompt: round.prompt, leadIn: round.leadIns[lead] };
    if (game.stage === 'compose' && role === round.speaker) {
      view.stage = 'compose';
      view.round.intents = choices(round);
      view.round.lines = round.lines.map(({ id, text, style }) => ({ id, text, style }));
    }
    if (game.stage === 'interpret') {
      view.round.incoming = { text: game.pending.text };
      if (game.pending.asked) view.round.incoming.clarification = game.pending.clarification;
      if (role !== round.speaker) {
        view.stage = 'interpret';
        view.round.interpretations = choices(round, true);
        view.round.replies = { accept: round.replies.accept, boundary: round.replies.boundary };
      }
    }
  }
  if (game.phase === 'reveal' || game.phase === 'repair') {
    const ending = game.records.some((record) => record.response === 'boundary') ? 'boundary'
      : game.records.some((record) => record.asked) ? 'clarified' : 'open';
    view.reveal = {
      roles: clone(game.story.roles), records: clone(game.records),
      ending: game.story.endings[ending], takeaway: game.story.takeaway,
    };
  }
  if (game.phase === 'repair') {
    const repair = game.repair;
    const round = game.story.rounds[repair.index];
    view.repair = { index: repair.index, speaker: repair.speaker, original: clone(game.records[repair.index]), stage: repair.stage };
    if (repair.stage === 'compose' && (game.mode === 'solo' || role === repair.speaker)) {
      view.repair.lines = round.lines
        .filter((line) => line.id !== game.records[repair.index].lineId)
        .map(({ id, text, style }) => ({ id, text, style }));
    }
    if (repair.text !== undefined) view.repair.text = repair.text;
    if (repair.stage === 'interpret' && role !== repair.speaker) view.repair.interpretations = choices(round, true);
    if (repair.stage === 'done') {
      view.repair.interpreted = repair.interpreted;
      view.repair.matched = repair.matched;
    }
  }
  return view;
}
