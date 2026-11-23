import type { Command, Session } from '../shared/types';
export interface Attempt { key: string; token: string; id: string }
export interface PendingCommand { session: Session; revision: number; id: string; command: Command }
function read<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') as T | null; } catch { return null; }
}
function write(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory recovery remains available until refresh. */ } }
function remove(key: string) { try { sessionStorage.removeItem(key); } catch { /* optional storage */ } }
export function getAttempt(key: string): Attempt {
  const old = read<Attempt>(`wavelength:attempt:${key}`);
  if (old?.key === key && /^[a-f0-9]{64}$/.test(old.token) && typeof old.id === 'string') return old;
  const next = { key, token: Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join(''), id: crypto.randomUUID() };
  write(`wavelength:attempt:${key}`, next);
  return next;
}
export function clearAttempt(key: string) { remove(`wavelength:attempt:${key}`); }
export function storePending(pending: PendingCommand) { write(`wavelength:pending:${pending.session.roomId}`, pending); }
export function loadPending(roomId: string): PendingCommand | null {
  const pending = read<PendingCommand>(`wavelength:pending:${roomId}`);
  return pending?.session?.roomId === roomId && /^[a-f0-9]{64}$/.test(pending.session.token) && Number.isInteger(pending.revision) && typeof pending.id === 'string' && typeof pending.command?.action === 'string' ? pending : null;
}
export function clearPending(roomId: string) { remove(`wavelength:pending:${roomId}`); }
