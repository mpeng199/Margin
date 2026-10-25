import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@web/lib/api';
import { useApi } from '@web/lib/query';
import { fmtDay, fmtDur, dt, todayISO } from '@web/lib/format';
import { addDays, daysBetween } from '@core/time';
import { Group, Item, Button, Sheet, Field, Input, Segmented, Icon, Banner, Spinner, toast } from '@web/ui';
import { PX_PER_DAY, ZOOMS, dragDays, extent, packLanes, ticks, widthOf, xOf, type Zoom } from '../../timeline';
import { ErrorLine, useSend, type Detail, type Milestone, type Phase, type PlanPreview } from '../shared';

const css = (o: Record<string, string | number | undefined>) => o as React.CSSProperties;

interface TL {
  today: string; phases: Phase[]; milestones: Milestone[];
  sessions: { id: string; title: string; start: string; end: string; source: 'focus' | 'calendar' }[];
  tasks: { id: string; content: string; date: string; recurring: boolean; priority: number }[];
}
type Op = Record<string, unknown>;
interface Sel { key: string; kind: 'phase' | 'milestone' | 'task'; id: string; title: string; start: string; end: string; deadline?: boolean; done?: boolean }

const MIN_DAYS: Record<Zoom, number> = { week: 70, month: 180, quarter: 365, semester: 540 };
const LANE = 26, HEAD = 32, PAD = 8;
const KIND_LABEL = { phase: 'Phase', milestone: 'Milestone', task: 'Task' } as const;
const maxDate = (a: string, b: string) => (a > b ? a : b);

/** Preview a timeline write, then apply it as one change set. The server computes both; this sheet only shows and confirms. */
function PlanSheet({ projectId, op, confirmLabel = 'Apply', onClose }: { projectId: string; op: Op | null; confirmLabel?: string; onClose: () => void }) {
  const [plan, setPlan] = useState<PlanPreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const { busy, error, run } = useSend();
  useEffect(() => {
    setPlan(null); setLoadErr(null);
    if (!op) return;
    let live = true;
    api.post<{ preview: PlanPreview }>(`/api/projects/${projectId}/schedule`, op).then((r) => live && setPlan(r.preview)).catch((e) => live && setLoadErr(e.message));
    return () => { live = false; };
  }, [op, projectId]);
  if (!op) return null;
  const apply = async () => { if (await run(() => api.post(`/api/projects/${projectId}/schedule`, { ...op, confirm: true }))) { toast('Timeline updated.'); onClose(); } };
  return (
    <Sheet open onClose={onClose} title="Review Change" subtitle={plan?.title}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!plan || busy} onClick={apply}>{confirmLabel}</Button></>}>
      <div className="stack">
        {!plan && !loadErr && <div className="row muted"><Spinner /> Preparing the change</div>}
        {loadErr && <p className="pj-err" role="alert">{loadErr}</p>}
        {plan?.summary && <p className="small muted">{plan.summary}</p>}
        {plan && <Group>{plan.changes.map((c, i) => <Item key={i}><Icon name={c.kind.startsWith('gcal') ? 'CalendarDays' : 'Route'} className="faint" /><div className="title">{c.title}</div></Item>)}</Group>}
        {plan?.changes.some((c) => c.kind.startsWith('gcal')) && <p className="small muted">Google Calendar events that Margin created are updated with it. Others are never touched.</p>}
        {plan && <p className="why-line">Applied as one change set, so you can review what changed afterwards.</p>}
        <ErrorLine error={error} />
      </div>
    </Sheet>
  );
}

function AddSheet({ onClose, onReview }: { onClose: () => void; onReview: (op: Op) => void }) {
  const t = todayISO();
  const [kind, setKind] = useState<'milestone' | 'deadline' | 'phase'>('milestone');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(addDays(t, 7));
  const [end, setEnd] = useState(addDays(t, 14));
  const bad = !title.trim() || (kind === 'phase' && end < start);
  return (
    <Sheet open onClose={onClose} title="Add to Timeline"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={bad} onClick={() => onReview(kind === 'phase' ? { op: 'add_phase', title: title.trim(), start, end } : { op: 'add_milestone', title: title.trim(), date: start, kind })}>Review…</Button></>}>
      <div className="stack">
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'milestone', label: 'Milestone' }, { value: 'deadline', label: 'Deadline' }, { value: 'phase', label: 'Phase' }]} />
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !bad) onReview(kind === 'phase' ? { op: 'add_phase', title: title.trim(), start, end } : { op: 'add_milestone', title: title.trim(), date: start, kind }); }} /></Field>
        <div className="form-grid">
          <Field label={kind === 'phase' ? 'Starts' : 'Date'}><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          {kind === 'phase' && <Field label="Ends" hint={end < start ? 'The end must be on or after the start.' : undefined}><Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field>}
        </div>
      </div>
    </Sheet>
  );
}

