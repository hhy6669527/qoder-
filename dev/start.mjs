import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
async function existingService() {
  try {
    const res = await fetch('http://127.0.0.1:8788/functions/v1/app/api/stories', { signal: AbortSignal.timeout(1200) });
    const body = await res.json();
    return res.ok && body.stories?.length === 12 && body.stories.some(s => s.id === 'friends-meal') && body.stories.some(s => s.id === 'couple-help');
  } catch { return false; }
}
function start(file, args = []) {
  const child = spawn(process.execPath, [resolve(root, file), ...args], { cwd: root, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
  return child;
}
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
if (!await existingService()) start('dev/server.mjs');
else console.log('Reusing verified Same Wavelength local story service on 127.0.0.1:8788.');
start('node_modules/vite/bin/vite.js', ['--host', '127.0.0.1', '--port', '5175']);
console.log(`Same Wavelength development launcher PID=${process.pid}; project=${root}`);
