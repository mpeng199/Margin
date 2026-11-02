import { useSyncExternalStore } from 'react';

/** What the note list shows. Kept for the session so moving between notes keeps your place. */
export interface Filter { area: string | null; tag: string | null; q: string; trash: boolean }
let state: Filter = { area: null, tag: null, q: '', trash: false };
const subs = new Set<() => void>();
export const setFilter = (p: Partial<Filter>) => { state = { ...state, ...p }; subs.forEach((s) => s()); };
export const useFilter = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state);
