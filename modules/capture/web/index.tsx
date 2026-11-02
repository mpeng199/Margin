import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';
import { useEnabled } from '@web/lib/hooks';
import { Section, Group, Item, Button, Input, toast } from '@web/ui';
import { relDay, relDayLower, todayISO } from '@web/lib/format';

/** Evening capture: one calm line. Items land in tomorrow's inbox, or in your notes. */
function EveningCapture() {
  const brain = useEnabled('brain');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const submit = async (asNote = false) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = asNote
        ? await api.post<{ title: string }>('/api/brain/capture', { text }).then((n) => ({ message: `Saved “${n.title}” to your notes.` }))
        : await api.post<{ message: string }>('/api/capture', { text });
      setLast(r.message ?? 'Saved for tomorrow.');
      setText('');
      void queryClient.invalidateQueries();
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Section title="Anything still on your mind?" why="Writing it down stops it from nagging (Masicampo & Baumeister 2011)">
      <Group pad>
        <div className="row">
          <Input className="grow" style={{ height: 32, fontSize: 14 }} value={text} placeholder="It’ll be in your inbox in the morning"
            onChange={(e) => { setText(e.target.value); setLast(null); }} onKeyDown={(e) => { if (e.key === 'Enter') void submit(brain && (e.metaKey || e.ctrlKey)); }} aria-label="Capture for tomorrow" />
          {brain && <Button disabled={busy || !text.trim()} onClick={() => void submit(true)} title="Keep it as a note instead of a task (⌘Return)">Save as Note</Button>}
          <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void submit()}>Save</Button>
        </div>
        {last && <p className="small muted" style={{ marginTop: 8 }}>{last}</p>}
      </Group>
    </Section>
  );
}

interface LastNightItem { id: string; text: string; taskId: string; content: string; projectName: string; capturedAt: string }

/** Morning: what you captured last night, with one decision each. */
function FromLastNight() {
  const q = useApi<LastNightItem[]>('/api/capture/last-night');
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [date, setDate] = useState(todayISO());
  const items = q.data ?? [];
  if (!items.length) return null;
  const act = async (path: string, body?: unknown, msg?: string) => {
    try { await api.post(path, body); if (msg) toast(msg); void queryClient.invalidateQueries(); }
    catch (e: any) { toast(e.message); }
  };
  return (
    <Section title="From last night" why={`${items.length} captured after your stop`}>
      <Group>
        {items.map((i) => (
          <Item key={i.id}>
            <div className="title">
              <div className="ellipsis">{i.content}</div>
              <div className="sub">{i.projectName || 'Inbox'}</div>
            </div>
            {scheduling === i.id ? (
              <>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Schedule for" />
                <Button variant="primary" onClick={() => { setScheduling(null); void act(`/api/capture/items/${i.id}/schedule`, { date }, `Scheduled for ${relDayLower(date)}.`); }}>Set</Button>
              </>
            ) : (
              <>
                <Button onClick={() => act(`/api/capture/items/${i.id}/must-do`, {}, 'Added to today’s must-dos.')}>Make Must-Do</Button>
                <Button onClick={() => setScheduling(i.id)}>Schedule</Button>
                <Button variant="plain" onClick={() => act(`/api/capture/items/${i.id}/keep`)}>Keep in Inbox</Button>
              </>
            )}
          </Item>
        ))}
      </Group>
    </Section>
  );
}

export default defineWebModule({
  id: 'capture',
  widgets: { capture: EveningCapture, 'from-last-night': FromLastNight },
});
