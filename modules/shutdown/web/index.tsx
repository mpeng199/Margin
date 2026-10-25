import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { api } from '@web/lib/api';
import { useDay, useNow, useHotkey } from '@web/lib/hooks';
import { Section, Group, Item, Button, Input, TextArea, Segmented, Check, Tag, Why, Banner, Empty, toast } from '@web/ui';
import { dt, fmtCountdown, fmtTime, fmtTimeShort, fmtDayLong, relDay } from '@web/lib/format';
import type { ShutdownState, Evaluation, LightTask, DeadlineRow, Suggestion } from '../flow';
import type { RitualStep } from '../../rituals/defaults';
import './shutdown.css';

// ------------------------------------------------------------------ the draft (kept in the browser, mirrored to the server so Esc is safe)
type When = 'tomorrow' | 'date' | 'week' | 'someday';
type Decision = '' | 'first' | 'slot' | 'delegate' | 'drop';
interface DItem { text: string; nextAction: string; when: When; date: string; time: string; mustDo: boolean }
interface DCarry { mode: 'none' | 'carry' | 'triage'; nextAction: string; decision: Decision; time: string; owner: string; reason: string }
interface DDecision { key: string; status: 'covered' | 'moved' | 'risk'; date?: string; time?: string; reason?: string }
interface Draft { step: number; dump: string; items: DItem[]; carry: Record<string, DCarry>; mustDos: string[]; decisions: Record<string, DDecision>; phoneOut: boolean }
interface P { s: ShutdownState; d: Draft; set: (f: (d: Draft) => Draft) => void; ev: Evaluation | null }

const emptyDraft = (): Draft => ({ step: 0, dump: '', items: [], carry: {}, mustDos: [], decisions: {}, phoneOut: false });
const blankCarry = (): DCarry => ({ mode: 'none', nextAction: '', decision: '', time: '', owner: '', reason: '' });
const blankItem = (text: string): DItem => ({ text, nextAction: '', when: 'tomorrow', date: '', time: '', mustDo: false });

/** One item per line, bullets and numbers stripped, repeats dropped; items already worked on keep their answers. */
function reconcile(dump: string, items: DItem[]): DItem[] {
  const seen = new Set<string>();
  const out: DItem[] = [];
  for (const raw of dump.split('\n')) {
    const text = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim().slice(0, 300);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(items.find((i) => i.text === text) ?? blankItem(text));
  }
  return out;
}
const canMust = (it: DItem, planDate: string) => it.when === 'tomorrow' || (it.when === 'date' && it.date === planDate);

function buildPayload(d: Draft, s: ShutdownState) {
  const carryIds = new Set(s.carry.map((c) => c.id));
  const must = new Map(s.carry.map((c) => [c.id, c.mustTriage]));
  const eff = Object.entries(d.carry).filter(([id]) => carryIds.has(id)).map(([id, c]) => [id, must.get(id) ? { ...c, mode: 'triage' as const } : c] as const);
  return {
    items: d.items.filter((i) => i.text.trim()).map((i) => ({
      text: i.text.trim(), nextAction: i.nextAction.trim(), when: i.when,
      date: i.when === 'date' && i.date ? i.date : undefined,
      time: (i.when === 'tomorrow' || i.when === 'date') && i.time ? i.time : undefined,
      mustDo: i.mustDo && canMust(i, s.planDate),
    })),
    carry: eff.filter(([, c]) => c.mode === 'carry').map(([taskId, c]) => ({ taskId, nextAction: c.nextAction.trim() })),
    triage: eff.filter(([, c]) => c.mode === 'triage' && c.decision).map(([taskId, c]) => ({
      taskId, decision: c.decision as Exclude<Decision, ''>,
      time: c.decision === 'slot' && c.time ? c.time : undefined,
      owner: c.decision === 'delegate' && c.owner.trim() ? c.owner.trim() : undefined,
      reason: c.decision === 'drop' && c.reason.trim() ? c.reason.trim() : undefined,
    })),
    mustDos: d.mustDos,
    decisions: Object.values(d.decisions),
    phoneOut: d.phoneOut,
  };
}

