import { useState } from 'react';
import { Sheet, Button, Input } from '../ui';
import { useCaptureOpen, closeCapture } from './palette-store';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { toast } from '../ui/toast';

/** ⌘N anywhere in the app; the global shortcut opens the same thing in a small panel. */
export function CaptureSheet() {
  const open = useCaptureOpen();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/capture', { text });
      toast(r.message ?? 'Captured');
      setText('');
      closeCapture();
      void queryClient.invalidateQueries();
    } catch (e: any) {
      toast(e.message);
    } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={closeCapture} title="Quick capture" subtitle="Lands in your Todoist inbox. Dates, #project, @label and p1–p4 are parsed by Todoist."
      footer={<><span className="left faint tiny">Return to save · Esc to close</span><Button onClick={closeCapture}>Cancel</Button><Button variant="primary" disabled={busy || !text.trim()} onClick={submit}>Capture</Button></>}>
      <Input style={{ width: '100%', height: 32, fontSize: 15 }} value={text} placeholder="Email Dr. Lim about the poster draft tomorrow 4pm #Lim Lab"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
    </Sheet>
  );
}
