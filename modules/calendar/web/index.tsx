import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { DateTime } from 'luxon';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { useNow, useSettings, isTyping } from '@web/lib/hooks';
import { Button, IconButton, Segmented, Sheet, Tag, Toggle, Banner, Group, Item, Why, CapacityBar } from '@web/ui';
import { dt, fmtTime, fmtTimeShort, fmtDur, todayISO, ZONE } from '@web/lib/format';
import { addDays, weekStartOf, type ISODate } from '../../../src/core/time';
import { GRID_START_MIN, layoutDay, monthGrid, shiftMonth, weekDates, yPx } from '../layout';
import type { CalItem, RangeDay, RangeResult } from '../manifest';
import './calendar.css';

const HOUR_PX = 48;
const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 6 AM .. 11 PM
type View = 'week' | 'month';
type Picked = { item: CalItem; date: ISODate };
interface GCal { id: string; summary: string; color: string | null; hidden: boolean; primary: boolean }

const d = (iso: ISODate) => DateTime.fromISO(iso, { zone: ZONE });
const hourLabel = (h: number) => (h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`);
/** Only pass through values that are safe to put in a CSS custom property. */
const cssColor = (c: string | null | undefined) => (c && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i.test(c.trim()) ? c.trim() : undefined);
const colorOf = (i: CalItem) => (i.source === 'fixed' ? undefined : cssColor(i.projectColor) ?? cssColor(i.color));

function capacityText(day: RangeDay, planOn: boolean) {
  const c = day.capacity;
  if (c.status === 'none') return { text: 'No capacity', amber: true };
  if (c.status === 'over') return { text: `Over by ${fmtDur(c.overByMin)}`, amber: true };
  return { text: planOn ? `${fmtDur(c.freeMin)} free · ${fmtDur(c.loadMin)} planned` : `${fmtDur(c.freeMin)} free`, amber: false };
}

function rangeLabel(view: View, anchor: ISODate, weekStart: number) {
  if (view === 'month') return d(anchor).toFormat('MMMM yyyy');
  const days = weekDates(anchor, weekStart);
  const a = d(days[0]), b = d(days[6]);
  return a.month === b.month ? `${a.toFormat('MMM d')} – ${b.toFormat('d, yyyy')}` : `${a.toFormat('MMM d')} – ${b.toFormat('MMM d, yyyy')}`;
}

function itemTime(i: CalItem) {
  if (i.allDay) {
    const last = d(i.end.slice(0, 10)).minus({ days: 1 });
    const first = d(i.start.slice(0, 10));
    return last > first ? `All day · ${first.toFormat('EEE, MMM d')} – ${last.toFormat('EEE, MMM d')}` : `All day · ${first.toFormat('EEE, MMM d')}`;
  }
  return `${dt(i.start).toFormat('EEE, MMM d')} · ${fmtTimeShort(i.start)}–${fmtTime(i.end)}`;
}

/* ------------------------------------------------------------------ Calendar visibility */
function CalendarsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cals = useApi<GCal[]>(open ? '/api/google/calendars' : null);
  const save = useAction<{ hiddenCalendars: string[] }>('patch', '/api/settings/google');
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const list = cals.data ?? [];
  const toggle = (c: GCal, show: boolean) => {
    const hidden = list.filter((x) => x.hidden && x.id !== c.id).map((x) => x.id);
    save.mutate({ hiddenCalendars: show ? hidden : [...hidden, c.id] });
  };
  return (
    <div className="cal-menu" ref={ref}>
      <Button icon="Layers" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">Calendars</Button>
      {open && (
        <div className="cal-pop" role="dialog" aria-label="Calendar visibility">
          <div className="cal-pop-head">Show on this calendar</div>
          {cals.isError ? <div className="empty small">Google Calendar is turned off. Turn it on in Settings to choose calendars.</div>
            : cals.isLoading ? <div className="empty small">Loading calendars…</div>
            : !list.length ? <div className="empty small">No calendars yet. Connect Google Calendar in Settings.</div>
            : list.map((c) => (
              <div className="cal-pop-row" key={c.id}>
                <span className="cal-swatch" style={{ background: cssColor(c.color) ?? 'var(--ink-3)' }} />
                <span className="grow ellipsis" title={c.summary}>{c.summary}</span>
                <Toggle checked={!c.hidden} onChange={(v) => toggle(c, v)} label={`Show ${c.summary}`} />
              </div>
            ))}
          <div className="cal-pop-foot">Hidden calendars are left out of Today, capacity, and this screen.</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Event sheet */
function EventSheet({ picked, onClose }: { picked: Picked | null; onClose: () => void }) {
  const i = picked?.item;
  return (
    <Sheet open={!!i} onClose={onClose} title={i?.title ?? ''} subtitle={i ? itemTime(i) : undefined}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        {i?.htmlLink && <Button variant="primary" icon="ExternalLink" onClick={() => window.open(i.htmlLink!, '_blank', 'noopener')}>Open in Google Calendar</Button>}
      </>}>
      {i && (
        <>
          <Group>
            <Item><div className="title">Calendar</div><span className="meta">{i.source === 'fixed' ? 'Fixed block' : i.calendarName ?? 'Unknown'}</span></Item>
            {i.projectName && <Item><div className="title">Project</div><span className="meta">{i.projectName}</span></Item>}
            {i.source === 'block' && <Item><div className="title">Type</div><span className="meta">Time block made by Margin</span></Item>}
            {!i.busy && <Item><div className="title">Availability</div><span className="meta">Shown as free</span></Item>}
          </Group>
          <p className="small muted" style={{ marginTop: 10 }}>
            {i.source === 'fixed' ? 'Fixed blocks are edited in Settings, under Day.' : 'Read-only here. Edit it in Google Calendar.'}
          </p>
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ Week view */
function EventChip({ item, onPick, className = 'cal-chip' }: { item: CalItem; onPick: () => void; className?: string }) {
  return (
    <button type="button" className={className} data-source={item.source} data-free={!item.busy || undefined} style={{ ['--c' as any]: colorOf(item) }} onClick={onPick}
      title={`${item.title} · ${item.allDay ? 'All day' : `${fmtTimeShort(item.start)}–${fmtTime(item.end)}`}`}>
      {!item.allDay && className === 'cal-chip' && <span className="cal-chip-time num">{fmtTimeShort(item.start)}</span>}
      <span className="ellipsis">{item.title}</span>
    </button>
  );
}

function WeekView({ days, sources, today, onPick }: { days: RangeDay[]; sources: RangeResult['sources']; today: ISODate; onPick: (p: Picked) => void }) {
  const now = useNow(30_000);
  const nowDt = DateTime.fromMillis(now, { zone: ZONE });
  const nowMin = nowDt.hour * 60 + nowDt.minute;
  const scroller = useRef<HTMLDivElement>(null);
  const layouts = useMemo(() => days.map((day) => layoutDay(day.date, day.items, day.anchors.effectiveStop)), [days]);
  const first = days[0]?.date;
  useEffect(() => {
    // Open near the morning, or an hour before now when this week contains today.
    const target = days.some((x) => x.date === today) ? Math.max(GRID_START_MIN, nowMin - 60) : 7 * 60;
    if (scroller.current) scroller.current.scrollTop = yPx(target, HOUR_PX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);
  const planOn = sources.plan;
  return (
    <div className="cal-scroll" ref={scroller} style={{ ['--hour-px' as any]: `${HOUR_PX}px` }}>
      <div className="cal-sticky">
        <div className="cal-cols cal-head">
          <div />
          {days.map((day) => {
            const t = d(day.date);
            const cap = capacityText(day, planOn);
            return (
              <div key={day.date} className={`cal-dayhead ${day.date === today ? 'is-today' : ''}`}>
                <div className="row between">
                  <div className="cal-daylink" aria-label={t.toFormat('cccc, MMMM d')}>
                    <span className="cal-dow">{t.toFormat('ccc')}</span>
                    <span className="cal-dom num" data-today={day.date === today || undefined}>{t.day}</span>
                  </div>
                  {day.lengthMin !== 1440 && <Tag tone="dusk"><span title={`Clocks change this day. It has ${day.lengthMin / 60} hours.`}>{day.lengthMin / 60} h day</span></Tag>}
                </div>
                {planOn && <CapacityBar compact loadMin={day.capacity.loadMin} freeMin={day.capacity.freeMin} />}
                <div className={`cal-cap tiny num ${cap.amber ? 'amber' : 'muted'}`}>{cap.text}</div>
              </div>
            );
          })}
        </div>
        <div className="cal-cols cal-allday">
          <div className="cal-gutter tiny faint">All day</div>
          {layouts.map((l) => (
            <div key={l.date} className={`cal-allcell ${l.date === today ? 'is-today' : ''}`}>
              {l.allDay.map((it) => <EventChip key={it.id} item={it} className="cal-chip all" onPick={() => onPick({ item: it, date: l.date })} />)}
              {l.before.length > 0 && <div className="tiny faint" title={l.before.map((b) => b.title).join(', ')}>{l.before.length} before 6 AM</div>}
            </div>
          ))}
        </div>
      </div>
      <div className="cal-cols cal-body" style={{ height: HOURS.length * HOUR_PX }}>
        <div className="cal-gutter">
          {HOURS.map((h, i) => <span key={h} className="cal-hour tiny faint num" style={{ top: i * HOUR_PX - (i === 0 ? 0 : 6) }}>{hourLabel(h)}</span>)}
        </div>
        {layouts.map((l, di) => {
          const stopIso = days[di].anchors.effectiveStop;
          const isToday = l.date === today;
          return (
            <div key={l.date} className={`cal-col ${isToday ? 'is-today' : ''}`} role="group" aria-label={d(l.date).toFormat('cccc, MMMM d')}>
              {l.stopMin !== null && (
                <>
                  <div className="cal-dusk" style={{ top: yPx(l.stopMin, HOUR_PX) }} aria-hidden="true" />
                  <div className="cal-stop" style={{ top: yPx(l.stopMin, HOUR_PX) }} title={`Hard stop ${fmtTime(stopIso)}`}>
                    <span className="cal-stop-label tiny num">Stop {fmtTimeShort(stopIso)}</span>
                  </div>
                </>
              )}
              {l.placed.map((p) => {
                const h = ((p.bottom - p.top) * HOUR_PX) / 60;
                return (
                  <button type="button" key={p.item.id} className="cal-ev" data-source={p.item.source} data-free={!p.item.busy || undefined}
                    style={{ top: yPx(p.top, HOUR_PX), height: h - 1, left: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)`, ['--c' as any]: colorOf(p.item) }}
                    onClick={() => onPick({ item: p.item, date: l.date })}
                    aria-label={`${p.item.title}, ${fmtTimeShort(p.item.start)} to ${fmtTime(p.item.end)}`}>
                    <span className="cal-ev-title">{p.item.title}</span>
                    {h >= 38 && <span className="cal-ev-time tiny num">{fmtTimeShort(p.item.start)}–{fmtTime(p.item.end)}</span>}
                  </button>
                );
              })}
              {isToday && nowMin >= GRID_START_MIN && <div className="cal-now" style={{ top: yPx(nowMin, HOUR_PX) }} aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Month view */
function MonthView({ days, monthKey, weekStart, sources, today, onPick, onOpenDay }: { days: RangeDay[]; monthKey: string; weekStart: number; sources: RangeResult['sources']; today: ISODate; onPick: (p: Picked) => void; onOpenDay: (date: ISODate) => void }) {
  const head = weekDates(days[0]?.date ?? today, weekStart);
  return (
    <div className="cal-month">
      <div className="cal-month-head">{head.map((x) => <div key={x} className="tiny muted">{d(x).toFormat('ccc')}</div>)}</div>
      <div className="cal-month-grid" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(96px, 1fr))` }}>
        {days.map((day) => {
          const t = d(day.date);
          const items = day.items;
          const shown = items.slice(0, 3);
          const more = items.length - shown.length;
          const cap = capacityText(day, sources.plan);
          return (
            <div key={day.date} className="cal-mcell" data-out={!day.date.startsWith(monthKey) || undefined} data-today={day.date === today || undefined}>
              <div className="row between">
                <button type="button" className="cal-mnum num" data-today={day.date === today || undefined} onClick={() => onOpenDay(day.date)}
                  aria-label={`${t.toFormat('cccc, MMMM d')}, open week`}>{t.day === 1 ? t.toFormat('MMM d') : t.day}</button>
                <span className="cal-dot" data-tone={cap.amber ? 'amber' : 'ok'} role="img" aria-label={cap.text} title={cap.text} />
              </div>
              {shown.map((it) => <EventChip key={it.id} item={it} onPick={() => onPick({ item: it, date: day.date })} />)}
              {more > 0 && <button type="button" className="cal-more tiny" onClick={() => onOpenDay(day.date)}>+{more} more</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Page */
function CalendarPage() {
  const search = useSearch();
  const settings = useSettings<{ weekStart: number }>('day');
  const weekStart = settings.data?.weekStart ?? 7;
  const [view, setView] = useState<View>(() => (new URLSearchParams(search).get('view') === 'month' ? 'month' : 'week'));
  const [anchor, setAnchor] = useState<ISODate>(todayISO());
  const [picked, setPicked] = useState<Picked | null>(null);
  const today = todayISO();

  const grid = view === 'month' ? monthGrid(anchor, weekStart) : null;
  const start = grid ? grid.start : weekStartOf(anchor, weekStart);
  const n = grid ? grid.days.length : 7;
  const range = useApi<RangeResult>(`/api/calendar/range?start=${start}&days=${n}`, { placeholderData: (prev: any) => (prev && prev.days.length === n ? prev : undefined) });
  const data = range.data;
  const stale = range.isFetching && range.isPlaceholderData;

  const step = (dir: -1 | 1) => setAnchor((a) => (view === 'month' ? shiftMonth(a, dir) : addDays(a, dir * 7)));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || picked || document.querySelector('.overlay')) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft') step(-1);
      else if (k === 'arrowright') step(1);
      else if (k === 't') setAnchor(todayISO());
      else if (k === 'w') setView('week');
      else if (k === 'm') setView('month');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const empty = !!data && data.days.every((x) => x.items.length === 0);
  const unit = view === 'month' ? 'month' : 'week';
  return (
    <Page title="Calendar" subtitle={rangeLabel(view, anchor, weekStart)} width="full"
      actions={<>
        <CalendarsMenu />
        <Segmented label="Calendar view" value={view} onChange={setView} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
        <IconButton icon="ChevronLeft" label={`Previous ${unit}`} onClick={() => step(-1)} />
        <Button onClick={() => setAnchor(todayISO())} kbd="T">Today</Button>
        <IconButton icon="ChevronRight" label={`Next ${unit}`} onClick={() => step(1)} />
      </>}>
      {data && !data.sources.google && (
        <Banner icon="Info">Google Calendar is turned off, so only your fixed blocks appear here. Turn it on in Settings to see events.</Banner>
      )}
      <div className="cal-wrap" data-stale={stale || undefined}>
        {!data ? <div className="empty">Loading the calendar…</div>
          : view === 'week'
            ? <WeekView days={data.days} sources={data.sources} today={today} onPick={setPicked} />
            : <MonthView days={data.days} monthKey={grid!.month} weekStart={weekStart} sources={data.sources} today={today} onPick={setPicked}
                onOpenDay={(date) => { setAnchor(date); setView('week'); }} />}
      </div>
      {empty && data?.sources.google && <p className="small muted" style={{ marginTop: 10 }}>Nothing on your visible calendars in this {unit}.</p>}
      <div className="cal-legend small">
        <span className="cal-legend-dusk" aria-hidden="true" />
        <Why source="Bennett 2018">The shaded evening starts at each day’s hard stop. Detaching after hours has the strongest link to lower fatigue.</Why>
      </div>
      <div className="cal-legend small">
        <Why>Work sessions and meetings always show here so planning stays honest. Milestones and deadlines follow each project’s separation setting.</Why>
      </div>
      <EventSheet picked={picked} onClose={() => setPicked(null)} />
    </Page>
  );
}

export default defineWebModule({
  id: 'calendar',
  routes: [{ path: '/calendar', component: CalendarPage, work: true }],
  commands: [
    { id: 'calendar.open', label: 'Open calendar', group: 'Go', shortcut: '⌘2', run: () => '/calendar' },
    { id: 'calendar.month', label: 'Open calendar in month view', group: 'Go', run: () => '/calendar?view=month' },
  ],
});