// ------------------------------------------------------------------ steps
// Ritual step ids the flow knows how to render. Others (added in Settings → Rituals) show as a plain prompt.
const REQUIRED = ['actions', 'deadlines', 'phone'];
const FALLBACK: Record<string, string> = {
  actions: 'Give each item a next action and a day or slot',
  deadlines: 'Confirm every deadline in the next 72 hours is covered',
  phone: 'Phone goes out of the bedroom',
};
/** The rules (a next action per item, deadlines covered, phone out) hold even if their steps were removed from the ritual. */
function resolveSteps(steps: RitualStep[]): RitualStep[] {
  const out = [...steps];
  const missing = REQUIRED.filter((k) => !steps.some((x) => x.id === k)).map((k) => ({ id: k, label: FALLBACK[k] }));
  out.splice(Math.max(out.length - 1, 0), 0, ...missing);
  return out;
}

const LEDE: Record<string, string> = {
  dump: 'Write down everything still open in your head: school, projects, errands, things you’re afraid of forgetting. One per line. Don’t sort anything yet.',
  actions: 'Each item gets one physical next step and a day. Then it can stop running in the background.',
  'must-dos': 'Pick the few things that make tomorrow a good day if they’re done. Three at most.',
  tomorrow: 'A look at what’s fixed, so nothing about tomorrow is a surprise.',
  deadlines: 'Anything due in the next 72 hours needs a plan, or a decision to let it go.',
  phone: 'Charge it somewhere outside the bedroom, like the kitchen or hallway.',
  complete: 'Everything is written down and planned. Nothing more to do tonight.',
};

// ------------------------------------------------------------------ 1. brain dump
function DumpStep({ d, set }: P) {
  const n = reconcile(d.dump, []).length;
  return (
    <>
      <TextArea className="sd-dump" autoFocus aria-label="Open loops, one per line" placeholder={'Email Dr. Lim about the beads\nAsk about the SHP deadline\nPermission slip'} value={d.dump} onChange={(e) => set((x) => ({ ...x, dump: e.target.value }))} />
      <p className="sd-sub">{n === 0 ? 'Nothing open? Continue.' : `${n} ${n === 1 ? 'item' : 'items'}`}</p>
    </>
  );
}

// ------------------------------------------------------------------ 2. next action + day, carry/triage
const WHEN: { value: When; label: string }[] = [
  { value: 'tomorrow', label: 'Tomorrow' }, { value: 'date', label: 'Date' }, { value: 'week', label: 'This Week' }, { value: 'someday', label: 'Someday' },
];
const DECISIONS: { value: Exclude<Decision, ''>; label: string }[] = [
  { value: 'first', label: 'Do First' }, { value: 'slot', label: 'Fixed Slot' }, { value: 'delegate', label: 'Delegate' }, { value: 'drop', label: 'Drop' },
];

