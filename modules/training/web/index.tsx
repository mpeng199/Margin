import { useState } from 'react';
import { useLocation } from 'wouter';
import { DateTime } from 'luxon';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { fmtDay, fmtDur } from '@web/lib/format';
import { Section, Group, Item, Button, IconButton, Input, Select, TextArea, Field, Segmented, Sheet, Tag, Empty, Banner, Toggle, Why } from '@web/ui';
import type { Lift, Sign, TrainingSession } from '../manifest';
import './training.css';

interface Overview {
  date: string;
  rest: { weekStart: string; days: { date: string; trained: boolean; future: boolean }[]; restDays: number; offDay: string; offDayTrained: boolean; message: string | null };
  today: { sleepMin: number | null; lighter: boolean; message: string | null };
  deload: { active: boolean; note: string | null };
  warnings: { signs: Sign[]; suggest: boolean };
  rhr: { weeks: { week: string; bpm: number }[]; thisWeek: number | null; avg: number | null };
  week: { sessions: number; minutes: number };
  recent: TrainingSession[];
}

const KIND = { gym: 'Gym', badminton: 'Badminton' } as const;
const SIGNS: { id: Sign['id']; label: string; rule: string }[] = [
  { id: 'rhr', label: 'Resting heart rate up', rule: '5 or more bpm above your 4-week average' },
  { id: 'lifts', label: 'Lifts stalled', rule: 'No new best for 2 or more weeks' },
  { id: 'soreness', label: 'Persistent soreness', rule: 'Averaging 6 of 10 or more this week' },
  { id: 'dread', label: 'Dreading sessions', rule: '2 or more dreaded this week' },
];
const SOURCE = 'Meeusen 2013';

function Notes({ o, compact }: { o: Overview; compact?: boolean }) {
  return (
    <>
      {o.warnings.suggest && (
        <Banner tone="amber" icon="TriangleAlert" why={`Two or more signs together point to under-recovery (${SOURCE}).`}>
          <strong>{o.warnings.signs.length} warning signs this week.</strong> Consider a deload week or an extra rest day. {!compact && o.warnings.signs.map((s) => s.detail).join(' ')}
        </Banner>
      )}
      {o.today.message && <Banner icon="BedDouble" why="Teens need 8 to 10 hours; sleep isn’t traded for training (AASM 2016).">{o.today.message}</Banner>}
      {o.deload.note && <Banner icon="Gauge">{o.deload.note}</Banner>}
    </>
  );
}