export function TimelineView({ id, project }: { id: string; project: Detail }) {
  const q = useApi<TL>(`/api/projects/${id}/timeline`);
  const [zoom, setZoom] = useState<Zoom>('month');
  const [selKey, setSelKey] = useState<string | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [opLabel, setOpLabel] = useState('Move');
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<{ key: string; days: number } | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const px = PX_PER_DAY[zoom];
  const d = q.data;
  const today = d?.today ?? todayISO();
  const color = project.color;

  const model = useMemo(() => {
    if (!d) return null;
    const phases: Sel[] = d.phases.map((p) => ({ key: `p:${p.id}`, kind: 'phase', id: p.id, title: p.title, start: p.start, end: p.end }));
    const miles: Sel[] = d.milestones.map((m) => ({ key: `m:${m.id}`, kind: 'milestone', id: m.id, title: m.title, start: m.date, end: m.date, deadline: m.kind === 'deadline', done: m.done }));
    const tasks: Sel[] = d.tasks.map((t) => ({ key: `t:${t.id}`, kind: 'task', id: t.id, title: t.content, start: t.date, end: t.date }));
    const byDay = new Map<string, { n: number; min: number }>();
    for (const s of d.sessions) {
      const day = s.start.slice(0, 10), cur = byDay.get(day) ?? { n: 0, min: 0 };
      byDay.set(day, { n: cur.n + 1, min: cur.min + Math.max(0, Math.round(dt(s.end).diff(dt(s.start), 'minutes').minutes)) });
    }
    const all = [...phases, ...miles, ...tasks];
    const { origin, days } = extent([...all.flatMap((i) => [i.start, i.end]), ...byDay.keys()], today, MIN_DAYS[zoom]);
    const lblDays = (t: string) => (zoom === 'week' || zoom === 'month' ? Math.ceil((t.length * 6.5 + 26) / px) : 1);
    const pack = (items: Sel[], labels: boolean) => {
      const packed = packLanes(items.map((it) => ({ it, start: it.start, end: labels ? maxDate(it.end, addDays(it.start, lblDays(it.title))) : it.end })));
      return { packed, lanes: Math.max(1, ...packed.map((x) => x.lane + 1)) };
    };
    return { origin, days, all, rows: [{ name: 'Phases', ...pack(phases, false) }, { name: 'Milestones', ...pack(miles, true) }, { name: 'Tasks', ...pack(tasks, true) }], sessions: [...byDay.entries()].sort() };
  }, [d, zoom, px, today]);

  useEffect(() => {
    if (!model || !scroller.current) return;
    scroller.current.scrollLeft = Math.max(0, xOf(model.origin, today, px) - 140);
  }, [!model, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d || !model) return <div className="empty"><Spinner /></div>;
  const sel = model.all.find((i) => i.key === selKey) ?? null;
  const opFor = (it: Sel, n: number): Op => it.kind === 'phase' ? { op: 'move_phase', phaseId: it.id, start: addDays(it.start, n), end: addDays(it.end, n) }
    : it.kind === 'milestone' ? { op: 'move_milestone', milestoneId: it.id, date: addDays(it.start, n) } : { op: 'move_task', taskId: it.id, date: addDays(it.start, n) };
  const review = (o: Op, label = 'Apply') => { setOpLabel(label); setOp(o); };
  const startDrag = (e: React.PointerEvent, it: Sel) => {
    if (e.button !== 0) return;
    setSelKey(it.key);
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => setDrag({ key: it.key, days: dragDays(ev.clientX - x0, px) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const n = dragDays(ev.clientX - x0, px);
      setDrag(null);
      if (n) review(opFor(it, n), 'Move');
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const itemProps = (it: Sel) => ({
    role: 'button', tabIndex: 0, 'data-selected': it.key === selKey, 'data-dragging': drag?.key === it.key,
    'aria-label': `${KIND_LABEL[it.kind]}${it.deadline ? ', deadline' : ''}: ${it.title}, ${fmtDay(it.start)}${it.end !== it.start ? ` to ${fmtDay(it.end)}` : ''}. Left and right arrows move it one day.`,
    onPointerDown: (e: React.PointerEvent) => startDrag(e, it), onFocus: () => setSelKey(it.key),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); review(opFor(it, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1)), 'Move'); }
    },
  });
  const shift = (it: Sel) => (drag?.key === it.key ? { transform: `translateX(${drag.days * px}px)` } : undefined);
  const rowH = model.rows.map((r) => r.lanes * LANE + PAD * 2);
  const width = model.days * px;
  const height = HEAD + rowH.reduce((a, b) => a + b, 0) + (model.sessions.length ? LANE : 0) + 4;
  const todayX = xOf(model.origin, today, px) + px / 2;
  const tickList = ticks(model.origin, model.days, zoom);
  let y = HEAD;
  const rowTop = rowH.map((h) => { const t = y; y += h; return t; });
  const sessTop = y;

  return (
    <>
      <div className="pj-tl-bar">
        <Segmented label="Zoom" value={zoom} onChange={setZoom} options={ZOOMS} />
        <div className="grow" />
        <Button onClick={() => { if (scroller.current) scroller.current.scrollTo({ left: Math.max(0, xOf(model.origin, today, px) - 140), behavior: 'smooth' }); }}>Today</Button>
        {project.calendarId && <Button onClick={() => review({ op: 'sync_calendar' }, 'Put on Calendar')}>Sync to Calendar…</Button>}
        <Button variant="primary" icon="Plus" onClick={() => setAdding(true)}>Add…</Button>
      </div>
      {!project.phases.length && !project.milestones.length && <Banner icon="Info">Nothing is on this timeline yet. Add a phase or a milestone, or start from a template when you create a project.</Banner>}

      {sel && (
        <div className="pj-tl-sel">
          <span className="grow"><strong>{sel.title}</strong>
            <span className="muted small"> {KIND_LABEL[sel.kind]}{sel.deadline ? ', deadline' : ''}, {fmtDay(sel.start)}{sel.end !== sel.start ? ` to ${fmtDay(sel.end)}` : ''}
              {drag?.key === sel.key && drag.days ? `. Move to ${fmtDay(addDays(sel.start, drag.days))}` : ''}</span></span>
          <Input type="date" aria-label="Move to date" value={moveTo || sel.start} onChange={(e) => setMoveTo(e.target.value)} style={{ width: 140 }} />
          <Button disabled={!moveTo || moveTo === sel.start} onClick={() => { const n = daysBetween(sel.start, moveTo); setMoveTo(''); review(opFor(sel, n), 'Move'); }}>Move…</Button>
          {sel.kind !== 'task' && <Button onClick={() => review({ op: 'remove_item', type: sel.kind, id: sel.id }, 'Remove')}>Remove…</Button>}
        </div>
      )}

      <div className="pj-tl">
        <div className="pj-tl-gutter" style={{ paddingTop: HEAD }}>
          {model.rows.map((r, i) => <div key={r.name} style={{ height: rowH[i] }}>{r.name}</div>)}
          {model.sessions.length > 0 && <div style={{ height: LANE }}>Sessions</div>}
        </div>
        <div className="pj-tl-scroll" ref={scroller}>
          <div className="pj-tl-canvas" style={css({ width, height, '--c': color })} onPointerDown={(e) => { if (e.target === e.currentTarget) setSelKey(null); }}>
            {tickList.map((t) => (
              <div key={t.date} className="pj-tick" data-major={t.major} style={{ left: t.x }}><span>{t.label}</span></div>
            ))}
            {rowTop.map((t, i) => <div key={i} className="pj-tl-rowline" style={{ top: t, width }} />)}
            <div className="pj-today" style={{ left: todayX }}><span>Today</span></div>

            {model.rows[0].packed.map(({ it, lane }) => (
              <div key={it.key} className="pj-phase" {...itemProps(it)} style={{ left: xOf(model.origin, it.start, px), width: widthOf(it.start, it.end, px), top: rowTop[0] + PAD + lane * LANE, ...shift(it) }} title={`${it.title}, ${fmtDay(it.start)} to ${fmtDay(it.end)}`}>
                <span>{it.title}</span>
              </div>
            ))}
            {model.rows[1].packed.map(({ it, lane }) => (
              <div key={it.key} className="pj-mile" {...itemProps(it)} data-done={it.done} style={{ left: xOf(model.origin, it.start, px) + Math.max(0, px / 2 - 8), top: rowTop[1] + PAD + lane * LANE, ...shift(it) }} title={`${it.title}, ${fmtDay(it.start)}`}>
                {it.deadline ? <Icon name="Flag" size={14} strokeWidth={2.25} /> : <i className="pj-diamond" />}
                {(zoom === 'week' || zoom === 'month') && <span>{it.title}</span>}
              </div>
            ))}
            {model.rows[2].packed.map(({ it, lane }) => (
              <div key={it.key} className="pj-task-pt" {...itemProps(it)} style={{ left: xOf(model.origin, it.start, px) + Math.max(0, px / 2 - 6), top: rowTop[2] + PAD + lane * LANE, ...shift(it) }} title={`${it.title}, ${fmtDay(it.start)}`}>
                <i />{(zoom === 'week' || zoom === 'month') && <span>{it.title}</span>}
              </div>
            ))}
            {model.sessions.map(([day, s]) => (
              <div key={day} className="pj-sess" role="img" aria-label={`${s.n} session${s.n === 1 ? '' : 's'} on ${fmtDay(day)}, ${fmtDur(s.min)}`} title={`${fmtDay(day)}: ${s.n} session${s.n === 1 ? '' : 's'}, ${fmtDur(s.min)}`}
                style={{ left: xOf(model.origin, day, px) + 1, width: Math.max(3, px - 2), top: sessTop + 8, opacity: Math.min(1, 0.35 + s.min / 180) }} />
            ))}
          </div>
        </div>
      </div>
      <p className="why-line" style={{ marginTop: 8 }}>Drag an item to a new day, or select it and use the arrow keys (Shift moves a week). Every move is reviewed first. Diamonds are milestones, flags are deadlines, bars are phases.</p>

      <PlanSheet projectId={id} op={op} confirmLabel={opLabel} onClose={() => setOp(null)} />
      {adding && <AddSheet onClose={() => setAdding(false)} onReview={(o) => { setAdding(false); review(o, 'Add'); }} />}
    </>
  );
}