function CarryRow({ t, s, c, patch }: { t: LightTask & { mustTriage: boolean }; s: ShutdownState; c: DCarry; patch: (p: Partial<DCarry>) => void }) {
  const mode = t.mustTriage ? 'triage' : c.mode;
  return (
    <Group pad className="sd-card">
      <div className="row between">
        <div className="grow">
          <div className="sd-card-title">{t.content}</div>
          <div className="sd-sub">{t.projectName}{t.carryCount ? ` · carried ${t.carryCount} ${t.carryCount === 1 ? 'time' : 'times'}` : ''}</div>
        </div>
        {t.mustTriage && <Tag tone="amber">Decide, don’t carry</Tag>}
      </div>
      {!t.mustTriage && (
        <Segmented<DCarry['mode']> label={`What to do with ${t.content}`} value={mode} onChange={(v) => patch({ mode: v })}
          options={[{ value: 'none', label: 'Leave' }, { value: 'carry', label: `Carry to ${s.planLabel}` }, { value: 'triage', label: 'Triage' }]} />
      )}
      {mode === 'carry' && (
        <Input aria-label={`Next action for ${t.content}`} placeholder="Next action: the first physical step" value={c.nextAction} onChange={(e) => patch({ nextAction: e.target.value })} />
      )}
      {mode === 'triage' && (
        <div className="sd-controls">
          <Segmented<Decision> label={`Triage ${t.content}`} value={c.decision} onChange={(v) => patch({ decision: v })} options={DECISIONS} />
          {c.decision === 'slot' && <Input type="time" aria-label="Time" value={c.time} onChange={(e) => patch({ time: e.target.value })} />}
          {c.decision === 'delegate' && <Input className="wide" aria-label="Who owns it" placeholder="Who owns it?" value={c.owner} onChange={(e) => patch({ owner: e.target.value })} />}
          {c.decision === 'drop' && <Input className="wide" aria-label="Reason (optional)" placeholder="Why drop it? (optional)" value={c.reason} onChange={(e) => patch({ reason: e.target.value })} />}
        </div>
      )}
    </Group>
  );
}

