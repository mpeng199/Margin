import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { api } from '@web/lib/api';
import { useApi, queryClient } from '@web/lib/query';
import { useDay } from '@web/lib/hooks';
import { Section, Group, Item, Button, Check, Segmented, Field, Input, Select, TextArea, Tag, Banner, Empty, Spinner, Why, toast } from '@web/ui';
import { dt, fmtDay, fmtDayLong, fmtDur, fmtTime, fmtTimeShort, relDay } from '@web/lib/format';
import type { AutoStats, DeadlineItem, TriageItem } from '../context';
import type { SlotOption } from '../changes';
import type { ReviewStep } from '../steps';
import type { Decisions, Draft, Priority, Scores, TriageChoice, TriageDecision } from '../types';
import './review.css';

// ---------------------------------------------------------------------------------------------- types

interface Current {
  weekStart: string; reviewDate: string; today: string; due: boolean; completed: boolean; durationMin: number;
  lookback: { from: string; to: string }; ahead: { from: string; to: string };
  draft: Draft; steps: ReviewStep[];
}
interface Proj {
  id: string; name: string; status: string; isSchool?: boolean; sizeMin?: number; weeklyBudgetMin?: number;
  maintenance?: { action: string; capMin: number; told: string } | null; restartDate?: string | null;
}
interface Firing { id: string; ruleName: string; detail?: string | null; why?: string; source?: string }
interface Ctx {
  today: string; stats: AutoStats; previous: { weekStart: string; energy: number; dread: number; effective: number } | null;
  triage: TriageItem[]; firstDay: unknown;
  options: { projects: { id: string; name: string }[]; tasks: { id: string; content: string; projectName?: string }[] };
  projects: { available: boolean; list: Proj[]; wipLimit: number; active: number; proposed: Proj[]; tradeOffs: Proj[]; phase: { allowed: boolean; reason?: string } | null };
  checkins: { id: string; name: string; owner: string | null; projectName: string | null; due: string | null }[];
  deadlines: DeadlineItem[];
  required: { id: string; label: string }[];
  rules: Firing[];
  offday: { available: boolean; date: string | null; tasks: { id: string; content: string; projectName?: string; recurring?: boolean }[]; events: { title: string; start: string; end: string; allDay: boolean; calendar: string }[] };
  ai: boolean;
  available: Record<string, boolean>;
}
/** The part of the draft the page edits locally; everything else the server owns and the page only reads. */
interface Local {
  step: number; scores: Scores; priorities: Priority[]; notes: string; summary: string;
  triage: Record<string, TriageDecision>; deadlines: Record<string, string>; offday: Decisions['offday'];
}
interface Ctl {
  cur: Current; c: Ctx; L: Local; step: ReviewStep; steps: ReviewStep[];
  update: (p: Partial<Local>) => void; flush: () => Promise<void>; refresh: () => void;
}

const blankPriority = (): Priority => ({ text: '', ref: null, block: false, slot: null });
const three = (ps: Priority[]) => [0, 1, 2].map((i) => ps[i] ?? blankPriority());
const msg = (e: unknown) => (e as Error)?.message ?? 'Something went wrong.';
const STATUS: Record<string, string> = { core: 'Core', maintain: 'Maintain', pause: 'Paused', drop: 'Dropped', proposed: 'Proposed' };
const slotLabel = (s: { date?: string; start: string; end: string }) => `${fmtDay((s.date ?? s.start.slice(0, 10)))} · ${fmtTimeShort(s.start)}–${fmtTime(s.end)}`;
const Err = ({ children }: { children?: ReactNode }) => (children ? <p className="rv-err" role="alert">{children}</p> : null);
const stepNo = (steps: ReviewStep[], panel: string) => steps.findIndex((s) => s.panel === panel) + 1;

// ---------------------------------------------------------------------------------------------- page

function ReviewPage() {
  const cur = useApi<Current>('/api/review/current');
  const ctx = useApi<Ctx>('/api/review/context');
  if (!cur.data || !ctx.data) return <Page title="Weekly review" width="narrow"><div className="empty"><Spinner /></div></Page>;
  if (cur.data.completed) return <Finished cur={cur.data} />;
  return <Wizard key={cur.data.weekStart} cur={cur.data} c={ctx.data} />;
}

function Finished({ cur }: { cur: Current }) {
  const [, navigate] = useLocation();
  const d = cur.draft;
  return (
    <Page title="Weekly review" subtitle={`Week of ${fmtDay(cur.weekStart)}`} width="narrow">
      <Section title="This week’s review is finished" footer={<span className="why-line">The next review opens on {fmtDayLong(nextReview(cur))}.</span>}>
        <Group pad>
          <pre className="rv-summary">{d.summary}</pre>
          {d.changeSetId && <div style={{ marginTop: 12 }}><Button variant="primary" onClick={() => navigate(`/changes/${d.changeSetId}`)}>Open Changes</Button></div>}
        </Group>
      </Section>
    </Page>
  );
}
const nextReview = (cur: Current) => dt(cur.reviewDate).plus({ days: 7 }).toISODate()!;

