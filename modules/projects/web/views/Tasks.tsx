import { useMemo, useState } from 'react';
import { api } from '@web/lib/api';
import { useApi, useAction } from '@web/lib/query';
import { relDay } from '@web/lib/format';
import { Section, Group, Item, Button, IconButton, Input, Select, Check, Tag, Empty, toast } from '@web/ui';
import { ErrorLine, useSend, type Task } from '../shared';

interface TaskData { link: { type: 'project' | 'label'; id?: string; name?: string } | null; sections: { id: string; name: string }[]; tasks: Task[] }
const EST = [15, 30, 45, 60, 90, 120, 180];

function TaskRow({ t, projectId, depth }: { t: Task; projectId: string; depth: number }) {
  const close = useAction('post', `/api/todoist/tasks/${t.id}/close`);
  const est = useAction<{ minutes: number | null }>('post', `/api/todoist/tasks/${t.id}/estimate`);
  const meta = useAction<{ owner: string | null }>('patch', `/api/todoist/tasks/${t.id}/meta`);
  const must = useAction<{ on: boolean }>('post', `/api/projects/${projectId}/tasks/${t.id}/must-do`);
  const isMust = !!t.meta.mustDoDate;
  const options = t.estimateMin && !EST.includes(t.estimateMin) ? [...EST, t.estimateMin].sort((a, b) => a - b) : EST;
  return (
    <Item className="pj-task" style={{ paddingLeft: 12 + depth * 28 }}>
      <Check checked={false} onChange={() => close.mutate({} as any)} label={`Complete ${t.content}`} />
      <div className="title">
        <div>{t.content}</div>
        {(t.due || t.meta.nextAction) && <div className="sub">{t.due ? `${relDay(t.due.date)}${t.due.time ? ` ${t.due.time}` : ''}${t.due.recurring ? ', repeats' : ''}` : ''}{t.due && t.meta.nextAction ? '. ' : ''}{t.meta.nextAction ? `Next: ${t.meta.nextAction}` : ''}</div>}
      </div>
      {t.meta.carryCount > 0 && <Tag tone={t.meta.carryCount >= 2 ? 'amber' : undefined}>Carried {t.meta.carryCount}×</Tag>}
      <Input className="bare pj-owner" defaultValue={t.meta.owner ?? ''} placeholder="Owner" aria-label={`Owner of ${t.content}`} key={t.meta.owner ?? ''}
        onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (t.meta.owner ?? null)) meta.mutate({ owner: v }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <Select className="pj-est" value={t.estimateMin ?? ''} aria-label={`Estimate for ${t.content}`} onChange={(e) => est.mutate({ minutes: e.target.value ? Number(e.target.value) : null })}>
        <option value="">No estimate</option>
        {options.map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
      </Select>
      <IconButton icon="Star" label={isMust ? 'Remove from must-dos' : 'Make a must-do'} aria-pressed={isMust} className={isMust ? 'pj-on' : ''} onClick={() => must.mutate({ on: !isMust })} />
    </Item>
  );
}

export function TasksView({ id, hasLink, goOverview }: { id: string; hasLink: boolean; goOverview: () => void }) {
  const q = useApi<TaskData>(`/api/projects/${id}/tasks`);
  const { busy, error, run } = useSend();
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [section, setSection] = useState('');
  const d = q.data;
  const groups = useMemo(() => {
    if (!d) return [];
    const ids = new Set(d.tasks.map((t) => t.id));
    const kids = new Map<string, Task[]>();
    for (const t of d.tasks) if (t.parentId && ids.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    const tops = d.tasks.filter((t) => !t.parentId || !ids.has(t.parentId));
    const flat = (t: Task, depth: number): { t: Task; depth: number }[] => [{ t, depth }, ...(kids.get(t.id) ?? []).flatMap((c) => flat(c, depth + 1))];
    const key = (t: Task) => (d.link?.type === 'project' ? t.sectionId ?? '' : t.projectName);
    const names = d.link?.type === 'project' ? [{ id: '', name: 'No section' }, ...d.sections] : [...new Set(tops.map(key))].map((n) => ({ id: n, name: n || 'Tasks' }));
    return names.map((s) => ({ ...s, rows: tops.filter((t) => key(t) === s.id).flatMap((t) => flat(t, 0)) })).filter((g) => g.rows.length);
  }, [d]);
  if (!hasLink) return <Section><Group><Empty action={<Button onClick={goOverview}>Link Todoist…</Button>}>Link a Todoist project or label on the Overview to see its tasks here.</Empty></Group></Section>;
  const add = async () => {
    if (!text.trim()) return;
    const ok = await run(() => api.post(`/api/projects/${id}/tasks`, { content: text, ...(section ? { sectionId: section } : {}), ...(due.trim() ? { dueString: due.trim() } : {}) }));
    if (ok) { setText(''); setDue(''); toast('Task added to Todoist.'); }
  };
  return (
    <>
      <Section>
        <Group pad>
          <div className="row">
            <Input className="grow" value={text} placeholder="Add a task" aria-label="New task" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
            <Input style={{ width: 150 }} value={due} placeholder="Due, e.g. friday" aria-label="Due date" onChange={(e) => setDue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
            {d?.link?.type === 'project' && d.sections.length > 0 && (
              <Select aria-label="Section" value={section} onChange={(e) => setSection(e.target.value)}><option value="">No section</option>{d.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            )}
            <Button variant="primary" disabled={busy || !text.trim()} onClick={add}>Add Task</Button>
          </div>
          <ErrorLine error={error} />
        </Group>
      </Section>
      {groups.map((g) => (
        <Section key={g.id} title={g.name} end={<span className="small muted num">{g.rows.length}</span>}>
          <Group>{g.rows.map(({ t, depth }) => <TaskRow key={t.id} t={t} projectId={id} depth={depth} />)}</Group>
        </Section>
      ))}
      {d && !groups.length && <Section><Group><Empty>No open tasks.</Empty></Group></Section>}
    </>
  );
}
