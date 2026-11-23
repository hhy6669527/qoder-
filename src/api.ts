import type { Command, GameView, Mode, Session, StorySummary } from '../shared/types';

const ROOT = '/functions/v1/app/api';
export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
export function requestId() { return crypto.randomUUID(); }
async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${ROOT}${path}`, { ...init, signal: ctrl.signal, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }, cache: 'no-store' });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new ApiError('backend_unavailable', '故事服务暂时没有连接上，请稍后重试。', res.status); }
    if (!res.ok) throw new ApiError(body.error?.code || 'request_failed', body.error?.message || '操作暂未完成，请重试。', res.status);
    return body as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('network', '连接暂时中断，刚才的操作可能已送达。请重试同一次操作，不会重复提交。');
  } finally { clearTimeout(timer); }
}
export const api = {
  stories: () => request<{ stories: StorySummary[] }>('/stories'),
  create: (storyId: string, mode: Mode, token: string, id: string) => request<{ view: GameView }>('/rooms', { method: 'POST', body: JSON.stringify({ storyId, mode, token, requestId: id }) }),
  join: (roomId: string, token: string, id: string) => request<{ view: GameView }>(`/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: JSON.stringify({ token, requestId: id }) }),
  read: (session: Session) => request<{ view: GameView }>(`/rooms/${encodeURIComponent(session.roomId)}`, {}, session.token),
  presence: (session: Session) => request<{ view: GameView }>(`/rooms/${encodeURIComponent(session.roomId)}/presence`, { method: 'POST', body: '{}' }, session.token),
  command: (session: Session, revision: number, id: string, command: Command) => request<{ view: GameView }>(`/rooms/${encodeURIComponent(session.roomId)}/commands`, { method: 'POST', body: JSON.stringify({ ...command, revision, requestId: id }) }, session.token),
};
const memorySessions = new Map<string, Session>();
let memoryActive: string | null = null;
export function saveSession(session: Session) {
  memorySessions.set(session.roomId, session); memoryActive = session.roomId;
  try { sessionStorage.setItem(`wavelength:${session.roomId}`, JSON.stringify(session)); sessionStorage.setItem('wavelength:active', session.roomId); } catch { /* This page remains usable without storage; refresh recovery needs sessionStorage. */ }
}
export function loadSession(roomId: string): Session | null {
  if (memorySessions.has(roomId)) return memorySessions.get(roomId)!;
  try { const value = JSON.parse(sessionStorage.getItem(`wavelength:${roomId}`) || 'null'); return value && value.roomId === roomId && /^[a-f0-9]{64}$/.test(value.token) ? value : null; } catch { return null; }
}
export function activeSession(): Session | null {
  if (memoryActive) return loadSession(memoryActive);
  try { const id = sessionStorage.getItem('wavelength:active'); return id ? loadSession(id) : null; } catch { return null; }
}
export function forgetActive() { memoryActive = null; try { sessionStorage.removeItem('wavelength:active'); } catch { /* optional persistence */ } }
export interface Echo { id: string; storyId: string; title: string; relation: string; quote: string; takeaway: string; date: number; mode: Mode }
export function readEchoes(): Echo[] {
  try { const data = JSON.parse(localStorage.getItem('wavelength:echoes') || '[]'); return Array.isArray(data) ? data.filter(x => x && typeof x.storyId === 'string' && typeof x.date === 'number').slice(0, 30) : []; } catch { return []; }
}
export function saveEcho(view: GameView) {
  if (!view.reveal) return;
  const old = readEchoes();
  if (old.some(x => x.id === view.id)) return;
  const item: Echo = { id: view.id, storyId: view.story.id, title: view.story.title, relation: view.story.relation, quote: view.story.quote, takeaway: view.reveal.takeaway, date: Date.now(), mode: view.mode };
  try { localStorage.setItem('wavelength:echoes', JSON.stringify([item, ...old].slice(0, 30))); } catch { /* optional history */ }
}
