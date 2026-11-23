// Optional local browser regression runner. Pass the verified agent-browser CLI path.
// Uses isolated task-owned sessions and real DOM clicks; never touches user tabs.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const cli = process.argv[2];
if (!cli) throw new Error('Pass the installed agent-browser.js path as the first argument.');
const a = 'wavelength-7e1dee0fc4f2';
const b = `${a}-b`;
const origin = process.argv[3] || 'http://127.0.0.1:5175';
const story = JSON.parse(readFileSync(new URL('../content/stories.json', import.meta.url), 'utf8')).find(s => s.id === 'friends-meal');
function call(session, ...args) {
  return execFileSync(process.execPath, [cli, '--session', session, ...args], { encoding: 'utf8', timeout: 45000 }).trim();
}
function click(session, text, includes = false) {
  const snapshot = call(session, 'snapshot', '-i');
  const line = snapshot.split('\n').find(l => l.includes('- button ') && !l.includes('[disabled') && (includes ? l.includes(text) : l.includes(`button "${text}"`)));
  assert.ok(line, `Missing enabled button: ${text}\n${snapshot}`);
  const ref = line.match(/\[ref=(e\d+)\]/)?.[1];
  assert.ok(ref);
  call(session, 'click', `@${ref}`);
}
function wait(session, text) { call(session, 'wait', '--text', text); }
function readState(session) {
  // Read only public rendered DOM state, never credentials or private server content.
  const value = JSON.parse(call(session, 'eval', 'JSON.stringify({text:document.body.innerText,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,images:[...document.images].every(i=>i.complete&&i.naturalWidth>0)})'));
  return typeof value === 'string' ? JSON.parse(value) : value;
}
call(a, 'open', origin);
call(a, 'set', 'viewport', '1440', '1000');
click(a, '情侣间 4');
click(a, '帮个小忙');
let snapshot = call(a, 'snapshot', '-i');
assert.ok(snapshot.includes('STORY 12'));
assert.ok(!snapshot.includes('STORY 01'));
click(a, '全部故事 12'); click(a, '所有日常');
click(a, '两个人，交换世界', true);
click(a, '邀请朋友入座');
click(a, '创建双人房间');
wait(a, '故事的另一边');
const roomUrl = call(a, 'get', 'url');
assert.match(roomUrl, /#room\/[A-Za-z0-9]{10,32}$/);
const invite = roomUrl.replace('#room/', '#join/');
console.log('PASS: category filters and real room creation');
call(b, 'open', invite);
// Lose one join response AFTER the backend occupied the seat, then refresh.
call(b, 'eval', '(() => {const original=window.fetch;window.fetch=async(...args)=>{const result=await original(...args);if(String(args[0]).endsWith("/join")){window.fetch=original;throw new TypeError("TEST lost join response");}return result;};return true;})()');
click(b, '坐到另一边'); wait(b, '连接暂时中断');
call(b, 'open', invite); click(b, '坐到另一边');
wait(b, '这一次，你是周禾');
wait(a, '这一次，你是林陶');
assert.ok(!readState(a).text.includes(story.roles.B.background));
assert.ok(!readState(b).text.includes(story.roles.A.background));
console.log('PASS: join response-loss + refresh retains player identity, private role cards isolated');
click(a, '我准备好了，进入故事');
click(b, '我准备好了，进入故事');
for (let index = 0; index < 3; index++) {
  const sender = index === 1 ? b : a;
  const receiver = index === 1 ? a : b;
  const round = story.rounds[index];
  wait(sender, '此刻，你最想表达什么');
  click(sender, round.intents[0].label);
  click(sender, '接下来，选一句说法');
  click(sender, `“${round.lines[0].text}”`);
  click(sender, '把这句话说出口');
  wait(receiver, '你觉得，对方想表达什么');
  if (index === 0) {
    call(receiver, 'open', roomUrl);
    wait(receiver, '你觉得，对方想表达什么');
    click(receiver, '先问一句', true);
    wait(receiver, round.intents[0].clarification);
  }
  click(receiver, round.intents[0].label);
  click(receiver, round.replies.accept);
  click(receiver, '留下我的理解，继续');
}
wait(a, '把意思，一句句对齐'); wait(b, '把意思，一句句对齐');
assert.ok(readState(a).text.includes('这一次，你们听见了彼此'));
assert.ok(readState(b).text.includes('这一次，你们听见了彼此'));
console.log('PASS: both browsers completed three real turns, clarification, refresh recovery and synchronized reveal');
click(a, '这句话，换个说法');
wait(a, '这一次，你想怎么说');
click(a, story.rounds[0].lines[2].text);
click(a, '用新的说法，再试一次');
wait(a, '等对方重新写下理解');
wait(b, '现在，你会怎么理解');
click(b, story.rounds[0].intents[0].label);
click(b, '留下这一次的理解');
wait(a, '这次，意思更接近了'); wait(b, '这次，意思更接近了');
console.log('PASS: repair waits for actual second player, then both see same result');
click(a, '回到原来的双轨回放');
wait(b, '把意思，一句句对齐');
click(a, '结束本局');
click(a, '结束本局');
wait(b, '房间已结束');
console.log('PASS: closing room terminates partner interaction');
call(a, 'open', origin);
call(a, 'set', 'viewport', '390', '844');
call(a, 'set', 'media', 'light', 'reduced-motion');
wait(a, '找一件熟悉的小事');
let mobile = readState(a);
assert.equal(mobile.overflow, false);
assert.equal(mobile.images, true);
console.log('PASS: 390px mobile layout has no horizontal overflow; illustrations load');
console.log(call(a, 'screenshot', '--full'));
call(a, 'set', 'viewport', '844', '390');
assert.equal(readState(a).overflow, false);
console.log('PASS: landscape layout has no horizontal overflow');
call(a, 'set', 'viewport', '1440', '1000');
console.log(call(a, 'screenshot'));
console.log('Browser regression completed. Sessions intentionally retained for final inspection and cleanup.');
