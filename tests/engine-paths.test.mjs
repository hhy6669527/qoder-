import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, applyCommand, projectView, validateStories } from '../functions/engine.mjs';
const stories = validateStories(JSON.parse(readFileSync(new URL('../content/stories.json', import.meta.url), 'utf8')));

for (const story of stories) {
  test(`${story.id}: every authored choice is reachable and solo endings/repair preserve original evidence`, () => {
    let paths = 0;
    const intentIds = [...story.rounds[0].intents.map(i => i.id), 'unsure'];
    for (const intentId of intentIds) for (const first of story.rounds[0].lines) {
      for (const guessId of [...story.rounds[1].intents.map(i => i.id), 'unsure']) {
        for (const response of ['accept', 'boundary']) for (const clarify of [false, true]) {
          for (const last of story.rounds[2].lines) {
            let game = createGame({ id: 'pathsample', mode: 'solo', story });
            game = applyCommand(game, 'A', { action: 'ready' });
            game = applyCommand(game, 'A', { action: 'compose', intentId, lineId: first.id });
            assert.equal(game.roundIndex, 1);
            const hidden = projectView(game, 'A');
            assert.equal(hidden.reveal, undefined);
            assert.equal(hidden.story.rounds, undefined);
            assert.equal(hidden.round.intents, undefined);
            assert.equal(hidden.records[0].intended, undefined);
            assert.equal(hidden.records[0].interpreted, undefined);
            if (clarify) game = applyCommand(game, 'A', { action: 'clarify' });
            game = applyCommand(game, 'A', { action: 'interpret', guessId, response });
            game = applyCommand(game, 'A', { action: 'compose', intentId: story.rounds[2].intents[0].id, lineId: last.id });
            const result = projectView(game, 'A');
            assert.equal(game.phase, 'reveal');
            assert.equal(result.reveal.records.length, 3);
            assert.equal(result.reveal.records[0].intentId, intentId);
            assert.equal(result.reveal.records[1].guessedId, guessId);
            assert.equal(result.reveal.records[1].asked, clarify);
            assert.ok(result.reveal.ending.length > 15);
            for (const record of result.reveal.records) {
              if (record.intentId !== 'unsure' && record.guessedId !== 'unsure' && !record.matched) {
                assert.ok(record.insight.includes(record.intended));
                assert.ok(record.insight.includes(record.interpreted));
              }
            }
            assert.equal(result.reveal.ending, story.endings[response === 'boundary' ? 'boundary' : clarify ? 'clarified' : 'open']);
            if (intentId === 'unsure') assert.equal(result.reveal.records[0].matched, false);
            if (paths === 0) {
              const original = structuredClone(game.records);
              game = applyCommand(game, 'A', { action: 'repair', index: 0 });
              const newLine = story.rounds[0].lines.find(l => l.id !== first.id);
              game = applyCommand(game, 'A', { action: 'repair-compose', lineId: newLine.id });
              assert.equal(game.repair.stage, 'done');
              assert.deepEqual(game.records, original);
              game = applyCommand(game, 'A', { action: 'repair-end' });
              assert.equal(game.phase, 'reveal');
              game = applyCommand(game, 'A', { action: 'repair', index: 1 });
              const swappedView = projectView(game, 'A');
              assert.equal(swappedView.repair.speaker, 'B');
              assert.ok(swappedView.repair.lines.length >= 1);
              game = applyCommand(game, 'A', { action: 'repair-compose', lineId: swappedView.repair.lines[0].id });
              assert.equal(game.repair.stage, 'done');
              assert.deepEqual(game.records, original);
              game = applyCommand(game, 'A', { action: 'repair-end' });
              assert.equal(game.phase, 'reveal');
            }
            paths++;
          }
        }
      }
    }
    assert.equal(paths, 576);
  });
}
