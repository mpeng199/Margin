import { useState } from 'react';
import { Sheet, Button, Input } from '../ui';
import { useCaptureOpen, closeCapture } from './palette-store';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { useEnabled } from '../lib/hooks';
import { toast } from '../ui/toast';

/** ⌘N anywhere in the app; the global shortcut opens the same thing in a small panel. ⌘Return saves a note to the brain instead. */
export function CaptureSheet() {
  const open = useCaptureOpen();
  const brain = useEnabled('brain');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (asNote = false) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = asNote
        ? await api.post<{ title: string }>('/api/brain/capture', { text }).then((n) => ({ message: `Saved “${n.title}” to your Notes inbox.` }))
        : await api.post<{ message: string }>('/api/capture', { text });
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
      footer={<>
        <span className="left faint tiny">{brain ? '⌘Return saves a note' : 'Return to save · Esc to close'}</span>
        <Button onClick={closeCapture}>Cancel</Button>
        {brain && <Button disabled={busy || !text.trim()} onClick={() => void submit(true)}>Save as Note</Button>}
        <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void submit()}>Capture</Button>
      </>}>
      <Input style={{ width: '100%', height: 32, fontSize: 15 }} value={text} placeholder="Email Dr. Lim about the poster draft tomorrow 4pm #Lim Lab"
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(brain && (e.metaKey || e.ctrlKey)); }} />
    </Sheet>
  );
}
