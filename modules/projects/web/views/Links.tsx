import { useState } from 'react';
import { api } from '@web/lib/api';
import { useApi } from '@web/lib/query';
import { Section, Group, Item, Button, Sheet, Field, Select, Input, Segmented, Banner, Icon, Tag, toast } from '@web/ui';
import { ErrorLine, useSend, type Project } from '../shared';

interface TdOptions { planLimited: boolean; maxProjects: number | null; projects: { id: string; name: string; taken: boolean }[]; labels: { id: string; name: string; taken: boolean }[]; suggestedLabel: string }
interface CalOptions { connected: boolean; calendarId: string | null; name: string; calendars: { id: string; summary: string; color: string; taken: boolean }[] }

function TodoistSheet({ p, onClose }: { p: Project; onClose: () => void }) {
  const opt = useApi<TdOptions>(`/api/projects/${p.id}/todoist-options`);
  const { busy, error, run } = useSend();
  const o = opt.data;
  const [mode, setMode] = useState<'project' | 'label' | 'create' | 'unlink'>(p.todoist?.type === 'label' ? 'label' : 'project');
  const [projectId, setProjectId] = useState(p.todoist?.type === 'project' ? p.todoist.id ?? '' : '');
  const [label, setLabel] = useState(p.todoist?.type === 'label' ? p.todoist.name ?? '' : '');
  const go = async () => {
    const body = mode === 'project' ? { mode, projectId } : mode === 'label' ? { mode, name: label.trim() || o?.suggestedLabel } : mode === 'create' ? { mode, confirm: true } : { mode };
    const out = await run(() => api.post(`/api/projects/${p.id}/todoist`, body));
    if (out) { toast(mode === 'unlink' ? 'Unlinked from Todoist. Nothing was deleted.' : 'Todoist link saved.'); onClose(); }
  };
  return (
    <Sheet open onClose={onClose} title="Todoist Link" subtitle="Tasks stay in Todoist; this tab shows the ones in the linked project or label."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || (mode === 'project' && !projectId) || (mode === 'create' && !!o?.planLimited)} onClick={go}>{mode === 'unlink' ? 'Unlink' : 'Save Link'}</Button></>}>
      <div className="stack">
        <Segmented label="Link type" value={mode} onChange={setMode} options={[{ value: 'project', label: 'Existing Project' }, { value: 'create', label: 'New Project' }, { value: 'label', label: 'Label' }, ...(p.todoist ? [{ value: 'unlink' as const, label: 'Unlink' }] : [])]} />
        {mode === 'project' && (
          <Field label="Todoist project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Choose a project</option>
              {(o?.projects ?? []).map((x) => <option key={x.id} value={x.id} disabled={x.taken}>{x.name}{x.taken ? ' (linked to another tab)' : ''}</option>)}
            </Select>
          </Field>
        )}
        {mode === 'label' && (
          <Field label="Label" hint="Created in Todoist if it doesn’t exist.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={o?.suggestedLabel} list="pj-link-labels" />
            <datalist id="pj-link-labels">{(o?.labels ?? []).filter((l) => !l.taken).map((l) => <option key={l.id} value={l.name} />)}</datalist>
          </Field>
        )}
        {mode === 'create' && (o?.planLimited
          ? <Banner tone="amber" icon="Info">Your Todoist plan allows {o.maxProjects} active projects and all are in use. Use a label instead: tasks still live in Todoist and the tab shows them the same way.</Banner>
          : <p className="small muted">Creates an empty Todoist project named “{p.name}” and links this tab to it.</p>)}
        {mode === 'unlink' && <p className="small muted">The tab stops showing tasks. Nothing in Todoist is changed or deleted.</p>}
        <ErrorLine error={error} />
      </div>
    </Sheet>
  );
}

function CalendarSheet({ p, onClose }: { p: Project; onClose: () => void }) {
  const opt = useApi<CalOptions>(`/api/projects/${p.id}/calendar-options`);
  const { busy, error, run } = useSend();
  const [calendarId, setCalendarId] = useState('');
  const o = opt.data;
  const done = (msg: string) => { toast(msg); onClose(); };
  return (
    <Sheet open onClose={onClose} title="Google Calendar" subtitle="Each project can have its own calendar, so its dates stay off your main one unless you choose."
      footer={<><Button onClick={onClose}>Cancel</Button><Button disabled={busy || !calendarId} onClick={async () => { if (await run(() => api.post(`/api/projects/${p.id}/calendar-link`, { mode: 'link', calendarId }))) done('Calendar linked.'); }}>Link Selected</Button>
        <Button variant="primary" disabled={busy || o?.connected === false} onClick={async () => { if (await run(() => api.post(`/api/projects/${p.id}/calendar-link`, { mode: 'create' }))) done(`Created “${o?.name ?? 'the calendar'}”.`); }}>Create “{o?.name ?? p.name}”</Button></>}>
      <div className="stack">
        {o?.connected === false && <Banner tone="amber" icon="Info">Google Calendar isn’t connected. Connect it in Settings first.</Banner>}
        <Field label="Or link an existing calendar">
          <Select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
            <option value="">Choose a calendar</option>
            {(o?.calendars ?? []).map((c) => <option key={c.id} value={c.id} disabled={c.taken}>{c.summary}{c.taken ? ' (belongs to another tab)' : ''}</option>)}
          </Select>
        </Field>
        <ErrorLine error={error} />
      </div>
    </Sheet>
  );
}

const tdUrl = (p: Project) => (p.todoist?.type === 'project' && p.todoist.id ? `https://app.todoist.com/app/project/${p.todoist.id}` : p.todoist?.type === 'label' && p.todoist.id ? `https://app.todoist.com/app/label/${p.todoist.id}` : null);

export function Links({ p }: { p: Project }) {
  const [sheet, setSheet] = useState<'todoist' | 'calendar' | null>(null);
  const cal = useApi<CalOptions>(`/api/projects/${p.id}/calendar-options`);
  const url = tdUrl(p);
  return (
    <Section title="Links">
      <Group>
        <Item>
          <Icon name="ListChecks" />
          <div className="title">Todoist<div className="sub">{p.todoist ? `${p.todoist.type === 'project' ? 'Project' : 'Label'}: ${p.todoist.name ?? p.todoist.id}` : 'Not linked. Tasks appear here once you link a project or label.'}</div></div>
          {url && <a className="btn plain" href={url} target="_blank" rel="noreferrer">Open in Todoist</a>}
          <Button onClick={() => setSheet('todoist')}>{p.todoist ? 'Change…' : 'Link…'}</Button>
        </Item>
        <Item>
          <Icon name="CalendarDays" />
          <div className="title">Google Calendar<div className="sub">{p.calendarId ? cal.data?.name ?? 'Linked' : 'No calendar. Dates stay in Margin only.'}</div></div>
          {p.calendarId ? <a className="btn plain" href="https://calendar.google.com/calendar/r" target="_blank" rel="noreferrer">Open Google Calendar</a> : <Tag>Local only</Tag>}
          <Button onClick={() => setSheet('calendar')}>{p.calendarId ? 'Change…' : 'Link…'}</Button>
        </Item>
      </Group>
      {sheet === 'todoist' && <TodoistSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'calendar' && <CalendarSheet p={p} onClose={() => setSheet(null)} />}
    </Section>
  );
}
