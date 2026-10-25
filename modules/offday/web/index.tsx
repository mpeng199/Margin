import { useState } from 'react';
import { useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { WidgetSlot } from '@web/app/WidgetSlot';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Item, Button, IconButton, Input, Sheet, Banner, Why, Empty, toast } from '@web/ui';
import { fmtDayLong, fmtTime, fmtTimeShort } from '@web/lib/format';
import type { LeisureItem, OffDayTask, OffDayEvent, OffDayWarning } from '../manifest';
import './offday.css';

interface OffdayState { date: string; isToday: boolean; leisure: LeisureItem[]; tasks: OffDayTask[]; events: OffDayEvent[]; locked: boolean }

// Same wording the server refuses with (the manifest can't be imported at runtime in the browser).
const WORK_REFUSAL = 'If it would bother you to get nothing out of it, it’s work. It doesn’t go on the leisure list. Capture it as a task instead.';
const SUGGESTIONS = ['Walk without headphones', 'Call a friend', 'Draw', 'Cook something'];

function useCapture() {
  return useAction<{ text: string }, { message?: string }>('post', '/api/capture', (out) => toast(out?.message ?? 'Captured.'));
}

function Leisure({ items }: { items: LeisureItem[] }) {
  const [title, setTitle] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const add = useAction<{ title: string; upsetIfNothing: boolean }>('post', '/api/offday/leisure');
  const remove = useAction<string>('del', (id) => `/api/offday/leisure/${id}`);
  const capture = useCapture();
  const close = () => { setAsking(null); setRefused(false); };
  const ask = () => { if (title.trim()) setAsking(title.trim()); };
  return (
    <Section title="Leisure" why="Things you’d do even if they produced nothing.">
      <Group>
        {items.map((i) => (
          <Item key={i.id}>
            <div className="title">{i.title}</div>
            <IconButton icon="X" label={`Remove ${i.title}`} onClick={() => remove.mutate(i.id)} />
          </Item>
        ))}
        {!items.length && SUGGESTIONS.map((s) => (
          <Item key={s} className="od-suggest">
            <div className="title">{s}</div>
            <Button variant="plain" onClick={() => add.mutate({ title: s, upsetIfNothing: false })}>Add</Button>
          </Item>
        ))}
        {!items.length && <div className="empty small">Ideas to start with. Add your own below.</div>}
      </Group>
      <form className="od-add" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Input className="grow" aria-label="New leisure item" placeholder="Something to do with no result" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button variant="primary" disabled={!title.trim()} onClick={ask}>Add…</Button>
      </form>
      <Sheet
        open={!!asking}
        onClose={close}
        title="Would I be upset if this produced nothing?"
        subtitle={`“${asking ?? ''}”`}
        footer={refused ? (
          <>
            <Button onClick={close}>Close</Button>
            <Button variant="primary" disabled={capture.isPending} onClick={() => { capture.mutate({ text: asking! }); setTitle(''); close(); }}>Capture As A Task</Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button onClick={() => setRefused(true)}>Yes, I Would</Button>
            <Button variant="primary" disabled={add.isPending} onClick={() => add.mutate({ title: asking!, upsetIfNothing: false }, { onSuccess: () => { setTitle(''); close(); } })}>No, I Wouldn’t</Button>
          </>
        )}
      >
        {refused
          ? <p className="od-refusal">{WORK_REFUSAL}</p>
          : <p className="muted">If the honest answer is yes, it’s work, and it belongs on your task list instead.</p>}
      </Sheet>
    </Section>
  );
}

function CaptureBox() {
  const [text, setText] = useState('');
  const capture = useCapture();
  const send = () => { if (text.trim()) { capture.mutate({ text: text.trim() }); setText(''); } };
  return (
    <Section title="Capture" why="Captured items wait for your next work day.">
      <form className="od-add" style={{ marginTop: 0 }} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Input className="grow" aria-label="Capture" placeholder="Anything that comes to mind" value={text} onChange={(e) => setText(e.target.value)} />
        <Button variant="primary" disabled={!text.trim() || capture.isPending} onClick={send}>Capture</Button>
      </form>
    </Section>
  );
}

