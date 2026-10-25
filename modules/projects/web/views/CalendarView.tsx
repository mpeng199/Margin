import { useState } from 'react';
import { useApi, } from '@web/lib/query';
import { fmtTimeShort } from '@web/lib/format';
import { todayISO } from '@web/lib/format';
import { addDays, weekStartOf } from '@core/time';
import { DateTime } from 'luxon';
import { Group, Section, Segmented, Button, Toggle, IconButton, Banner, Spinner } from '@web/ui';
import type { CalEvent } from '../../../google/manifest';
import type { Detail } from '../shared';

interface CalData { events: CalEvent[]; overlay: CalEvent[]; tasks: { id: string; content: string; date: string; time: string | null }[]; calendarId: string | null }
interface Cell { key: string; label: string; time?: string; faint?: boolean; kind: 'event' | 'allday' | 'task'; color?: string }

const daysOf = (e: CalEvent): string[] => {
  const s = e.start.slice(0, 10);
  if (!e.allDay) return [s];
  const last = addDays(e.end.slice(0, 10), -1);
  const out: string[] = [];
  for (let d = s, n = 0; d <= last && n < 62; d = addDays(d, 1), n++) out.push(d);
  return out.length ? out : [s];
};
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => DateTime.fromISO(monthStart(d), { zone: 'UTC' }).plus({ months: n }).toISODate()!;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarView({ id, project }: { id: string; project: Detail }) {
  const [view, setView] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(todayISO());
  const [overlay, setOverlay] = useState(false);
  const ws = useApi<{ weekStart?: number }>('/api/settings/day').data?.weekStart ?? 7;
  const today = todayISO();
  const first = view === 'month' ? weekStartOf(monthStart(anchor), ws) : weekStartOf(anchor, ws);
  const count = view === 'month' ? 42 : 7;
  const end = addDays(first, count);
  const q = useApi<CalData>(`/api/projects/${id}/calendar?start=${first}&end=${end}${overlay ? '&overlay=1' : ''}`);
  const d = q.data;
  const cells = new Map<string, Cell[]>();
  const put = (date: string, c: Cell) => cells.set(date, [...(cells.get(date) ?? []), c]);
  for (const e of d?.events ?? []) for (const day of daysOf(e)) put(day, { key: `e${e.id}${day}`, label: e.title, time: e.allDay ? undefined : fmtTimeShort(e.start), kind: e.allDay ? 'allday' : 'event' });
  for (const t of d?.tasks ?? []) put(t.date, { key: `t${t.id}`, label: t.content, time: t.time ?? undefined, kind: 'task' });
  for (const e of d?.overlay ?? []) for (const day of daysOf(e)) put(day, { key: `o${e.id}${day}`, label: e.title, time: e.allDay ? undefined : fmtTimeShort(e.start), kind: e.allDay ? 'allday' : 'event', faint: true, color: e.color ?? undefined });
  const sortCells = (l: Cell[]) => [...l].sort((a, b) => Number(!!a.faint) - Number(!!b.faint) || Number(a.kind !== 'allday') - Number(b.kind !== 'allday') || (a.time ?? '').localeCompare(b.time ?? ''));
  const step = (n: number) => setAnchor(view === 'month' ? addMonths(anchor, n) : addDays(anchor, 7 * n));
  const title = view === 'month' ? DateTime.fromISO(anchor, { zone: 'UTC' }).toFormat('MMMM yyyy') : `${DateTime.fromISO(first, { zone: 'UTC' }).toFormat('MMM d')} to ${DateTime.fromISO(addDays(first, 6), { zone: 'UTC' }).toFormat('MMM d, yyyy')}`;
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  const cap = view === 'month' ? 3 : 99;
  return (
    <>
      <div className="pj-tl-bar">
        <IconButton icon="ChevronLeft" label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)} />
        <strong className="pj-cal-title">{title}</strong>
        <IconButton icon="ChevronRight" label={view === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)} />
        <Button onClick={() => setAnchor(today)}>Today</Button>
        <div className="grow" />
        <label className="row small"><Toggle checked={overlay} onChange={setOverlay} label="Show my main calendar" /> Show my main calendar</label>
        <Segmented label="Calendar view" value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
      </div>
      {d && !d.calendarId && <Banner icon="Info">This project has no calendar of its own. Dated tasks still show here; link a calendar from the Overview to see events.</Banner>}
      <Section>
        <Group>
          <div className="pj-cal" data-view={view} role="grid" aria-label={title}>
            {Array.from({ length: 7 }, (_, i) => <div key={i} className="pj-cal-dow" role="columnheader">{WEEKDAYS[(ws % 7 + i) % 7]}</div>)}
            {days.map((day) => {
              const list = sortCells(cells.get(day) ?? []);
              const inMonth = view === 'week' || day.slice(0, 7) === anchor.slice(0, 7);
              return (
                <div key={day} className="pj-cal-day" role="gridcell" data-today={day === today} data-out={!inMonth} aria-label={day}>
                  <button type="button" className="pj-cal-num" onClick={() => { setAnchor(day); setView('week'); }} aria-label={`Open the week of ${day}`}>{Number(day.slice(8))}</button>
                  {list.slice(0, cap).map((c) => (
                    <div key={c.key} className="pj-cal-item" data-kind={c.kind} data-faint={!!c.faint} title={c.label} style={c.color ? ({ '--c': c.color } as React.CSSProperties) : undefined}>
                      {c.time && <span className="num">{c.time}</span>}<span className="pj-cal-t">{c.kind === 'task' ? `Task: ${c.label}` : c.label}</span>
                    </div>
                  ))}
                  {list.length > cap && <button type="button" className="pj-cal-more" onClick={() => { setAnchor(day); setView('week'); }}>{list.length - cap} more</button>}
                </div>
              );
            })}
          </div>
        </Group>
      </Section>
      {q.isLoading && <div className="empty"><Spinner /></div>}
      <p className="why-line">Only this project’s events and dated tasks. {overlay ? 'Your main calendar is shown faintly.' : 'Your main calendar is hidden.'}</p>
    </>
  );
}
