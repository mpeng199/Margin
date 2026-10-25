import { useSyncExternalStore } from 'react';

type T = { id: number; text: string; action?: { label: string; run: () => void } };
let items: T[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

/** Feedback lives in the interface, not alerts. Toasts are brief and never block. */
export function toast(text: string, action?: T['action'], ms = 3600) {
  const id = Date.now() + Math.random();
  items = [...items, { id, text, action }];
  emit();
  setTimeout(() => { items = items.filter((t) => t.id !== id); emit(); }, ms);
}

export function Toasts() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => items);
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div className="toast" key={t.id}>
          <span>{t.text}</span>
          {t.action && <button className="btn plain" onClick={() => { t.action!.run(); items = items.filter((x) => x.id !== t.id); emit(); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
