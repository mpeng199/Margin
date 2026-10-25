import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { fmtDay } from '@web/lib/format';
import { Section, Group, Item, Button, IconButton, Check, Input, Select, TextArea, Field, Segmented, Sheet, Tag, Empty, Why, Banner, Icon } from '@web/ui';
import type { HabitView } from '../manifest';
import './habits.css';

type Type = HabitView['type'];
type Schedule = HabitView['schedule'];
interface Slots { max: number; used: number; free: number; canAdd: boolean; reason?: string }
interface LibraryItem { key: string; name: string; why: string; cue: string; type: Type; auto: string | null; phaseOne: boolean; added: boolean }
interface Overview {
  date: string; formation: HabitView[]; automatic: HabitView[]; slots: Slots; library: LibraryItem[];
  research: { median: number; min: number; max: number; source: string };
}
interface TodayData { date: string; due: HabitView[]; nudges: string[] }

const TYPE_LABEL: Record<Type, string> = { yesno: 'Yes or no', count: 'Count', minutes: 'Minutes', scale: '0 to 10' };
const DAYS = [{ n: 1, l: 'Mon' }, { n: 2, l: 'Tue' }, { n: 3, l: 'Wed' }, { n: 4, l: 'Thu' }, { n: 5, l: 'Fri' }, { n: 6, l: 'Sat' }, { n: 7, l: 'Sun' }];
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

function useLogging(date: string) {
  const log = useAction<{ id: string; value: number }>('post', (b) => `/api/habits/${b.id}/log`);
  const unlog = useAction<{ id: string }>('del', (b) => `/api/habits/${b.id}/log/${date}`);
  const set = (h: HabitView, value: number) => {
    if (value <= 0 && h.type !== 'minutes' && h.type !== 'scale') unlog.mutate({ id: h.id });
    else log.mutate({ id: h.id, value });
  };
  return { set, clear: (h: HabitView) => unlog.mutate({ id: h.id }), busy: log.isPending || unlog.isPending };
}

/** One-tap logging: a check for yes/no, a stepper for counts, a minutes field, a 0 to 10 row. */
function LogControl({ h, date }: { h: HabitView; date: string }) {
  const { set, clear } = useLogging(date);
  if (h.type === 'yesno') {
    return <Check checked={h.done} label={`${h.name}: ${h.done ? 'done, tap to undo' : 'mark done'}`} onChange={(v) => (v ? set(h, 1) : clear(h))} />;
  }
  if (h.type === 'count') {
    const v = h.value ?? 0;
    return (
      <span className="habits-stepper">
        <IconButton icon="Minus" label={`Fewer ${h.name}`} disabled={v <= 0} onClick={() => (v <= 1 ? clear(h) : set(h, v - 1))} />
        <span className="num" aria-live="polite">{v} of {h.target}</span>
        <IconButton icon="Plus" label={`More ${h.name}`} onClick={() => set(h, v + 1)} />
      </span>
    );
  }
  if (h.type === 'minutes') {
    const commit = (raw: string) => {
      if (raw === '') { if (h.value != null) clear(h); return; }
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n !== h.value) set(h, n);
    };
    return (
      <label className="habits-minutes">
        <Input key={h.value ?? 'none'} type="number" min={0} step={5} inputMode="numeric" aria-label={`Minutes of ${h.name}`} defaultValue={h.value ?? ''}
          onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        of {h.target} min
      </label>
    );
  }
  return (
    <div className="seg habits-scale" role="group" aria-label={`${h.name}, 0 to 10`}>
      {Array.from({ length: 11 }, (_, i) => (
        <button key={i} type="button" aria-pressed={h.value === i} onClick={() => (h.value === i ? clear(h) : set(h, i))}>{i}</button>
      ))}
    </div>
  );
}

function Dots({ h }: { h: HabitView }) {
  const doneN = h.recent.filter((d) => d.status === 'done').length;
  return (
    <div className="habits-dots" role="img" aria-label={`Last 14 days: ${doneN} done`}>
      {h.recent.map((d) => <span key={d.date} className="habits-dot" data-s={d.status} title={`${fmtDay(d.date)}: ${d.status === 'miss' ? 'not logged' : d.status}`} />)}
    </div>
  );
}

function NeverTwice() {
  return <div className="habits-note">Two scheduled days in a row without a log. Do the smallest version today, even two minutes. <Why source="Lally 2010">One missed day barely dents a habit; the second in a row is the one to avoid.</Why></div>;
}

function TodayWidget() {
  const q = useApi<TodayData>('/api/habits/today');
  const d = q.data;
  if (!d || !d.due.length) return null;
  const left = d.due.filter((h) => !h.done).length;
  return (
    <Section title="Habits" why="Consistency counts, not streaks; a miss is data (Lally 2010)." end={<span className="small muted">{left ? `${left} to go` : 'All logged'}</span>}>
      <Group>
        {d.due.map((h) => (
          <Item key={h.id}>
            <LogControl h={h} date={d.date} />
            <div className="title">
              <div>{h.name}</div>
              <div className="sub">{h.autoLogged ? 'Logged automatically' : h.cue || h.why}</div>
              {d.nudges.includes(h.id) && !h.done && <NeverTwice />}
            </div>
          </Item>
        ))}
      </Group>
    </Section>
  );
}

