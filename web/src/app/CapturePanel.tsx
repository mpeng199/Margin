import { useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../ui';

/** The floating panel the global shortcut opens (⌃⌥Space). One field; Return saves, Esc closes. */
export function CapturePanel() {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const close = () => (window as any).margin?.closeCapture?.();
  const submit = async () => {
    if (!text.trim()) return;
    try {
      const r = await api.post<{ message: string }>('/api/capture', { text });
      setMsg(r.message ?? 'Captured');
      setText('');
      setTimeout(close, 700);
    } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="capture-panel" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <Icon name="Plus" size={18} />
      <input autoFocus className="input bare" value={text} placeholder="Capture to Todoist…" aria-label="Capture to Todoist"
        onChange={(e) => { setText(e.target.value); setMsg(null); }} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      <div className="capture-hint">{msg ?? 'Return to save · Esc to close · dates, #project, @label, p1 work'}</div>
    </div>
  );
}
