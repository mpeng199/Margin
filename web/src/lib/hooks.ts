import { useEffect, useState } from 'react';
import { useApi } from './query';
import type { DayState } from '@modules/day/manifest';

export interface ModuleInfo {
  id: string; name: string; description: string; core: boolean; enabled: boolean; requires: string[];
  nav: { id: string; label: string; icon: string; path: string; section: 'main' | 'projects' | 'secondary'; order: number; shortcut?: string; work?: boolean }[];
  widgets: { id: string; slot: string; order: number }[];
  hasSettings: boolean; settingsSchema: any; emits: string[]; consumes: string[];
  claudeTools: { name: string; kind: string; description: string }[];
}

export const useModules = () => useApi<ModuleInfo[]>('/api/modules', { staleTime: 60_000 });
export function useEnabled(id: string) {
  const { data } = useModules();
  return !!data?.find((m) => m.id === id && m.enabled);
}
/** Server clock minus client clock (the daemon is the time authority; dev can pin it). */
let serverOffset = 0;
export const serverNow = () => Date.now() + serverOffset;
export function useDay() {
  const q = useApi<DayState>('/api/day/state', { refetchInterval: 30_000 });
  if (q.data) serverOffset = Date.parse(q.data.now) - q.dataUpdatedAt;
  return q;
}
export function useSettings<T = any>(module: string) {
  return useApi<T>(`/api/settings/${module}`);
}

/** Re-render every `ms` (for countdowns). */
export function useNow(ms = 15_000) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
  return serverNow();
}

export function useHotkey(combo: string, fn: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (matches(e, combo)) { e.preventDefault(); fn(e); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
/** 'Mod+K', 'Mod+Shift+N', 'Escape' — Mod is ⌘ on Mac. */
export function matches(e: KeyboardEvent, combo: string) {
  const parts = combo.split('+');
  const key = parts.pop()!.toLowerCase();
  const want = new Set(parts.map((p) => p.toLowerCase()));
  const mod = e.metaKey || e.ctrlKey;
  if (want.has('mod') !== mod) return false;
  if (want.has('shift') !== e.shiftKey) return false;
  if (want.has('alt') !== e.altKey) return false;
  return e.key.toLowerCase() === key || e.code.toLowerCase() === `key${key}` || e.code.toLowerCase() === `digit${key}`;
}
export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};