// ---- builder

interface Draft {
  name: string; why: string; cueAfter: string; cueWill: string; type: Type; kind: 'days' | 'perWeek';
  days: number[]; n: number; target: number; reminder: string; startDate: string;
}
const blank = (date: string): Draft => ({ name: '', why: '', cueAfter: '', cueWill: '', type: 'yesno', kind: 'days', days: [1, 2, 3, 4, 5, 6, 7], n: 3, target: 1, reminder: '', startDate: date });
const fromHabit = (h: HabitView): Draft => ({
  name: h.name, why: h.why, cueAfter: h.cueAfter, cueWill: h.cueWill, type: h.type,
  kind: h.schedule.kind, days: h.schedule.kind === 'days' ? h.schedule.days : [1, 2, 3, 4, 5, 6, 7], n: h.schedule.kind === 'perWeek' ? h.schedule.n : 3,
  target: h.target, reminder: h.reminder ?? '', startDate: h.startDate,
});
const toBody = (d: Draft) => ({
  name: d.name, why: d.why, cueAfter: d.cueAfter, cueWill: d.cueWill, type: d.type,
  schedule: d.kind === 'days' ? { kind: 'days', days: d.days } : { kind: 'perWeek', n: d.n },
  target: d.type === 'yesno' ? 1 : d.target, reminder: d.reminder || null, startDate: d.startDate,
});