function OffdayPage() {
  const q = useApi<OffdayState>('/api/offday/state');
  const s = q.data;
  return (
    <Page title="Day off" subtitle={s ? (s.isToday ? fmtDayLong(s.date) : `Next: ${fmtDayLong(s.date)}`) : undefined} width="narrow">
      {s?.locked && <Banner tone="amber" icon="Lock">Off-day is non-negotiable this week.</Banner>}
      {s ? <Leisure items={s.leisure} /> : <Section><Group><Empty>Loading…</Empty></Group></Section>}
      <CaptureBox />
      <WidgetSlot slot="offday" />
      <p className="od-why"><Why source="Panagioti 2017">Changing the workload and the schedule works better than coping techniques, so the day off is structural, not a reward.</Why></p>
    </Page>
  );
}

/** Evening: the leisure list, quietly. Nothing to say until there is a list. */
function LeisureWidget() {
  const q = useApi<LeisureItem[]>('/api/offday/leisure');
  const items = q.data ?? [];
  if (!items.length) return null;
  return (
    <Section title="Leisure">
      <Group>{items.slice(0, 5).map((i) => <Item key={i.id}><div className="title">{i.title}</div></Item>)}</Group>
    </Section>
  );
}

/** The day before the off-day: what is due on it, what is booked on it, and one tap to clear it. */
function OffdayWarningWidget() {
  const q = useApi<OffDayWarning>('/api/offday/warning');
  const [, navigate] = useLocation();
  const [moved, setMoved] = useState<{ id: string; n: number; label: string } | null>(null);
  const move = useAction<{ date: string }, { id: string; status: string; moved: number }>('post', '/api/offday/warning/move');
  const w = q.data;
  if (!w?.show || (!w.tasks.length && !w.events.length && !moved)) return null;
  const n = w.tasks.length;
  const titles = w.events.map((e) => e.title);
  return (
    <Section title="Day off tomorrow" why="Workload changes beat coping techniques (Panagioti 2017)">
      {w.locked && <p className="small od-locked">Off-day is non-negotiable this week.</p>}
      {moved && (
        <Group pad>
          <div className="row between">
            <span className="small">Moved {moved.n} {moved.n === 1 ? 'task' : 'tasks'} to {moved.label}.</span>
            <Button variant="plain" onClick={() => navigate(`/changes/${moved.id}`)}>View Changes</Button>
          </div>
        </Group>
      )}
      {n > 0 && (
        <>
          <Group>
            {w.tasks.slice(0, 6).map((t) => (
              <Item key={t.id}>
                <div className="title"><div className="ellipsis">{t.content}</div><div className="sub">{t.projectName}{t.recurring ? ' · Repeats' : ''}</div></div>
                {t.time && <span className="meta num">{fmtTime(`${w.date}T${t.time}:00`)}</span>}
              </Item>
            ))}
            {n > 6 && <div className="empty small">and {n - 6} more</div>}
          </Group>
          <div className="od-moves">
            {w.targets.map((t) => (
              <Button key={t.date} disabled={move.isPending} onClick={() => move.mutate({ date: t.date }, { onSuccess: (out) => setMoved({ id: out.id, n: out.moved, label: t.label }) })}>
                Move to {t.label}
              </Button>
            ))}
          </div>
        </>
      )}
      {w.events.length > 0 && (
        <>
          <Group>
            {w.events.map((e) => (
              <Item key={e.id}>
                <div className="title ellipsis">{e.title}</div>
                <span className="meta num">{fmtTimeShort(e.start)}–{fmtTime(e.end)}</span>
              </Item>
            ))}
          </Group>
          <p className="small muted od-note">
            {titles.join(', ')} {titles.length === 1 ? 'is' : 'are'} on your off-day. If {titles.length === 1 ? 'it’s' : 'they’re'} required, pick a different off-day in Settings → Day anchors.
          </p>
        </>
      )}
    </Section>
  );
}

export default defineWebModule({
  id: 'offday',
  routes: [{ path: '/offday', component: OffdayPage }],
  widgets: { leisure: LeisureWidget, 'offday-warning': OffdayWarningWidget },
  commands: [{ id: 'offday.open', label: 'Open Day Off', group: 'Day off', run: () => '/offday' }],
});
