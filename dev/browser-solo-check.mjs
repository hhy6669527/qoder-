import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const cli = process.argv[2];
if (!cli) throw new Error('Pass the installed agent-browser.js path.');
const session = 'wavelength-7e1dee0fc4f2';
const story = JSON.parse(readFileSync(new URL('../content/stories.json', import.meta.url), 'utf8')).find(s => s.id === 'friends-meal');
function call(...args) { return execFileSync(process.execPath, [cli, '--session', session, ...args], { encoding: 'utf8', timeout: 45000 }).trim(); }
function click(text) {
  const snapshot = call('snapshot', '-i');
  const line = snapshot.split('\n').find(l => l.includes(`- button "${text}"`) && !l.includes('[disabled'));
  assert.ok(line, `Button absent: ${text}\n${snapshot}`);
  call('click', '@' + line.match(/\[ref=(e\d+)\]/)[1]);
}
function wait(text) { call('wait', '--text', text); }
call('open', process.argv[3] || 'http://127.0.0.1:5175/');
call('set', 'viewport', '1440', '1000');
console.log(call('screenshot', '--full'));
click('坐到故事里'); click('翻开我的这一面'); wait('我准备好了'); click('我准备好了，进入故事');
for (let index = 0; index < 3; index++) {
  const round = story.rounds[index];
  if (index === 1) {
    wait('你觉得，对方想表达什么');
    click('先问一句：“你具体指的是？” 不必急着猜，可以补上缺失的信息');
    wait(round.intents.find(i => i.id === round.npc.intent).clarification);
    click(round.intents.find(i => i.id === round.npc.intent).label);
    click(round.replies.boundary); click('留下我的理解，继续');
  } else {
    wait('此刻，你最想表达什么');
    click(round.intents[0].label); click('接下来，选一句说法');
    click(`“${round.lines[0].text}”`); click('把这句话说出口');
  }
}
wait('如果，换个座位呢');
click('坐到另一边'); wait('现在，坐到周禾的位置');
click('替周禾换一句话'); wait('现在，替周禾说一句');
call('set', 'viewport', '390', '844');
click(story.rounds[1].lines[1].text); click('用新的说法，再试一次');
wait('这次，意思更接近了');
click('回到原来的双轨回放'); wait('把意思，一句句对齐');
const value = JSON.parse(call('eval', '({overflow:document.documentElement.scrollWidth>innerWidth,records:document.querySelectorAll(".replay-record").length,text:document.body.innerText})'));
assert.equal(value.overflow, false);
assert.equal(value.records, 3);
assert.ok(value.text.includes(story.rounds[1].lines[0].text), 'Original B expression must survive swapped replay');
console.log('PASS: solo dialogue, clarification, boundary, actual B-role expression replay and return without re-opening sealed perspective');
console.log(call('screenshot', '--full'));
const errors = call('errors');
console.log('Page errors:', errors || 'none');
click('再遇见一件小事'); wait('找一件熟悉的小事');
console.log('PASS: return to library with completed echo');