function BuilderSheet({ open, onClose, date, editing }: { open: boolean; onClose: () => void; date: string; editing: HabitView | null }) {
  const [d, setD] = useState<Draft>(() => (editing ? fromHabit(editing) : blank(date)));
  const save = useAction<Draft>('post', '/api/habits', onClose);
  const patch = useAction<Draft>('patch', `/api/habits/${editing?.id}`, onClose);
  const archive = useAction('post', `/api/habits/${editing?.id}/archive`, onClose);
  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const valid = d.name.trim() && (d.kind === 'perWeek' || d.days.length > 0) && (d.type === 'yesno' || d.target > 0);
  const submit = () => (editing ? patch : save).mutate(toBody(d) as any);
  const targetLabel = d.type === 'count' ? 'Target per day' : d.type === 'minutes' ? 'Minutes per day' : 'Counts as done at';
  return (
    <Sheet open={open} onClose={onClose} wide title={editing ? 'Edit habit' : 'New habit'}
      subtitle="Small, specific, and tied to something you already do. Two in formation at a time."
      footer={<>
        {editing && <Button variant="plain" onClick={() => archive.mutate({} as any)}>Stop Tracking</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid || save.isPending || patch.isPending} onClick={submit}>{editing ? 'Save' : 'Add Habit'}</Button>
      </>}>
      <div className="stack" style={{ display: 'grid', gap: 'var(--s3)' }}>
        <Field label="Name"><Input autoFocus value={d.name} maxLength={80} onChange={(e) => up({ name: e.target.value })} placeholder="Stretch for five minutes" /></Field>
        <div className="habits-cue">
          <span>After</span><Input value={d.cueAfter} maxLength={120} onChange={(e) => up({ cueAfter: e.target.value })} placeholder="I brush my teeth" aria-label="After" />
          <span>I will</span><Input value={d.cueWill} maxLength={160} onChange={(e) => up({ cueWill: e.target.value })} placeholder="do two minutes of stretching" aria-label="I will" />
        </div>
        <Field label="Why it matters to you"><TextArea rows={2} value={d.why} maxLength={240} onChange={(e) => up({ why: e.target.value })} /></Field>
        <Field label="How you log it">
          <Segmented label="Type" value={d.type} onChange={(type) => up({ type, target: type === 'scale' ? 7 : type === 'minutes' ? 10 : 1 })}
            options={(Object.keys(TYPE_LABEL) as Type[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </Field>
        {d.type !== 'yesno' && (
          <Field label={targetLabel}><Input type="number" min={1} max={d.type === 'scale' ? 10 : 1440} value={d.target} style={{ width: 100 }} onChange={(e) => up({ target: Number(e.target.value) })} /></Field>
        )}
        <Field label="Schedule">
          <Segmented label="Schedule" value={d.kind} onChange={(kind) => up({ kind })} options={[{ value: 'days', label: 'Specific days' }, { value: 'perWeek', label: 'Times per week' }]} />
        </Field>
        {d.kind === 'days' ? (
          <div className="habits-days" role="group" aria-label="Days">
            {DAYS.map((x) => (
              <Button key={x.n} variant={d.days.includes(x.n) ? 'primary' : 'default'} aria-pressed={d.days.includes(x.n)}
                onClick={() => up({ days: d.days.includes(x.n) ? d.days.filter((n) => n !== x.n) : [...d.days, x.n].sort() })}>{x.l}</Button>
            ))}
          </div>
        ) : (
          <Field label="Times per week" hint="Any days. It leaves the list once the week’s count is met.">
            <Select value={d.n} style={{ width: 100 }} onChange={(e) => up({ n: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </Field>
        )}
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s4)' }}>
          <Field label="Reminder (optional)"><Input type="time" value={d.reminder} onChange={(e) => up({ reminder: e.target.value })} /></Field>
          <Field label="Start date"><Input type="date" value={d.startDate} onChange={(e) => up({ startDate: e.target.value })} /></Field>
        </div>
      </div>
    </Sheet>
  );
}

// ---- page

function ActiveRow({ h, onEdit, date }: { h: HabitView; onEdit: () => void; date: string }) {
  const graduate = useAction('post', `/api/habits/${h.id}/graduate`);
  return (
    <Item>
      <div className="title">
        <div className="row"><span>{h.name}</span>{h.ready && <Tag tone="green">Holding the bar</Tag>}</div>
        <div className="sub">{h.cue || h.why}{h.day ? ` · Day ${h.day}` : h.startDate > date ? ` · Starts ${fmtDay(h.startDate)}` : ''}</div>
        <Dots h={h} />
        {h.missedTwice && <NeverTwice />}
      </div>
      <div className="habits-stats num"><span>2 wk <b>{pct(h.consistency2w)}</b></span><span>4 wk <b>{pct(h.consistency4w)}</b></span></div>
      {h.ready && <Button onClick={() => graduate.mutate({} as any)} disabled={graduate.isPending}>Move to Automatic</Button>}
      <IconButton icon="Pencil" label={`Edit ${h.name}`} onClick={onEdit} />
    </Item>
  );
}

function HabitsPage() {
  const q = useApi<Overview>('/api/habits/overview');
  const o = q.data;
  const [sheet, setSheet] = useState<{ editing: HabitView | null } | null>(null);
  const add = useAction<{ key: string }>('post', (b) => `/api/habits/library/${b.key}`);
  const phaseOne = useAction('post', '/api/habits/phase-one');
  if (!o) return <Page title="Habits" width="narrow"><div /></Page>;
  const { slots } = o;
  const library = o.library.filter((l) => !l.added);
  return (
    <Page title="Habits" width="narrow" actions={<Button variant="primary" icon="Plus" disabled={!slots.canAdd} title={slots.reason} onClick={() => setSheet({ editing: null })}>New Habit</Button>}>
      {!slots.canAdd && slots.reason && <Banner tone="amber" icon="Info">{slots.reason}</Banner>}
      <Section title="In formation" why="Two at a time, so effort isn’t spread thin; consistency over streaks (Lally 2010)."
        end={<span className="small muted num">{slots.used} of {slots.max} in formation</span>}>
        <Group>
          {o.formation.length ? o.formation.map((h) => <ActiveRow key={h.id} h={h} date={o.date} onEdit={() => setSheet({ editing: h })} />) : (
            <Empty action={<Button onClick={() => phaseOne.mutate({} as any)}>Start With the Phase 1 Three</Button>}>
              Nothing in formation yet. The starting set is a fixed wake time, shutdown complete, and the phone out of the bedroom.
            </Empty>
          )}
        </Group>
        <p className="small muted" style={{ marginTop: 10 }}>
          Habits took a median of {o.research.median} days to form, with a range of {o.research.min} to {o.research.max} ({o.research.source}). Missing one day did not materially change that, so a miss is just data.
        </p>
      </Section>

      <Section title="Library" why="Off until you choose one. Each comes with a cue and a reason.">
        <Group>
          {library.length ? library.map((l) => (
            <Item key={l.key}>
              <div className="title">
                <div className="row"><span>{l.name}</span>{l.phaseOne && <Tag>Phase 1</Tag>}{l.auto && <Tag>Logs itself</Tag>}</div>
                <div className="sub">{l.cue}</div>
                <div className="sub faint">{l.why}</div>
              </div>
              <Button disabled={!slots.canAdd || add.isPending} title={slots.canAdd ? undefined : slots.reason} onClick={() => add.mutate({ key: l.key })}>Add</Button>
            </Item>
          )) : <Empty>Everything in the library is already added.</Empty>}
        </Group>
      </Section>

      {o.automatic.length > 0 && (
        <Section title="Graduated" why="Held the bar for two weeks, so they no longer need a daily tap.">
          <Group>
            {o.automatic.map((h) => (
              <Item key={h.id}>
                <Icon name="CircleCheck" size={16} />
                <div className="title"><div>{h.name}</div><div className="sub">{h.graduatedOn ? `Automatic since ${fmtDay(h.graduatedOn)}` : 'Automatic'}</div></div>
                <span className="habits-stats num"><span>4 wk <b>{pct(h.consistency4w)}</b></span></span>
              </Item>
            ))}
          </Group>
        </Section>
      )}

      {sheet && <BuilderSheet key={sheet.editing?.id ?? 'new'} open onClose={() => setSheet(null)} date={o.date} editing={sheet.editing} />}
    </Page>
  );
}

export default defineWebModule({
  id: 'habits',
  routes: [{ path: '/habits', component: HabitsPage, work: false }],
  widgets: { today: TodayWidget },
});
