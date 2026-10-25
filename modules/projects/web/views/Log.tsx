import { useState } from 'react';
import { useApi } from '@web/lib/query';
import { fmtDay, fmtDur, fmtTimeShort, todayISO } from '@web/lib/format';
import { addDays } from '@core/time';
import { Section, Group, Item, Select, Empty } from '@web/ui';
import { STATUS_LABEL, type StatusChange } from '../shared';

interface LogData {
  completions: { taskId: string; content: string; completedAt: string; date: string }[];
  timeLogs: { taskId: string; start: string; end: string; minutes: number; taskName: string | null }[];
  timeMin: number;
  statusLog: StatusChange[];
}

export function LogView({ id }: { id: string }) {
  const [days, setDays] = useState(30);
  const to = todayISO(), from = addDays(to, -days);
  const q = useApi<LogData>(`/api/projects/${id}/log?from=${from}&to=${to}`);
  const d = q.data;
  const statusIn = (d?.statusLog ?? []).filter((s) => s.at.slice(0, 10) >= from);
  return (
    <>
      <div className="pj-tl-bar">
        <span className="muted small">What actually happened, from the Todoist history and the focus timer.</span>
        <div className="grow" />
        <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></Select>
      </div>
      <Section title="Summary">
        <Group>
          <Item><div className="title">Tasks completed</div><span className="meta num">{d?.completions.length ?? 0}</span></Item>
          <Item><div className="title">Time spent</div><span className="meta num">{fmtDur(d?.timeMin ?? 0)}</span></Item>
        </Group>
      </Section>
      <Section title="Completed">
        <Group>
          {d?.completions.length ? [...d.completions].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map((c) => (
            <Item key={`${c.taskId}${c.completedAt}`}><div className="title">{c.content}</div><span className="meta">{fmtDay(c.date)}</span></Item>
          )) : <Empty>No completions in this period.</Empty>}
        </Group>
      </Section>
      <Section title="Time spent">
        <Group>
          {d?.timeLogs.length ? [...d.timeLogs].sort((a, b) => b.start.localeCompare(a.start)).map((l) => (
            <Item key={`${l.taskId}${l.start}`}><div className="title">{l.taskName ?? 'Focus session'}<div className="sub">{fmtDay(l.start.slice(0, 10))}, {fmtTimeShort(l.start)} to {fmtTimeShort(l.end)}</div></div><span className="meta num">{fmtDur(l.minutes)}</span></Item>
          )) : <Empty>No time logged in this period.</Empty>}
        </Group>
      </Section>
      <Section title="Status changes">
        <Group>
          {statusIn.length ? statusIn.map((s) => (
            <Item key={s.id}><div className="title">{s.from ? `${STATUS_LABEL[s.from]} to ${STATUS_LABEL[s.to]}` : `Created as ${STATUS_LABEL[s.to]}`}{s.note && <div className="sub">{s.note}</div>}</div><span className="meta">{fmtDay(s.at.slice(0, 10))}</span></Item>
          )) : <Empty>No status changes in this period.</Empty>}
        </Group>
      </Section>
    </>
  );
}