function ActionsStep({ s, d, set }: P) {
  const suggest = useAction<{ items: string[] }, { suggestions: Suggestion[] }>('post', '/api/shutdown/suggest', (out) => {
    const sg = out?.suggestions ?? [];
    set((x) => ({
      ...x,
      items: x.items.map((it, idx) => {
        const m = sg.find((y) => y.index === idx);
        if (!m || it.nextAction.trim()) return it;
        return { ...it, nextAction: m.nextAction, when: m.when ?? it.when, date: m.date ?? it.date, time: m.time ?? it.time };
      }),
    }));
    toast(sg.length ? `Filled in ${sg.length} next ${sg.length === 1 ? 'action' : 'actions'}. Edit anything that’s off.` : 'No suggestions this time.');
  });
  const setItem = (i: number, p: Partial<DItem>) => set((x) => ({ ...x, items: x.items.map((it, k) => (k === i ? { ...it, ...p } : it)) }));
  const patchCarry = (id: string, p: Partial<DCarry>) => set((x) => ({ ...x, carry: { ...x.carry, [id]: { ...(x.carry[id] ?? blankCarry()), ...p } } }));
  if (!d.items.length && !s.carry.length) return <Empty>Nothing to plan. Continue.</Empty>;
  return (
    <>
      {d.items.length > 0 && (
        <Section
          title="From your brain dump"
          end={s.aiEnabled ? <Button icon="Sparkles" disabled={suggest.isPending} onClick={() => suggest.mutate({ items: d.items.map((i) => i.text) })}>Suggest Next Actions</Button> : undefined}
        >
          {d.items.map((it, i) => (
            <Group pad className="sd-card" key={it.text}>
              <div className="sd-card-title">{it.text}</div>
              <Input aria-label={`Next action for ${it.text}`} placeholder="Next action: the first physical step" value={it.nextAction} onChange={(e) => setItem(i, { nextAction: e.target.value })} />
              <div className="sd-controls">
                <Segmented<When> label={`When for ${it.text}`} value={it.when} options={WHEN.map((w) => (w.value === 'tomorrow' ? { ...w, label: s.planLabel } : w))}
                  onChange={(v) => setItem(i, { when: v, mustDo: v === 'tomorrow' ? it.mustDo : false })} />
                {it.when === 'date' && <Input type="date" aria-label="Date" min={s.date} value={it.date} onChange={(e) => setItem(i, { date: e.target.value, mustDo: it.mustDo && e.target.value === s.planDate })} />}
                {(it.when === 'tomorrow' || it.when === 'date') && <Input type="time" aria-label="Time (optional)" value={it.time} onChange={(e) => setItem(i, { time: e.target.value })} />}
              </div>
            </Group>
          ))}
        </Section>
      )}
      {s.carry.length > 0 && (
        <Section title="Unfinished from today" why="A task carried three times needs a decision, not another day (Masicampo & Baumeister 2011).">
          {s.carry.map((t) => <CarryRow key={t.id} t={t} s={s} c={d.carry[t.id] ?? blankCarry()} patch={(p) => patchCarry(t.id, p)} />)}
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ 3. tomorrow's must-dos
function MustDosStep({ s, d, set, ev }: P) {
  const forced = new Set(s.carry.filter((c) => (c.mustTriage || d.carry[c.id]?.mode === 'triage') && d.carry[c.id]?.decision === 'first').map((c) => c.id));
  const cap = ev?.cap ?? s.cap;
  const total = ev?.mustDoTotal ?? forced.size + d.mustDos.filter((id) => !forced.has(id)).length + d.items.filter((i) => i.mustDo && canMust(i, s.planDate)).length;
  const toggleTask = (id: string) => set((x) => ({ ...x, mustDos: x.mustDos.includes(id) ? x.mustDos.filter((y) => y !== id) : [...x.mustDos, id] }));
  const toggleItem = (i: number) => set((x) => ({ ...x, items: x.items.map((it, k) => (k === i ? { ...it, mustDo: !it.mustDo } : it)) }));
  const newItems = d.items.map((it, i) => ({ it, i })).filter(({ it }) => canMust(it, s.planDate));
  const tasks = s.candidates;
  return (
    <Section title={`${s.planLabel}’s must-dos`} end={<span className={`num ${total > cap ? '' : 'muted'} small`} style={total > cap ? { color: 'var(--amber)' } : undefined}>{total} of {cap}</span>}>
      <Group>
        {newItems.map(({ it, i }) => (
          <Item key={`n:${it.text}`}>
            <Check checked={it.mustDo} onChange={() => toggleItem(i)} label={`Make “${it.text}” a must-do`} />
            <div className="title"><div>{it.text}</div><div className="sub">New · {it.nextAction || 'no next action yet'}</div></div>
          </Item>
        ))}
        {tasks.map((t) => (
          <Item key={t.id}>
            <Check checked={forced.has(t.id) || d.mustDos.includes(t.id)} onChange={() => !forced.has(t.id) && toggleTask(t.id)} label={`Make “${t.content}” a must-do`} />
            <div className="title">
              <div>{t.content}</div>
              <div className="sub">{t.projectName}{t.due ? ` · due ${relDay(t.due)}` : ''}{t.estimateMin ? ` · ${t.estimateMin}m` : ''}</div>
            </div>
            {forced.has(t.id) && <Tag tone="accent">Do First</Tag>}
          </Item>
        ))}
        {!newItems.length && !tasks.length && <Empty>Nothing is due for {s.planLabel.toLowerCase()} yet. Continue.</Empty>}
      </Group>
    </Section>
  );
}

// ------------------------------------------------------------------ 4. glance at tomorrow
function TomorrowStep({ s }: P) {
  const v = s.tomorrowView;
  const sameDay = s.planDate === v.date;
  return (
    <>
      <div>
        <div className="sd-stat">{fmtDayLong(v.date)}</div>
        <p className="sd-sub" style={{ marginTop: 6 }}>
          {v.isOffDay
            ? `It’s your day off. Nothing to prepare.${sameDay ? '' : ` Your next work day is ${s.planLabel}.`}`
            : <>Wake {fmtTime(v.wake)} · <strong>Stop {fmtTime(v.stop)}</strong></>}
        </p>
      </div>
      <Group>
        {v.timeline.map((i) => (
          <Item key={i.id}>
            <span className="sd-tl-time num">{i.allDay ? 'All day' : `${fmtTimeShort(i.start)}–${fmtTime(i.end)}`}</span>
            <div className="title">
              <div className="ellipsis">{i.title}</div>
              {(i.calendarName || i.source === 'fixed') && <div className="sub">{i.calendarName ?? 'Fixed block'}</div>}
            </div>
          </Item>
        ))}
        {!v.timeline.length && <Empty>Nothing on the calendar.</Empty>}
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ 5. deadlines in the next 72 hours
const KIND = { due: 'Due', deadline: 'Deadline', milestone: 'Milestone' } as const;
const AUTO = { 'must-do': 'In your must-dos', carried: 'Carried', triaged: 'Triaged', homework: 'Homework lane' } as const;
const soft = (x: string) => (['Today', 'Tomorrow', 'Yesterday'].includes(x) ? x.toLowerCase() : x);

function DeadlinesStep({ s, d, set, ev }: P) {
  const rows: DeadlineRow[] = ev?.deadlines ?? s.deadlines;
  const decide = (key: string, p: DDecision | null) => set((x) => {
    const decisions = { ...x.decisions };
    if (p) decisions[key] = p; else delete decisions[key];
    return { ...x, decisions };
  });
  if (!rows.length) return <Empty>Nothing is due in the next 72 hours.</Empty>;
  return (
    <div className="stack">
      {rows.map((r) => {
        const dec = d.decisions[r.key];
        const status = r.auto ? '' : (dec?.status ?? '');
        return (
          <Group pad className="sd-card" key={r.key}>
            <div className="row between">
              <div className="grow">
                <div className="sd-card-title">{r.title}</div>
                <div className="sd-sub">{r.where} · {KIND[r.dateKind]} {soft(relDay(r.date))}{r.time ? ` at ${fmtTime(`${r.date}T${r.time}:00`)}` : ''}{r.recurring ? ' · repeats' : ''}</div>
              </div>
              {r.date < s.date && <Tag tone="amber">Overdue</Tag>}
              {r.auto && <Tag tone="green">{AUTO[r.auto]}</Tag>}
            </div>
            {!r.auto && (
              <>
                <div className="sd-controls">
                  <Segmented<string> label={`Plan for ${r.title}`} value={status}
                    options={[{ value: 'covered', label: 'Covered' }, ...(r.taskId ? [{ value: 'moved', label: 'Move' }] : []), { value: 'risk', label: 'Accept the Risk' }]}
                    onChange={(v) => decide(r.key, v === 'covered' ? { key: r.key, status: 'covered' } : v === 'moved' ? { key: r.key, status: 'moved', date: dec?.date ?? s.planDate, time: dec?.time } : { key: r.key, status: 'risk', reason: dec?.reason ?? '' })} />
                  {status === 'moved' && <Input type="date" aria-label="New date" min={s.date} value={dec?.date ?? ''} onChange={(e) => decide(r.key, { ...dec!, date: e.target.value })} />}
                  {status === 'moved' && <Input type="time" aria-label="New time (optional)" value={dec?.time ?? ''} onChange={(e) => decide(r.key, { ...dec!, time: e.target.value || undefined })} />}
                  {status === 'risk' && <Input className="wide" aria-label="Reason" placeholder="Why is it okay to leave this?" value={dec?.reason ?? ''} onChange={(e) => decide(r.key, { ...dec!, reason: e.target.value })} />}
                </div>
                {status === '' && <p className="sd-sub">Covered means you know when and how it gets done.</p>}
              </>
            )}
          </Group>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 6. phone, 7. complete, and any step added in Settings
function PhoneStep({ d, set }: P) {
  return (
    <Button className="sd-phone" size="large" variant={d.phoneOut ? 'default' : 'primary'} icon={d.phoneOut ? 'Check' : 'Smartphone'} onClick={() => set((x) => ({ ...x, phoneOut: !x.phoneOut }))}>
      {d.phoneOut ? 'Phone Is Going Out' : 'Confirm Phone Is Going Out'}
    </Button>
  );
}

function CompleteStep({ s, d, ev, goTo, steps }: P & { goTo: (i: number) => void; steps: RitualStep[] }) {
  const p = buildPayload(d, s);
  const risks = (ev?.deadlines ?? []).filter((r) => r.status === 'risk');
  const line = [
    p.items.length && `${p.items.length} new ${p.items.length === 1 ? 'task' : 'tasks'}`,
    p.carry.length && `${p.carry.length} carried to ${s.planLabel.toLowerCase()}`,
    p.triage.length && `${p.triage.length} triaged`,
    ev && ev.mustDoTotal > 0 && `${ev.mustDoTotal} ${ev.mustDoTotal === 1 ? 'must-do' : 'must-dos'} for ${s.planLabel.toLowerCase()}`,
  ].filter(Boolean).join(' · ');
  const open = (ev?.problems ?? []);
  return (
    <>
      <div className="sd-stat">{line || 'Nothing new to add.'}<small>Lights-out at {fmtTime(s.lightsOut)}</small></div>
      {risks.length > 0 && (
        <Section title="Accepted risks">
          <Group>{risks.map((r) => <Item key={r.key}><div className="title">{r.title}<div className="sub">{r.decision?.reason}</div></div></Item>)}</Group>
        </Section>
      )}
      {open.length > 0 && (
        <Banner tone="amber" icon="TriangleAlert">
          <strong>{open[0].message}</strong>
          {(() => { const at = steps.findIndex((x) => x.id === open[0].step); return at >= 0 ? <> <Button variant="plain" onClick={() => goTo(at)}>Go to That Step</Button></> : null; })()}
        </Banner>
      )}
    </>
  );
}

function GenericStep() {
  return <p className="sd-sub">Do this one, then continue.</p>;
}

// ------------------------------------------------------------------ the flow
function Flow({ s }: { s: ShutdownState }) {
  const [, navigate] = useLocation();
  const [d, setDraft] = useState<Draft>(() => ({ ...emptyDraft(), mustDos: s.mustDosCurrent, ...((s.draft as Partial<Draft> | null) ?? {}) }));
  const [ev, setEv] = useState<Evaluation | null>(null);
  const steps = useMemo(() => resolveSteps(s.steps), [s.steps]);
  const set = (f: (d: Draft) => Draft) => setDraft(f);
  const i = Math.min(Math.max(d.step, 0), steps.length - 1);
  const step = steps[i];
  const last = i === steps.length - 1;

  useEffect(() => { api.post('/api/shutdown/start').catch(() => {}); }, []);

  const payload = useMemo(() => buildPayload(d, s), [d, s.planDate, s.carry]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.post<Evaluation>('/api/shutdown/check', payload).then(setEv).catch(() => {});
      api.put('/api/shutdown/draft', d).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [payload, d]);

  const finish = useAction<typeof payload, unknown>('post', '/api/shutdown/finish', () => { toast('Shutdown logged.'); navigate('/'); });

  const goTo = (n: number) => set((x) => ({ ...x, step: n, items: steps[i].id === 'dump' && n > i ? reconcile(x.dump, x.items) : x.items }));
  const blocking = last ? (ev?.problems ?? []) : (ev?.problems ?? []).filter((p) => p.step === step.id);
  const checking = last && !ev;
  const next = () => {
    if (blocking.length || checking || finish.isPending) return;
    if (last) finish.mutate(payload); else goTo(i + 1);
  };
  const leave = () => { api.put('/api/shutdown/draft', d).catch(() => {}); navigate('/'); };

  const nextRef = useRef(next); nextRef.current = next;
  const leaveRef = useRef(leave); leaveRef.current = leave;
  useHotkey('Mod+Enter', () => nextRef.current(), []);
  useHotkey('Escape', () => { if (!document.querySelector('[role="dialog"]')) leaveRef.current(); }, []);

  const p: P = { s, d, set, ev };
  const body: Record<string, ReactNode> = {
    dump: <DumpStep {...p} />,
    actions: <ActionsStep {...p} />,
    'must-dos': <MustDosStep {...p} />,
    tomorrow: <TomorrowStep {...p} />,
    deadlines: <DeadlinesStep {...p} />,
    phone: <PhoneStep {...p} />,
    complete: <CompleteStep {...p} goTo={goTo} steps={steps} />,
  };
  const content = body[step.id] ?? <GenericStep />;
  // The last step always logs the shutdown; if it's a custom step, the summary comes with it.
  const showSummary = last && step.id !== 'complete';
  const lede = LEDE[step.id] ?? step.why;

  return (
    <Page title="Shutdown" width="narrow" actions={<Button variant="plain" kbd="Esc" onClick={leave}>Leave</Button>}>
      <div className="sd-flow">
        <div className="sd-eyebrow">
          <span className="num">Step {i + 1} of {steps.length}</span>
          <span className="sd-dots" aria-hidden="true">{steps.map((x, k) => <i key={x.id} data-done={k < i} data-cur={k === i} />)}</span>
        </div>
        <h2 className="sd-title">{step.label}</h2>
        {lede && <p className="sd-lede">{lede}</p>}
        {step.why && <div className="sd-why"><Why source={step.source}>{step.why}</Why></div>}
        <div className="sd-body">
          {content}
          {showSummary && <CompleteStep {...p} goTo={goTo} steps={steps} />}
        </div>
        <div className="sd-foot">
          <Button disabled={i === 0} onClick={() => goTo(i - 1)}>Back</Button>
          <span className="msg" role="status">
            {finish.error ? finish.error.message : blocking.length ? blocking[0].message : ''}
          </span>
          <Button variant="primary" size="large" kbd="⌘↩" disabled={blocking.length > 0 || checking || finish.isPending} onClick={next}>
            {last ? 'Shutdown Complete' : 'Continue'}
          </Button>
        </div>
      </div>
    </Page>
  );
}

function ShutdownPage() {
  const [, navigate] = useLocation();
  const q = useApi<ShutdownState>('/api/shutdown/state');
  const s = q.data;
  if (!s) return <Page title="Shutdown" width="narrow"><Empty>Loading…</Empty></Page>;
  if (s.completedAt) {
    return (
      <Page title="Shutdown" width="narrow">
        <div className="sd-flow">
          <h2 className="sd-title">Shutdown is logged for tonight</h2>
          <p className="sd-lede">Finished at {fmtTime(s.completedAt)}. Lights-out is at {fmtTime(s.lightsOut)}.</p>
          <div className="sd-foot"><Button variant="primary" size="large" onClick={() => navigate('/')}>Done</Button></div>
        </div>
      </Page>
    );
  }
  return <Flow s={s} />;
}

// ------------------------------------------------------------------ evening widgets
function Countdown() {
  const day = useDay();
  const now = useNow(15_000);
  const a = day.data?.anchors;
  if (!a) return null;
  const min = Math.ceil((dt(a.lightsOut).toMillis() - now) / 60_000);
  return (
    <Section>
      <Group pad>
        <div className="sd-count num">{min > 0 ? fmtCountdown(min) : '0 min'}</div>
        <div className="sd-count-label">{min > 0 ? `until lights-out at ${fmtTime(a.lightsOut)}` : `Lights-out was at ${fmtTime(a.lightsOut)}`}</div>
        {min > 0 && <p className="sd-quiet">30–60 minutes of something that produces nothing.</p>}
      </Group>
    </Section>
  );
}

function Prompt() {
  const day = useDay();
  const [, navigate] = useLocation();
  if (!day.data || day.data.shutdownAt) return null;
  return (
    <Section>
      <Group pad>
        <div className="sd-prompt">
          <div>
            <div className="sd-card-title">Shutdown isn’t logged yet</div>
            <p className="sd-sub">Write down what’s open so tonight can be rest.</p>
          </div>
          <Button variant="primary" size="large" icon="Moon" onClick={() => navigate('/shutdown')}>Start Shutdown · about 10 minutes</Button>
        </div>
      </Group>
    </Section>
  );
}

export default defineWebModule({
  id: 'shutdown',
  routes: [{ path: '/shutdown', component: ShutdownPage }],
  widgets: { countdown: Countdown, prompt: Prompt },
  commands: [{ id: 'shutdown.start', label: 'Start Shutdown', group: 'Shutdown', run: () => '/shutdown' }],
});
