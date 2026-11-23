import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stories = JSON.parse(await readFile(new URL('../content/stories.json', import.meta.url), 'utf8'));
const relations = ['friends', 'family', 'couple'];
const topics = ['meal', 'travel', 'message', 'help'];
const moods = ['轻松日常', '温柔反转', '边界练习'];
const intentIds = ['i1', 'i2', 'i3'];
const lineIds = ['l1', 'l2', 'l3'];
const titles = [
  '都行，你选', '行程排满了', '群里没人接话', '我帮你改好了',
  '怎么又剩下了', '定位发一下', '一个“嗯”的距离', '房间替你收拾了',
  '今天就吃这个？', '照片里的空位', '你先忙吧', '我只是想说说',
];
const expectedIds = relations.flatMap((relation) => topics.map((topic) => `${relation}-${topic}`));

function shape(value, keys, path) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path}: expected an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${path}: required contract keys`);
}

function text(value, path) {
  assert.equal(typeof value, 'string', `${path}: expected a string`);
  assert.ok(value.trim().length > 0, `${path}: must not be empty`);
  assert.equal(value, value.trim(), `${path}: no surrounding whitespace`);
}

function textFields(value, keys, path) {
  for (const key of keys) text(value[key], `${path}.${key}`);
}

function distinct(values, path) {
  assert.equal(new Set(values).size, values.length, `${path}: values must be unique`);
}

function reference(value, validIds, path) {
  text(value, path);
  assert.ok(validIds.includes(value), `${path}: ${value} must refer to ${validIds.join(', ')}`);
}

test('catalog contains exactly 12 unique stories and every relation-topic combination once', () => {
  assert.ok(Array.isArray(stories));
  assert.equal(stories.length, 12);
  distinct(stories.map((story) => story.id), 'story IDs');
  assert.deepEqual(stories.map((story) => story.id).sort(), [...expectedIds].sort());
  const combinations = stories.map((story) => `${story.relation}-${story.topic}`);
  distinct(combinations, 'relation-topic combinations');
  assert.deepEqual(combinations.sort(), [...expectedIds].sort());
  for (const story of stories) assert.equal(story.id, `${story.relation}-${story.topic}`);
});

test('catalog preserves the requested order, numbering, titles, duration and short copy', () => {
  assert.deepEqual(stories.map((story) => story.id), expectedIds);
  assert.deepEqual(stories.map((story) => story.title), titles);
  assert.deepEqual(stories.map((story) => story.number), titles.map((_, index) => String(index + 1).padStart(2, '0')));
  for (const story of stories) {
    assert.equal(story.duration, '3–5 分钟', `${story.id}.duration`);
    assert.ok(moods.includes(story.mood), `${story.id}.mood`);
    assert.ok([...story.subtitle].length <= 30, `${story.id}.subtitle: maximum 30 characters`);
    assert.ok([...story.quote].length <= 32, `${story.id}.quote: keep the quote concise`);
  }
});

for (const story of stories) {
  test(`${story.id}: complete Story, adult cast, endings and reflection`, () => {
    shape(story, [
      'id', 'number', 'relation', 'topic', 'title', 'subtitle', 'quote', 'location',
      'mood', 'duration', 'setup', 'objective', 'roles', 'rounds', 'endings', 'takeaway',
    ], story.id);
    textFields(story, [
      'id', 'number', 'relation', 'topic', 'title', 'subtitle', 'quote', 'location',
      'mood', 'duration', 'setup', 'objective', 'takeaway',
    ], story.id);
    assert.ok(relations.includes(story.relation), `${story.id}.relation`);
    assert.ok(topics.includes(story.topic), `${story.id}.topic`);
    shape(story.roles, ['A', 'B'], `${story.id}.roles`);
    for (const role of ['A', 'B']) {
      const person = story.roles[role];
      const path = `${story.id}.roles.${role}`;
      shape(person, ['name', 'identity', 'background', 'goal'], path);
      textFields(person, ['name', 'identity', 'background', 'goal'], path);
      const age = person.identity.match(/(\d+)岁/u);
      assert.ok(age && Number(age[1]) >= 18, `${path}: explicitly adult identity`);
    }
    assert.notEqual(story.roles.A.name, story.roles.B.name, `${story.id}: distinct character names`);
    shape(story.endings, ['clarified', 'boundary', 'open'], `${story.id}.endings`);
    textFields(story.endings, ['clarified', 'boundary', 'open'], `${story.id}.endings`);
    distinct(Object.values(story.endings), `${story.id}.endings`);
    assert.equal((story.takeaway.match(/[?？]/gu) ?? []).length, 1, `${story.id}.takeaway: one reflection question`);
    assert.match(story.takeaway, /[?？]$/u);
  });

  test(`${story.id}: three A/B/A rounds with complete deterministic solo authoring`, () => {
    assert.ok(Array.isArray(story.rounds), `${story.id}.rounds: expected an array`);
    assert.equal(story.rounds.length, 3, `${story.id}.rounds: exactly three rounds`);
    assert.deepEqual(story.rounds.map((round) => round.speaker), ['A', 'B', 'A']);
    for (const [index, round] of story.rounds.entries()) {
      const path = `${story.id}.rounds[${index}]`;
      shape(round, ['speaker', 'title', 'prompt', 'leadIns', 'intents', 'lines', 'replies', 'npc', 'insight'], path);
      textFields(round, ['speaker', 'title', 'prompt', 'insight'], path);
      shape(round.leadIns, ['normal', 'clarified', 'boundary'], `${path}.leadIns`);
      textFields(round.leadIns, ['normal', 'clarified', 'boundary'], `${path}.leadIns`);
      shape(round.replies, ['accept', 'boundary'], `${path}.replies`);
      textFields(round.replies, ['accept', 'boundary'], `${path}.replies`);
      assert.notEqual(round.replies.accept, round.replies.boundary, `${path}: meaningful reply alternatives`);

      assert.ok(Array.isArray(round.intents), `${path}.intents: expected an array`);
      assert.equal(round.intents.length, 3, `${path}: three sender-approved intentions`);
      assert.deepEqual(round.intents.map((intent) => intent.id).sort(), intentIds, `${path}: unique intention IDs`);
      for (const intent of round.intents) {
        shape(intent, ['id', 'label', 'clarification'], `${path}.intents.${intent.id}`);
        textFields(intent, ['id', 'label', 'clarification'], `${path}.intents.${intent.id}`);
        assert.notEqual(intent.id, 'unsure', `${path}: unsure is supplied by the engine, not the sender`);
      }
      distinct(round.intents.map((intent) => intent.label), `${path}: interpretation labels`);
      distinct(round.intents.map((intent) => intent.clarification), `${path}: approved clarifications`);

      assert.ok(Array.isArray(round.lines), `${path}.lines: expected an array`);
      assert.equal(round.lines.length, 3, `${path}: three expression choices`);
      assert.deepEqual(round.lines.map((line) => line.id).sort(), lineIds, `${path}: unique expression IDs`);
      assert.deepEqual(round.lines.map((line) => line.style).sort(), ['direct', 'hint', 'question']);
      for (const line of round.lines) {
        shape(line, ['id', 'text', 'style'], `${path}.lines.${line.id}`);
        textFields(line, ['id', 'text', 'style'], `${path}.lines.${line.id}`);
        if (line.style === 'question') assert.match(line.text, /[?？]/u, `${path}: includes an actual question`);
      }
      distinct(round.lines.map((line) => line.text), `${path}: distinct expressions`);

      // A rounds use B's complete line-to-guess table; the B round uses the authored intent/line.
      // Guesses are interpretations, not an answer key: they need not match the sender's intent.
      shape(round.npc, ['intent', 'line', 'guessByLine'], `${path}.npc`);
      const availableIntents = round.intents.map((intent) => intent.id);
      const availableLines = round.lines.map((line) => line.id);
      reference(round.npc.intent, availableIntents, `${path}.npc.intent`);
      reference(round.npc.line, availableLines, `${path}.npc.line`);
      shape(round.npc.guessByLine, availableLines, `${path}.npc.guessByLine`);
      for (const lineId of availableLines) {
        reference(round.npc.guessByLine[lineId], availableIntents, `${path}.npc.guessByLine.${lineId}`);
      }
    }
  });
}