function Lifts({ lifts, onChange }: { lifts: Lift[]; onChange: (l: Lift[]) => void }) {
  const set = (i: number, p: Partial<Lift>) => onChange(lifts.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <div style={{ display: 'grid', gap: 'var(--s2)' }}>
      {lifts.map((l, i) => (
        <div key={i} className="training-lift">
          <Input aria-label="Lift" placeholder="Squat" value={l.name} onChange={(e) => set(i, { name: e.target.value })} />
          <Input aria-label="Weight in pounds" type="number" min={0} placeholder="lb" value={l.weight || ''} onChange={(e) => set(i, { weight: Number(e.target.value) })} />
          <Input aria-label="Reps" type="number" min={1} placeholder="reps" value={l.reps || ''} onChange={(e) => set(i, { reps: Number(e.target.value) })} />
          <IconButton icon="X" label="Remove lift" onClick={() => onChange(lifts.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Button icon="Plus" onClick={() => onChange([...lifts, { name: '', weight: 0, reps: 5 }])}>Add Lift</Button></div>
    </div>
  );
}

function LogSheet({ open, onClose, date }: { open: boolean; onClose: () => void; date: string }) {
  const [kind, setKind] = useState<'gym' | 'badminton'>('gym');
  const [when, setWhen] = useState(date);
  const [minutes, setMinutes] = useState(60);
  const [rpe, setRpe] = useState(6);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [soreness, setSoreness] = useState<string>('');
  const [dreaded, setDreaded] = useState(false);
  const [note, setNote] = useState('');
  const save = useAction('post', '/api/training/sessions', onClose);
  const valid = minutes > 0 && when;
  return (
    <Sheet open={open} onClose={onClose} wide title="Log a session" subtitle="Effort counts more than the clock: rate how hard it felt, 1 easy to 10 all-out."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || save.isPending} onClick={() => save.mutate({
        kind, date: when, minutes, rpe, soreness: soreness === '' ? null : Number(soreness), dreaded, note,
        lifts: kind === 'gym' ? lifts.filter((l) => l.name.trim() && l.reps > 0) : [],
      } as any)}>Log Session</Button></>}>
      <div style={{ display: 'grid', gap: 'var(--s3)' }}>
        <Segmented label="Kind" value={kind} onChange={setKind} options={(Object.keys(KIND) as (keyof typeof KIND)[]).map((k) => ({ value: k, label: KIND[k] }))} />
        <div className="training-row">
          <Field label="Date"><Input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Field label="Minutes"><Input type="number" min={1} max={360} style={{ width: 90 }} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></Field>
        </div>
        <Field label="Effort (RPE)">
          <div className="seg training-rpe" role="group" aria-label="Effort, 1 to 10">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <button key={n} type="button" aria-pressed={rpe === n} onClick={() => setRpe(n)}>{n}</button>)}
          </div>
        </Field>
        {kind === 'gym' && <Field label="Lifts (optional)"><Lifts lifts={lifts} onChange={setLifts} /></Field>}
        <div className="training-row">
          <Field label="Soreness now, 0 to 10">
            <Select value={soreness} style={{ width: 110 }} onChange={(e) => setSoreness(e.target.value)}>
              <option value="">Not rated</option>
              {Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </Select>
          </Field>
          <Field label="Dreaded this session">
            <Toggle checked={dreaded} onChange={setDreaded} label="Dreaded this session" />
          </Field>
        </div>
        <Field label="Note (optional)"><TextArea rows={2} maxLength={240} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Sheet>
  );
}

function RhrRow({ o }: { o: Overview }) {
  const [v, setV] = useState('');
  const save = useAction<{ bpm: number }>('put', '/api/training/rhr', () => setV(''));
  const bpm = Number(v);
  return (
    <Section title="Resting heart rate" why={`One reading a week, taken on waking. Up 5 or more over the 4-week average is a warning sign (${SOURCE}).`}>
      <Group>
        <Item>
          <div className="title">
            <div>This week</div>
            <div className="sub">{o.rhr.thisWeek ? `${o.rhr.thisWeek} bpm` : 'Not logged yet'}{o.rhr.avg ? ` · 4-week average ${o.rhr.avg}` : ''}</div>
          </div>
          <div className="training-rhr">
            <Input type="number" aria-label="Resting heart rate in beats per minute" min={25} max={140} placeholder="bpm" value={v} onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && bpm) save.mutate({ bpm }); }} />
            <Button disabled={!bpm || save.isPending} onClick={() => save.mutate({ bpm })}>Save</Button>
          </div>
        </Item>
        {o.rhr.weeks.length > 1 && (
          <Item><span className="small muted num">{o.rhr.weeks.map((w) => `${w.bpm}`).join(' · ')} <span className="faint">bpm, oldest to newest</span></span></Item>
        )}
      </Group>
    </Section>
  );
}