function Wizard({ cur, c }: { cur: Current; c: Ctx }) {
  const [, navigate] = useLocation();
  const steps = cur.steps;
  const d0 = cur.draft;
  const [L, setL] = useState<Local>(() => ({
    step: Math.min(d0.step, steps.length - 1), scores: d0.scores, priorities: three(d0.priorities), notes: d0.notes, summary: d0.summary,
    triage: d0.decisions.triage, deadlines: d0.decisions.deadlines, offday: d0.decisions.offday,
  }));
  const [save, setSave] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveErr, setSaveErr] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [finishErr, setFinishErr] = useState('');
  const pending = useRef<Record<string, any>>({});
  const timer = useRef<number | undefined>(undefined);
  const head = useRef<HTMLHeadingElement>(null);

  const flush = async () => {
    clearTimeout(timer.current);
    const p = pending.current;
    if (!Object.keys(p).length) return;
    pending.current = {};
    try {
      const out = await api.put<Draft>('/api/review/draft', p);
      if (p.priorities) {
        // The server picks the slots; take them back without queueing another save.
        setL((l) => ({ ...l, priorities: l.priorities.map((x, i) => (out.priorities[i]?.text === x.text && out.priorities[i].block === x.block ? { ...x, slot: out.priorities[i].slot } : x)) }));
        void queryClient.invalidateQueries({ queryKey: ['/api/review/slots'] });
      }
      setSaveErr('');
      setSave(Object.keys(pending.current).length ? 'saving' : 'saved');
    } catch (e) { setSave('error'); setSaveErr(msg(e)); }
  };
  const queue = (patch: Record<string, any>) => {
    const { decisions, ...rest } = patch;
    pending.current = { ...pending.current, ...rest, ...(decisions ? { decisions: { ...pending.current.decisions, ...decisions } } : {}) };
    setSave('saving');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };
  useEffect(() => () => { void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (p: Partial<Local>) => {
    setL((l) => ({ ...l, ...p }));
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'triage' || k === 'deadlines' || k === 'offday') out.decisions = { ...out.decisions, [k]: v };
      else out[k] = v;
    }
    queue(out);
  };
  const refresh = () => void queryClient.invalidateQueries();

  const step = steps[L.step];
  const last = L.step === steps.length - 1;
  const go = (n: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, n));
    setL((l) => ({ ...l, step: next }));
    queue({ step: next, done: { [step.id]: true } });
    void flush();
    document.querySelector('.content')?.scrollTo({ top: 0 });
  };
  useEffect(() => { head.current?.focus({ preventScroll: true }); }, [L.step]);

  // Reasons Finish is off. The server checks the same things and says so too.
  const blockers: string[] = [];
  if (L.scores.energy == null || L.scores.dread == null || L.scores.effective == null) blockers.push(`Rate energy, dread and effective (step ${stepNo(steps, 'score')}).`);
  const openRequired = c.required.filter((r) => !d0.decisions.required[r.id]);
  if (openRequired.length) blockers.push(`${openRequired.map((r) => r.label).join(' and ')} must be done before the review can finish (step ${stepNo(steps, 'rules')}).`);
  const t0 = cur.today;
  const badTriage = Object.values(L.triage).filter((t) => (t.decision === 'move' && !(t.date && t.date > t0)) || (t.decision === 'delegate' && !t.owner?.trim())).length;
  if (badTriage) blockers.push(`${badTriage} carry-over decision${badTriage === 1 ? ' needs' : 's need'} a date after today or an owner (step ${stepNo(steps, 'triage')}).`);

  const finish = async () => {
    setFinishing(true); setFinishErr('');
    try {
      await flush();
      const out = await api.post<{ changeSetId: string | null; changes: number }>('/api/review/finish');
      void queryClient.invalidateQueries();
      if (out.changeSetId) navigate(`/changes/${out.changeSetId}`);
      else { toast('Review finished. Nothing needed to be written to Todoist or Calendar.'); navigate('/today'); }
    } catch (e) { setFinishErr(msg(e)); setFinishing(false); }
  };

  const ctl: Ctl = { cur, c, L, step, steps, update, flush, refresh };
  const panel: Record<string, ReactNode> = {
    score: <ScorePanel ctl={ctl} />, triage: <TriagePanel ctl={ctl} />, priorities: <PrioritiesPanel ctl={ctl} />, wip: <WipPanel ctl={ctl} />,
    checkins: <CheckinsPanel ctl={ctl} />, deadlines: <DeadlinesPanel ctl={ctl} />, rules: <RulesPanel ctl={ctl} />, proposed: <ProposedPanel ctl={ctl} />,
    offday: <OffdayPanel ctl={ctl} />, generic: <GenericPanel ctl={ctl} />,
  };

  return (
    <Page title="Weekly review" subtitle={`Week of ${fmtDay(cur.weekStart)} · about ${cur.durationMin} minutes`} width="narrow">
      <header className="rv-head">
        <div className="rv-eyebrow"><span className="num">Step {L.step + 1} of {steps.length}</span></div>
        <h2 ref={head} tabIndex={-1}>{step.label}</h2>
        {step.why && <p className="small muted"><Why source={step.source ?? undefined}>{step.why}</Why></p>}
        <nav className="rv-dots" aria-label="Review steps">
          {steps.map((s, i) => (
            <button key={s.id} type="button" aria-label={`Step ${i + 1}: ${s.label}`} title={s.label} aria-current={i === L.step ? 'step' : undefined}
              data-done={!!d0.done[s.id] || i < L.step} onClick={() => go(i)} />
          ))}
        </nav>
      </header>

      {panel[step.panel] ?? panel.generic}
      {last && <SummaryBlock ctl={ctl} />}

      {blockers.length > 0 && (last || step.panel === 'rules') && (
        <ul className="rv-blockers" aria-label="Why Finish is off">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      <Err>{finishErr}</Err>

      <div className="rv-actions">
        <Button onClick={() => go(L.step - 1)} disabled={L.step === 0} icon="ChevronLeft">Back</Button>
        <span className="rv-save" role="status">{save === 'saving' ? 'Saving…' : save === 'error' ? `Not saved. ${saveErr}` : 'Draft saved'}</span>
        {last
          ? <Button variant="primary" size="large" onClick={finish} disabled={blockers.length > 0 || finishing || save === 'error'} title={blockers[0]}>Finish Review</Button>
          : <Button variant="primary" onClick={() => go(L.step + 1)}>Continue</Button>}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------- 1 score

function Slider({ label, hint, value, last, ends, onChange, extra }: { label: string; hint: string; value: number | null; last?: number; ends: [string, string]; onChange: (v: number) => void; extra?: ReactNode }) {
  return (
    <Item className="rv-stack">
      <div><strong>{label}</strong> <span className="muted small">{hint}</span></div>
      <div className="rv-slider" data-unset={value == null}>
        <input type="range" min={0} max={10} step={1} value={value ?? 5} aria-label={`${label}, 0 to 10`}
          onChange={(e) => onChange(Number(e.target.value))} onClick={(e) => onChange(Number(e.currentTarget.value))} />
        <span className="rv-ends"><span>{ends[0]}</span><span>{ends[1]}</span></span>
        <span className="rv-note">{last != null ? `Last review: ${last}` : ''}</span>
        <span className="rv-value num">{value == null ? 'Not rated' : value}</span>
      </div>
      {extra}
    </Item>
  );
}

function ScorePanel({ ctl: { c, cur, L, update } }: { ctl: Ctl }) {
  const s = c.stats;
  const set = (k: keyof Scores) => (v: number) => update({ scores: { ...L.scores, [k]: v } });
  const prev = c.previous;
  return (
    <>
      <Section title="Your three ratings">
        <Group>
          <Slider label="Energy" hint="How much was in the tank this week?" value={L.scores.energy} last={prev?.energy} ends={['Empty', 'Full']} onChange={set('energy')} />
          <Slider label="Dread or cynicism" hint="How much did school and obligations weigh on you?" value={L.scores.dread} last={prev?.dread} ends={['None', 'Constant']} onChange={set('dread')}
            extra={<p className="rv-note"><Why source="Bianchi 2021">Burnout overlaps heavily with depression.</Why> If this stays high week after week, <Link href="/help">Get help</Link> has people to talk to.</p>} />
          <Slider label="I’m effective" hint="How much did your work this week feel like it counted?" value={L.scores.effective} last={prev?.effective} ends={['Not at all', 'Very']} onChange={set('effective')} />
        </Group>
      </Section>
      <Section title="Measured, not scored" why={<Why>{fmtDay(cur.lookback.from)} to {fmtDay(cur.lookback.to)}</Why>}>
        <Group>
          <Item>
            <div className="title">Sleep</div>
            <span className="meta num">
              {s.sleepAvgMin != null ? `${fmtDur(s.sleepAvgMin)} average over ${s.sleepNights} night${s.sleepNights === 1 ? '' : 's'} · target ${fmtDur(s.sleepTargetMin)}` : 'No sleep check-ins in this window'}
            </span>
          </Item>
          <Item>
            <div className="title">Stop</div>
            <span className="meta">{s.stopBreaks === 0 ? 'Held every day' : `Broken ${s.stopBreaks} time${s.stopBreaks === 1 ? '' : 's'} on ${s.breakDays} day${s.breakDays === 1 ? '' : 's'}`}</span>
          </Item>
          {s.shutdownDays != null && <Item><div className="title">Shutdown</div><span className="meta num">Completed on {s.shutdownDays} of {s.days} days</span></Item>}
        </Group>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 2 triage

function TriagePanel({ ctl: { c, cur, L, update } }: { ctl: Ctl }) {
  const tomorrow = dt(cur.today).plus({ days: 1 }).toISODate()!;
  const first = typeof c.firstDay === 'string' ? c.firstDay : tomorrow;
  const set = (id: string, t: TriageDecision | null) => {
    const next = { ...L.triage };
    if (t) next[id] = t; else delete next[id];
    update({ triage: next });
  };
  const decided = c.triage.filter((t) => L.triage[t.id]).length;
  if (!c.triage.length) return <Section><Group><Empty>Nothing was carried over this week.</Empty></Group></Section>;
  return (
    <Section title={`${c.triage.length} carried over`} why={<Why>{decided} decided</Why>}>
      <Group>
        {c.triage.map((t) => {
          const d = L.triage[t.id];
          return (
            <Item key={t.id} className="rv-stack">
              <div className="row">
                <div className="title">
                  <div>{t.content}</div>
                  <div className="sub">{[t.projectName, `carried ${t.carryCount} time${t.carryCount === 1 ? '' : 's'}`, t.due ? `due ${relDay(t.due)}` : null, t.owner ? `owner ${t.owner}` : null].filter(Boolean).join(' · ')}</div>
                </div>
                {t.queued && !d && <Tag tone="amber">Needs a decision</Tag>}
                {d && <Button variant="plain" onClick={() => set(t.id, null)}>Clear</Button>}
              </div>
              <div className="row rv-wrap">
                <Segmented<TriageChoice | 'none'> label={`Decision for ${t.content}`} value={d?.decision ?? 'none'}
                  options={[{ value: 'move', label: 'Move' }, { value: 'first', label: 'Do First' }, { value: 'delegate', label: 'Delegate' }, { value: 'drop', label: 'Drop' }]}
                  onChange={(v) => { if (v !== 'none') set(t.id, { decision: v, ...(v === 'move' ? { date: first } : {}) }); }} />
                {d?.decision === 'move' && <Input type="date" aria-label="Move to" min={tomorrow} value={d.date ?? ''} onChange={(e) => set(t.id, { ...d, date: e.target.value })} />}
                {d?.decision === 'delegate' && <Input aria-label="Owner" placeholder="Who owns this?" value={d.owner ?? ''} onChange={(e) => set(t.id, { ...d, owner: e.target.value })} />}
                {d?.decision === 'drop' && <Input aria-label="Reason" placeholder="Reason (optional)" value={d.reason ?? ''} onChange={(e) => set(t.id, { ...d, reason: e.target.value })} />}
              </div>
              {d?.decision === 'first' && <p className="rv-note">Becomes the first thing on {fmtDay(first)}.</p>}
              {d?.decision === 'drop' && <p className="rv-note">Closes the task in Todoist. Nothing is deleted, and you apply it from Changes.</p>}
              {d?.decision === 'move' && !(d.date && d.date > cur.today) && <p className="rv-err">Pick a date after today.</p>}
              {d?.decision === 'delegate' && !d.owner?.trim() && <p className="rv-err">Name who owns it.</p>}
            </Item>
          );
        })}
      </Group>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- 3 priorities

function PrioritiesPanel({ ctl: { c, L, update } }: { ctl: Ctl }) {
  const slots = useApi<SlotOption[]>('/api/review/slots');
  const ps = three(L.priorities);
  const set = (i: number, patch: Partial<Priority>) => update({ priorities: ps.map((p, n) => (n === i ? { ...p, ...patch } : p)) });
  const refValue = (p: Priority) => (p.ref ? `${p.ref.type}:${p.ref.id}` : '');
  return (
    <Section title="Next week" why={<Why>At most three</Why>}>
      <Group>
        {ps.map((p, i) => {
          const options = [...(p.slot ? [{ ...p.slot, date: p.slot.start.slice(0, 10) }] : []), ...(slots.data ?? []).filter((o) => o.start !== p.slot?.start)];
          return (
            <Item key={i} className="rv-stack">
              <Field label={`Priority ${i + 1}`} hint={i === 0 ? 'Say what you will do and when, not just the topic.' : undefined}>
                <Input value={p.text} maxLength={200} placeholder={i === 0 ? 'e.g. Draft the lab report intro on Tuesday after school' : ''} onChange={(e) => set(i, { text: e.target.value })} />
              </Field>
              <div className="row rv-wrap">
                <Select aria-label={`Link priority ${i + 1} to a project or task`} value={refValue(p)} className="rv-slot"
                  onChange={(e) => { const [type, ...id] = e.target.value.split(':'); set(i, { ref: e.target.value ? { type: type as 'project' | 'task', id: id.join(':') } : null }); }}>
                  <option value="">Not linked</option>
                  <optgroup label="Projects">{c.options.projects.map((o) => <option key={o.id} value={`project:${o.id}`}>{o.name}</option>)}</optgroup>
                  <optgroup label="Tasks">{c.options.tasks.map((o) => <option key={o.id} value={`task:${o.id}`}>{o.content}</option>)}</optgroup>
                </Select>
                <Button variant={p.block ? 'primary' : 'default'} onClick={() => set(i, { block: !p.block, slot: p.block ? null : p.slot })} disabled={!p.text.trim()} aria-pressed={p.block}>
                  {p.block ? 'Deep-Work Block On' : 'Propose a Block'}
                </Button>
              </div>
              {p.block && (
                options.length
                  ? (
                    <Select aria-label={`Block for priority ${i + 1}`} value={p.slot?.start ?? ''} onChange={(e) => { const o = options.find((x) => x.start === e.target.value); if (o) set(i, { slot: { start: o.start, end: o.end } }); }}>
                      {!p.slot && <option value="">Choose a time</option>}
                      {options.map((o) => <option key={o.start} value={o.start}>{slotLabel(o)}</option>)}
                    </Select>
                  )
                  : <p className="rv-note">No gap next week fits a block before the stop. The priority stays without one.</p>
              )}
            </Item>
          );
        })}
      </Group>
      <p className="rv-note" style={{ marginTop: 8 }}>Blocks are only proposed. They reach your calendar when you apply the change set.</p>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- 4 wip + statuses

function WipPanel({ ctl: { c, refresh } }: { ctl: Ctl }) {
  const p = c.projects;
  if (!p.available) return <Section><Group><Empty>Projects are turned off, so there is nothing to check.</Empty></Group></Section>;
  const over = p.active > p.wipLimit;
  return (
    <>
      <Section title="Work in progress">
        <Group pad>
          <div className="row between">
            <span><strong className="num">{p.active} of {p.wipLimit}</strong> <span className="muted">non-school projects are active</span></span>
            {over && <Tag tone="amber">Over the limit</Tag>}
          </div>
          {over && <p className="small" style={{ marginTop: 8, color: 'var(--amber)' }}>Pause or drop one before the week starts, or change the limit in Settings.</p>}
          {p.phase && !p.phase.allowed && <p className="small muted" style={{ marginTop: 8 }}>{p.phase.reason ?? 'Nothing gets added back yet.'}</p>}
        </Group>
      </Section>
      <Section title="Statuses">
        <Group>
          {p.list.length ? p.list.map((x) => <ProjectRow key={x.id} p={x} refresh={refresh} />) : <Empty>No projects yet.</Empty>}
        </Group>
      </Section>
    </>
  );
}

function ProjectRow({ p, refresh }: { p: Proj; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<'core' | 'maintain' | 'pause' | 'drop'>('core');
  const [restart, setRestart] = useState(p.restartDate ?? '');
  const [m, setM] = useState({ action: p.maintenance?.action ?? '', capMin: String(p.maintenance?.capMin ?? 60), told: p.maintenance?.told ?? '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true); setErr('');
    try {
      await api.post('/api/review/project-status', {
        projectId: p.id, status: to,
        ...(to === 'pause' && restart ? { restartDate: restart } : {}),
        ...(to === 'maintain' ? { maintenance: { action: m.action, capMin: Number(m.capMin), told: m.told } } : {}),
      });
      setOpen(false); refresh();
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Item className="rv-stack">
      <div className="row">
        <div className="title">{p.name}{p.isSchool ? <span className="faint"> · School</span> : null}</div>
        <Tag tone={p.status === 'core' ? 'accent' : undefined}>{STATUS[p.status] ?? p.status}</Tag>
        <Button variant="plain" onClick={() => { setOpen(!open); setErr(''); setTo(p.status === 'core' ? 'maintain' : 'core'); }} aria-expanded={open}>{open ? 'Cancel' : 'Change…'}</Button>
      </div>
      {open && (
        <>
          <Segmented label={`New status for ${p.name}`} value={to} options={[{ value: 'core', label: 'Core' }, { value: 'maintain', label: 'Maintain' }, { value: 'pause', label: 'Pause' }, { value: 'drop', label: 'Drop' }]} onChange={setTo} />
          {to === 'maintain' && (
            <div className="rv-grid">
              <Field label="Smallest weekly action"><Input value={m.action} onChange={(e) => setM({ ...m, action: e.target.value })} /></Field>
              <Field label="Most minutes per week"><Input type="number" min={1} value={m.capMin} onChange={(e) => setM({ ...m, capMin: e.target.value })} /></Field>
              <Field label="Who has been told?"><Input value={m.told} onChange={(e) => setM({ ...m, told: e.target.value })} /></Field>
            </div>
          )}
          {to === 'pause' && <Field label="Restart date" hint="When will you decide whether to bring this back?"><Input type="date" value={restart} onChange={(e) => setRestart(e.target.value)} /></Field>}
          {to === 'drop' && <p className="rv-note">Archives the project tab. Open tasks go into a change set to close them; nothing is deleted.</p>}
          <Err>{err}</Err>
          <div><Button variant="primary" onClick={apply} disabled={busy}>Apply Change</Button></div>
        </>
      )}
    </Item>
  );
}

// ---------------------------------------------------------------------------------------------- 5 check-ins

function CheckinsPanel({ ctl: { c, cur, refresh } }: { ctl: Ctl }) {
  const logged = cur.draft.decisions.checkins;
  const dueIds = new Set(c.checkins.map((x) => x.id));
  const extra = Object.entries(logged).filter(([id]) => !dueIds.has(id));
  if (!c.available.delegation) return <Section><Group><Empty>Delegation is turned off.</Empty></Group></Section>;
  if (!c.checkins.length && !extra.length) return <Section><Group><Empty>No owner check-ins are due.</Empty></Group></Section>;
  return (
    <Section title="Due this week">
      <Group>
        {c.checkins.map((x) => <CheckinRow key={x.id} f={x} done={logged[x.id]} refresh={refresh} />)}
        {extra.map(([id, note]) => <Item key={id} className="rv-stack"><div className="row"><div className="title">Logged</div><Tag tone="green">Logged</Tag></div><p className="small muted">{note}</p></Item>)}
      </Group>
    </Section>
  );
}
function CheckinRow({ f, done, refresh }: { f: Ctx['checkins'][number]; done?: string; refresh: () => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const log = async () => {
    setBusy(true); setErr('');
    try { await api.post('/api/review/checkin', { functionId: f.id, note }); refresh(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Item className="rv-stack">
      <div className="row">
        <div className="title">
          <div>{f.name}</div>
          <div className="sub">{[f.owner ? `Owner ${f.owner}` : null, f.projectName, f.due ? `due ${relDay(f.due)}` : null].filter(Boolean).join(' · ')}</div>
        </div>
        {done && <Tag tone="green">Logged</Tag>}
      </div>
      {done
        ? <p className="small muted">{done}</p>
        : (
          <>
            <TextArea rows={2} aria-label={`Check-in note for ${f.name}`} placeholder="What did you hear? What did you decide?" value={note} onChange={(e) => setNote(e.target.value)} />
            <Err>{err}</Err>
            <div><Button onClick={log} disabled={!note.trim() || busy}>Log Check-in</Button></div>
          </>
        )}
    </Item>
  );
}

// ---------------------------------------------------------------------------------------------- 6 deadlines

function DeadlinesPanel({ ctl: { c, L, update } }: { ctl: Ctl }) {
  const unplanned = (x: DeadlineItem) => x.needsPlan && !x.planned && !L.deadlines[x.key]?.trim();
  const n = c.deadlines.filter(unplanned).length;
  if (!c.deadlines.length) return <Section><Group><Empty>No deadlines or due dates in the next three weeks.</Empty></Group></Section>;
  return (
    <Section title="Next three weeks" why={<Why>{n ? `${n} without a plan` : 'Every one has a plan'}</Why>}>
      <Group>
        {c.deadlines.map((x) => (
          <Item key={x.key} className="rv-stack">
            <div className="row">
              <div className="title"><div>{x.title}</div><div className="sub">{[relDay(x.date), x.detail].filter(Boolean).join(' · ')}</div></div>
              {unplanned(x) ? <Tag tone="amber">No plan</Tag> : x.planned ? <Tag>Work time set</Tag> : L.deadlines[x.key]?.trim() ? <Tag tone="green">Planned</Tag> : null}
            </div>
            {x.needsPlan && !x.planned && (
              <Input aria-label={`When will you work on ${x.title}?`} placeholder="When will you work on this?" value={L.deadlines[x.key] ?? ''} maxLength={300}
                onChange={(e) => update({ deadlines: { ...L.deadlines, [x.key]: e.target.value } })} />
            )}
          </Item>
        ))}
      </Group>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- 7 rule outcomes

function RulesPanel({ ctl: { c, cur, refresh } }: { ctl: Ctl }) {
  const done = cur.draft.decisions.required;
  return (
    <>
      <Section title="Rules that fired">
        <Group>
          {c.rules.length
            ? c.rules.map((f) => (
              <Item key={f.id} className="rv-stack">
                <div className="title">{f.ruleName}</div>
                {f.detail && <div className="sub">{f.detail}</div>}
                {f.why && <span className="why-line">{f.why}{f.source ? ` (${f.source})` : ''}</span>}
              </Item>
            ))
            : <Empty>No rules have fired.</Empty>}
        </Group>
      </Section>
      {c.required.length > 0 && (
        <Section title="Required before you finish" why={<Why>{c.required.filter((r) => !done[r.id]).length} open</Why>}>
          <Group>{c.required.map((r) => <RequiredRow key={r.id} r={r} done={done[r.id]?.how} maintain={c.projects.list.filter((p) => p.status === 'maintain')} refresh={refresh} />)}</Group>
        </Section>
      )}
    </>
  );
}
function RequiredRow({ r, done, maintain, refresh }: { r: { id: string; label: string }; done?: string; maintain: Proj[]; refresh: () => void }) {
  const [how, setHow] = useState('');
  const [pid, setPid] = useState('');
  const [status, setStatus] = useState<'pause' | 'drop'>('pause');
  const [restart, setRestart] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = r.id === 'remove_maintain' && maintain.length > 0;
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/api/review/required/${r.id}`, { how, ...(pick ? { projectId: pid, status, ...(status === 'pause' && restart ? { restartDate: restart } : {}) } : {}) });
      refresh();
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <Item className="rv-stack">
      <div className="row"><div className="title">{r.label}</div>{done ? <Tag tone="green">Done</Tag> : <Tag tone="amber">Open</Tag>}</div>
      {done ? <p className="small muted">{done}</p> : (
        <>
          {pick ? (
            <div className="rv-grid">
              <Field label="Maintain project to remove"><Select value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Choose one</option>{maintain.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
              <Field label="Then"><Segmented label="Pause or drop" value={status} options={[{ value: 'pause', label: 'Pause' }, { value: 'drop', label: 'Drop' }]} onChange={setStatus} /></Field>
              {status === 'pause' && <Field label="Restart date"><Input type="date" value={restart} onChange={(e) => setRestart(e.target.value)} /></Field>}
            </div>
          ) : (
            <Input aria-label={`How did you handle: ${r.label}`} placeholder="What did you do?" value={how} onChange={(e) => setHow(e.target.value)} />
          )}
          <Err>{err}</Err>
          <div><Button onClick={submit} disabled={busy || (pick ? !pid : !how.trim())}>Mark Done</Button></div>
        </>
      )}
    </Item>
  );
}

// ---------------------------------------------------------------------------------------------- 8 proposed

function ProposedPanel({ ctl: { c, cur, refresh } }: { ctl: Ctl }) {
  const p = c.projects;
  const decided = Object.entries(cur.draft.decisions.proposed);
  if (!p.available) return <Section><Group><Empty>Projects are turned off.</Empty></Group></Section>;
  const nameOf = (id: string) => cur.draft.decisions.projectChanges.find((x) => x.projectId === id)?.name ?? p.proposed.find((x) => x.id === id)?.name ?? 'Commitment';
  const gate = p.phase && !p.phase.allowed ? (p.phase.reason ?? 'Nothing gets added back yet.') : null;
  return (
    <>
      {gate && <Banner tone="amber" icon="Lock" why="A new commitment waits until the load has come down (Panagioti 2017).">{gate}</Banner>}
      <Section title="Proposed commitments" why={<Why>Yes needs a no</Why>}>
        <Group>
          {p.proposed.length
            ? p.proposed.map((x) => <ProposedRow key={x.id} p={x} tradeOffs={p.tradeOffs} locked={!!gate} left={cur.draft.decisions.proposed[x.id]?.action === 'later'} refresh={refresh} />)
            : <Empty>Nothing is waiting for a decision.</Empty>}
        </Group>
      </Section>
      {decided.some(([, v]) => v.action === 'activate') && (
        <Section title="Decided this week">
          <Group>{decided.filter(([, v]) => v.action === 'activate').map(([id]) => <Item key={id}><div className="title">{nameOf(id)}</div><Tag tone="green">Activated</Tag></Item>)}</Group>
        </Section>
      )}
    </>
  );
}
function ProposedRow({ p, tradeOffs, locked, left, refresh }: { p: Proj; tradeOffs: Proj[]; locked: boolean; left: boolean; refresh: () => void }) {
  const [give, setGive] = useState('');
  const [how, setHow] = useState<'pause' | 'drop'>('pause');
  const [restart, setRestart] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (action: 'activate' | 'later') => {
    setBusy(true); setErr('');
    try {
      await api.post(`/api/review/proposed/${p.id}`, action === 'later' ? { action } : { action, tradeOffId: give, tradeOffStatus: how, ...(how === 'pause' && restart ? { restartDate: restart } : {}) });
      refresh();
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const size = (x: Proj) => (x.weeklyBudgetMin ? `${fmtDur(x.weeklyBudgetMin)} a week` : x.sizeMin ? fmtDur(x.sizeMin) : '');
  return (
    <Item className="rv-stack">
      <div className="row"><div className="title"><div>{p.name}</div>{size(p) && <div className="sub">{size(p)}</div>}</div>{left && <Tag>Left proposed</Tag>}</div>
      <div className="rv-grid">
        <Field label="To start this, give up"><Select value={give} onChange={(e) => setGive(e.target.value)} disabled={locked}>
          <option value="">Choose something of equal size</option>
          {tradeOffs.map((t) => <option key={t.id} value={t.id}>{t.name}{size(t) ? ` · ${size(t)}` : ''}</option>)}
        </Select></Field>
        <Field label="By"><Segmented label="Pause or drop" value={how} options={[{ value: 'pause', label: 'Pausing' }, { value: 'drop', label: 'Dropping' }]} onChange={setHow} /></Field>
        {how === 'pause' && <Field label="Restart date"><Input type="date" value={restart} onChange={(e) => setRestart(e.target.value)} /></Field>}
      </div>
      <Err>{err}</Err>
      <div className="row">
        <Button variant="primary" onClick={() => decide('activate')} disabled={busy || locked || !give}>Activate</Button>
        <Button onClick={() => decide('later')} disabled={busy || left}>Keep Proposed</Button>
      </div>
    </Item>
  );
}

// ---------------------------------------------------------------------------------------------- 9 off-day

function OffdayPanel({ ctl: { c, cur, L, update } }: { ctl: Ctl }) {
  const o = c.offday;
  if (!o.date) return <Section><Group><Empty>No off-day falls in the next seven days. Set your off-day in Settings.</Empty></Group></Section>;
  const date = o.date;
  const tomorrow = dt(cur.today).plus({ days: 1 }).toISODate()!;
  const confirmed = L.offday.confirmed && L.offday.date === date;
  return (
    <>
      <Section title={fmtDayLong(date)}>
        <Group>
          <Item>
            <div className="title">{confirmed ? 'Confirmed as your next off-day' : 'Keep this day clear of work?'}</div>
            <Check checked={confirmed} label="Confirm this off-day" onChange={(v) => update({ offday: { ...L.offday, date, confirmed: v } })} />
          </Item>
        </Group>
      </Section>
      <Section title="Still planned on it">
        <Group>
          {o.tasks.length ? o.tasks.map((t) => (
            <Item key={t.id} className="rv-stack">
              <div className="row">
                <div className="title"><div>{t.content}</div>{t.projectName && <div className="sub">{t.projectName}</div>}</div>
                {t.recurring && <Tag>Repeats</Tag>}
              </div>
              <div className="row">
                <Input type="date" aria-label={`Move ${t.content} to`} min={tomorrow} value={L.offday.moves[t.id] ?? ''}
                  onChange={(e) => { const moves = { ...L.offday.moves }; if (e.target.value) moves[t.id] = e.target.value; else delete moves[t.id]; update({ offday: { ...L.offday, date, moves } }); }} />
                <span className="rv-note">{L.offday.moves[t.id] ? `Moves to ${fmtDay(L.offday.moves[t.id])}` : 'Pick a date to move it off the day'}</span>
              </div>
            </Item>
          )) : <Empty>No tasks are planned for this day.</Empty>}
          {o.events.map((e, i) => (
            <Item key={i}><div className="title"><div>{e.title}</div><div className="sub">{e.allDay ? 'All day' : `${fmtTimeShort(e.start)}–${fmtTime(e.end)}`} · {e.calendar}</div></div></Item>
          ))}
        </Group>
      </Section>
    </>
  );
}

function GenericPanel({ ctl: { step, cur } }: { ctl: Ctl }) {
  const [done, setDone] = useState(!!cur.draft.done[step.id]);
  return (
    <Section>
      <Group><Item><div className="title">{step.label}</div><Check checked={done} label={`${step.label} is done`} onChange={(v) => { setDone(v); void api.put('/api/review/draft', { done: { [step.id]: v } }); }} /></Item></Group>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- summary (last step)

function SummaryBlock({ ctl: { c, cur, L, update, flush } }: { ctl: Ctl }) {
  const [res, setRes] = useState<{ text: string; source: 'claude' | 'margin'; changeSetId: string | null; aiError: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true); setErr('');
    try {
      await flush();
      const out = await api.post<NonNullable<typeof res>>('/api/review/summary');
      setRes(out);
      if (out.source === 'claude') update({ summary: out.text });
    } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (!c.ai) void run(); }, [c.ai]); // eslint-disable-line react-hooks/exhaustive-deps
  const source = res?.source ?? cur.draft.summarySource;
  const aiText = source === 'claude';
  return (
    <>
      <Section title="Notes" why={<Why>Optional</Why>}>
        <TextArea rows={3} className="rv-full" aria-label="Notes for this week" maxLength={4000} placeholder="Anything else worth remembering about this week" value={L.notes} onChange={(e) => update({ notes: e.target.value })} />
      </Section>
      <Section title="Summary" end={c.ai ? <Button onClick={run} disabled={busy} icon="Sparkles">{aiText ? 'Rewrite Summary' : 'Write Summary'}</Button> : <Button variant="plain" onClick={run} disabled={busy}>Refresh</Button>}
        footer={<span className="why-line">{c.ai ? 'Without a written summary, Margin saves a plain factual one when you finish.' : 'This is what gets saved. Claude is off, so Margin writes it from your answers.'}</span>}>
        <Group pad>
          {aiText
            ? <TextArea rows={8} className="rv-full" aria-label="Summary" value={L.summary} maxLength={8000} onChange={(e) => update({ summary: e.target.value })} />
            : busy && !res ? <Spinner /> : <pre className="rv-summary">{res?.text ?? ''}</pre>}
          {res?.aiError && <p className="rv-err" role="alert">Claude could not write it ({res.aiError}). Showing the plain summary instead.</p>}
          {res?.changeSetId && <p className="small" style={{ marginTop: 8 }}>Claude also proposed changes. <Link href={`/changes/${res.changeSetId}`}>Open Changes</Link> after you finish.</p>}
          <Err>{err}</Err>
        </Group>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- Today widget

function DueWidget() {
  const q = useApi<Current>('/api/review/current');
  const day = useDay();
  const [, navigate] = useLocation();
  const r = q.data;
  if (!r || !r.due || r.completed || day.data?.mode !== 'day') return null;
  const started = !!r.draft.startedAt;
  return (
    <Banner icon="ClipboardCheck" why="Same ratings, same questions every week, so a trend shows up in numbers (Panagioti 2017)."
      action={<Button variant="primary" onClick={() => navigate('/review')}>{started ? 'Continue Review' : 'Start Review'}</Button>}>
      <strong>Weekly review · about {r.durationMin} minutes</strong> Scores, carry-overs, three priorities, project statuses, deadlines.
    </Banner>
  );
}

export default defineWebModule({
  id: 'review',
  routes: [{ path: '/review', component: ReviewPage, work: true }],
  widgets: { due: DueWidget },
  commands: [{ id: 'start-review', label: 'Start weekly review', group: 'Review', run: () => '/review' }],
});