function TrainingPage() {
  const q = useApi<Overview>('/api/training/overview');
  const [log, setLog] = useState(false);
  const remove = useAction<{ id: string }>('del', (b) => `/api/training/sessions/${b.id}`);
  const o = q.data;
  if (!o) return <Page title="Training" width="narrow"><div /></Page>;
  const live = new Set(o.warnings.signs.map((s) => s.id));
  return (
    <Page title="Training" width="narrow" actions={<Button variant="primary" icon="Plus" onClick={() => setLog(true)}>Log Session</Button>}>
      <Notes o={o} />
      <Section title="This week" why={`At least one rest day a week, ideally the off-day (${SOURCE}).`}
        end={<span className="small muted num">{o.week.sessions} session{o.week.sessions === 1 ? '' : 's'} · {fmtDur(o.week.minutes)}</span>}>
        <Group pad>
          <div className="training-week">
            {o.rest.days.map((d) => {
              const s = d.trained ? 'trained' : d.future || d.date === o.date ? 'open' : 'rest';
              return (
                <div key={d.date} className="training-day" data-today={d.date === o.date} title={`${fmtDay(d.date)}: ${s === 'open' ? 'open' : s}`}>
                  <span aria-hidden="true">{DateTime.fromISO(d.date, { zone: 'UTC' }).toFormat('ccccc')}</span>
                  <span className="training-dot" data-s={s} />
                  <span className="tiny faint">{d.date === o.rest.offDay ? 'Off-day' : s === 'trained' ? 'Trained' : s === 'rest' ? 'Rest' : ''}</span>
                </div>
              );
            })}
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>{o.rest.message ?? `${o.rest.restDays} rest day${o.rest.restDays === 1 ? '' : 's'} so far this week. That’s the minimum met.`}</p>
        </Group>
      </Section>

      <Section title="Weekly check" why={`Two or more signs suggest a deload or rest (${SOURCE}).`}>
        <Group>
          {SIGNS.map((s) => {
            const hit = o.warnings.signs.find((x) => x.id === s.id);
            return (
              <Item key={s.id}>
                <div className="title"><div>{s.label}</div><div className="sub">{hit ? hit.detail : s.rule}</div></div>
                {live.has(s.id) ? <Tag tone="amber">Showing</Tag> : <Tag>Clear</Tag>}
              </Item>
            );
          })}
        </Group>
      </Section>

      <RhrRow o={o} />

      <Section title="Recent sessions">
        <Group>
          {o.recent.length ? o.recent.map((s) => (
            <Item key={s.id}>
              <div className="title">
                <div className="row"><span>{KIND[s.kind]}</span>{s.dreaded && <Tag>Dreaded</Tag>}</div>
                <div className="sub">{fmtDay(s.date)} · {fmtDur(s.minutes)} · effort {s.rpe}{s.soreness != null ? ` · soreness ${s.soreness}` : ''}{s.lifts.length ? ` · ${s.lifts.map((l) => `${l.name} ${l.weight || 'BW'}×${l.reps}`).join(', ')}` : ''}</div>
              </div>
              <IconButton icon="Trash2" label={`Remove ${KIND[s.kind]} on ${fmtDay(s.date)}`} onClick={() => remove.mutate({ id: s.id })} />
            </Item>
          )) : <Empty action={<Button onClick={() => setLog(true)}>Log Session</Button>}>No sessions in the last three weeks.</Empty>}
        </Group>
      </Section>
      {log && <LogSheet open onClose={() => setLog(false)} date={o.date} />}
    </Page>
  );
}

/** Only shows when there's something to say: a warning, a short night, the Stabilize deload, or no rest day yet. */
function TodayWidget() {
  const q = useApi<Overview>('/api/training/overview');
  const [, navigate] = useLocation();
  const o = q.data;
  if (!o) return null;
  const lines = [
    o.warnings.suggest ? 'Two or more warning signs this week. Consider a deload or a rest day.' : null,
    o.today.message,
    o.deload.note,
    o.rest.message && o.rest.restDays === 0 && !o.rest.offDayTrained ? o.rest.message : null,
  ].filter((x): x is string => !!x);
  if (!lines.length) return null;
  return (
    <Section title="Training" why={<Why source={SOURCE}>Rest is part of the plan.</Why>} end={<Button variant="plain" onClick={() => navigate('/training')}>Open</Button>}>
      <Group pad>{lines.map((l) => <p key={l} className="small" style={{ margin: '0 0 6px' }}>{l}</p>)}</Group>
    </Section>
  );
}

export default defineWebModule({
  id: 'training',
  routes: [{ path: '/training', component: TrainingPage, work: false }],
  widgets: { today: TodayWidget },
  commands: [{ id: 'training.open', label: 'Log a Training Session', group: 'Training', run: () => '/training' }],
});
