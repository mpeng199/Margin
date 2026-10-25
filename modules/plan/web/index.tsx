import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi } from '@web/lib/query';
import { queryClient } from '@web/lib/query';
import { useDay } from '@web/lib/hooks';
import { serverNow } from '@web/lib/hooks';
import { api } from '@web/lib/api';
import { Section, Group, Item, Button, Check, Tag, Sheet, Input, Select, TextArea, Banner, CapacityBar, Empty, Icon, toast } from '@web/ui';
import { fmtDur, fmtDayLong, fmtTime, fmtTimeShort, relDay, dt } from '@web/lib/format';
import type { PlanService } from '../manifest';
import './plan.css';

type DayPlan = ReturnType<PlanService['dayPlan']>;
type Row = DayPlan['mustDos'][number];
type TriageTask = { id: string; content: string; projectName: string; carryCount: number; nextAction: string | null; estimateMin: number | null };
type DeepInfo = ReturnType<PlanService['deepBlockInfo']>;
type Slot = ReturnType<PlanService['messageSlots']>[number];

/** POST, refetch, and (unless quiet) toast the server's plain-language error. Rethrows so callers can branch. */
async function send<T = any>(path: string, body: unknown = {}, opts: { quiet?: boolean } = {}): Promise<T> {
  try {
    const out = await api.post<T>(path, body);
    void queryClient.invalidateQueries();
    return out;
  } catch (e: any) {
    if (!opts.quiet) toast(e.message ?? 'Something went wrong');
    throw e;
  }
}
const quietly = (p: Promise<unknown>) => { p.catch(() => {}); };

const tomorrowOf = (date: string) => dt(`${date}T12:00:00`).plus({ days: 1 }).toISODate()!;
const prioLabel = (n: number) => (n >= 4 ? 'None' : `p${n}`);

function usePlanDay() {
  const day = useDay();
  const date = day.data?.date ?? null;
  const plan = useApi<DayPlan>(date ? `/api/plan/day?date=${date}` : null);
  return { date, plan: plan.data };
}

// ---------------------------------------------------------------- must-do cap: a 4th forces a choice
function useMustDo(date: string | null) {
  const [full, setFull] = useState<{ taskId: string; title: string; cap: number; current: { id: string; content: string; done: boolean }[] } | null>(null);
  const add = async (taskId: string, title: string, opts: { optional?: boolean } = {}) => {
    if (!date) return;
    try { await send('/api/plan/must-do', { taskId, date, ...opts }, { quiet: true }); }
    catch (e: any) {
      if (e.body?.code === 'cap_reached') setFull({ taskId, title, cap: e.body.cap, current: e.body.current });
      else toast(e.message);
    }
  };
  const sheet = full && (
    <Sheet open onClose={() => setFull(null)} title={`That makes more than ${full.cap} must-dos`}
      subtitle={<>Swap one out, or make “{full.title}” optional. Optional tasks stay on your list but don’t count toward the limit or the load. <span className="faint">Fewer priorities, more finished (Ivy Lee method).</span></>}
      footer={<><Button onClick={() => setFull(null)}>Cancel</Button><Button variant="primary" onClick={() => { void add(full.taskId, full.title, { optional: true }); setFull(null); }}>Make It Optional</Button></>}>
      <Group className="plan-cap-list">
        {full.current.map((c) => (
          <Item key={c.id}>
            <div className="title ellipsis">{c.content}</div>
            <Button variant="plain" disabled={c.done} title={c.done ? 'Already finished' : undefined}
              onClick={() => { quietly(send('/api/plan/must-do', { taskId: full.taskId, date, swapOut: c.id })); setFull(null); }}>Swap Out</Button>
          </Item>
        ))}
      </Group>
    </Sheet>
  );
  return { add, sheet, makeOptional: (id: string, title: string) => add(id, title, { optional: true }), remove: (id: string) => quietly(send('/api/plan/must-do/remove', { taskId: id })) };
}

// ---------------------------------------------------------------- urgency check (Zhu, Yang & Hsee 2018)
function useUrgencyGate() {
  const [ask, setAsk] = useState<{ id: string; content: string; to: number } | null>(null);
  const [answer, setAnswer] = useState('');
  const close = () => { setAsk(null); setAnswer(''); };
  const request = (t: { id: string; content: string; priority: number }, to: number) => {
    if (to === t.priority) return;
    if (to < t.priority) { setAsk({ id: t.id, content: t.content, to }); return; }
    quietly(send('/api/plan/priority', { taskId: t.id, priority: to }));
  };
  const sheet = ask && (
    <Sheet open onClose={close} title="What actually happens if this waits a week?"
      subtitle={<>You’re marking “{ask.content}” {prioLabel(ask.to)}. Answer first; it’s saved with the task. <span className="faint">Urgent-feeling tasks crowd out important ones (Zhu, Yang &amp; Hsee 2018).</span></>}
      footer={<><Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!answer.trim()} onClick={() => { quietly(send('/api/plan/priority', { taskId: ask.id, priority: ask.to, answer })); close(); }}>Apply Priority</Button></>}>
      <TextArea autoFocus rows={3} style={{ width: '100%' }} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="If it waits a week, then…" aria-label="What actually happens if this waits a week?" />
    </Sheet>
  );
  return { request, sheet };
}

// ---------------------------------------------------------------- Plan the Day page
function EstimateField({ t }: { t: Row }) {
  const [v, setV] = useState(String(t.effectiveMin));
  useEffect(() => setV(String(t.effectiveMin)), [t.effectiveMin]);
  const commit = () => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 5 || n > 600 || n === t.effectiveMin) { setV(String(t.effectiveMin)); return; }
    quietly(send(`/api/todoist/tasks/${t.id}/estimate`, { minutes: n }));
  };
  return (
    <label className="plan-est" title={`Planned as ${fmtDur(t.paddedMin)} with the ×1.5 padding`}>
      <Input type="number" min={5} max={600} step={5} value={v} aria-label={`Estimate in minutes for ${t.content}`}
        onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      <span className="faint tiny">min</span>
    </label>
  );
}

function PlanRow({ t, date, gate, actions, sub }: { t: Row; date: string; gate: ReturnType<typeof useUrgencyGate>; actions?: ReactNode; sub?: ReactNode }) {
  const overdue = t.due && t.due.date < date;
  return (
    <Item className={t.done ? 'done' : ''}>
      <div className="title">
        <div className="ellipsis">{t.content}</div>
        <div className="sub ellipsis">
          {t.projectName}{overdue ? ` · was due ${relDay(t.due!.date)}` : ''}{t.nextAction ? ` · Next: ${t.nextAction}` : ''}{sub}
        </div>
      </div>
      {t.carryCount > 0 && <Tag tone={t.carryCount >= 2 ? 'amber' : undefined}>Carried {t.carryCount}×</Tag>}
      <EstimateField t={t} />
      <select className="select plan-prio" value={t.priority} aria-label={`Priority for ${t.content}`} onChange={(e) => gate.request(t, Number(e.target.value))}>
        {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{prioLabel(n)}</option>)}
      </select>
      <div className="plan-actions">{actions}</div>
    </Item>
  );
}

function MoveSheet({ ids, date, onClose }: { ids: string[]; date: string; onClose: () => void }) {
  const [, navigate] = useLocation();
  const [to, setTo] = useState(tomorrowOf(date));
  const go = async () => {
    try {
      const out = await send<{ changeSetId?: string }>('/api/plan/move', { taskIds: ids, date: to });
      onClose();
      if (out.changeSetId) navigate(`/changes/${out.changeSetId}`); else toast(`Moved to ${relDay(to)}.`);
    } catch { /* toasted */ }
  };
  return (
    <Sheet open onClose={onClose} title={ids.length > 1 ? `Move ${ids.length} tasks` : 'Move to another day'}
      subtitle={ids.length > 1 ? 'Several moves are reviewed together before they reach Todoist.' : 'Recurring tasks keep their repeat.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!to || to <= date} onClick={go}>{ids.length > 1 ? 'Review Moves' : 'Move'}</Button></>}>
      <Input type="date" min={tomorrowOf(date)} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Move to" />
    </Sheet>
  );
}

function DropSheet({ task, onClose }: { task: Row; onClose: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <Sheet open onClose={onClose} title={`Drop “${task.content}”?`} subtitle="It’s completed in Todoist with a note. Nothing is deleted."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => { quietly(send(`/api/todoist/tasks/${task.id}/drop`, { reason })); onClose(); }}>Drop Task</Button></>}>
      <Input style={{ width: '100%' }} autoFocus placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Sheet>
  );
}

/** Over capacity: every remedy per task. Accept Plan stays disabled until the load fits. */
function TriagePanel({ p, date, mustDo }: { p: DayPlan; date: string; mustDo: ReturnType<typeof useMustDo> }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<string[] | null>(null);
  const [dropping, setDropping] = useState<Row | null>(null);
  const [shrinking, setShrinking] = useState<string | null>(null);
  const [mins, setMins] = useState('30');
  const tasks = [...p.mustDos.filter((t) => !t.done), ...p.homework, ...p.other].sort((a, b) => b.paddedMin - a.paddedMin);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Section title="Over capacity" why="Changing workload beats coping techniques (Panagioti 2017)"
      end={<Button disabled={!sel.size} onClick={() => setMoving([...sel])}>Move Selected…</Button>}>
      <Group className="plan-triage">
        <Banner tone="amber" icon="TriangleAlert">
          <strong>Planned work is {fmtDur(p.capacity.overByMin)} more than the time you have.</strong> Pick what moves, shrinks, becomes optional, or goes. Start with the biggest.
        </Banner>
        {tasks.map((t) => (
          <Item key={t.id}>
            <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.content}`} />
            <div className="title"><div className="ellipsis">{t.content}</div><div className="sub">{fmtDur(t.paddedMin)} planned{t.lane === 'homework' ? ' · Homework' : ''}</div></div>
            {shrinking === t.id ? (
              <span className="row">
                <Input type="number" min={5} step={5} style={{ width: 64 }} autoFocus value={mins} onChange={(e) => setMins(e.target.value)} aria-label="New estimate in minutes" />
                <Button variant="primary" onClick={() => { quietly(send(`/api/todoist/tasks/${t.id}/estimate`, { minutes: Math.round(Number(mins)) })); setShrinking(null); }}>Set</Button>
                <Button variant="plain" onClick={() => setShrinking(null)}>Cancel</Button>
              </span>
            ) : (
              <div className="plan-actions">
                <Button variant="plain" onClick={() => setMoving([t.id])}>Move…</Button>
                <Button variant="plain" onClick={() => void mustDo.makeOptional(t.id, t.content)}>Optional</Button>
                <Button variant="plain" onClick={() => { setMins(String(Math.max(5, Math.round(t.effectiveMin / 2)))); setShrinking(t.id); }}>Shrink</Button>
                <Button variant="plain" onClick={() => setDropping(t)}>Drop…</Button>
              </div>
            )}
          </Item>
        ))}
      </Group>
      {moving && <MoveSheet ids={moving} date={date} onClose={() => { setMoving(null); setSel(new Set()); }} />}
      {dropping && <DropSheet task={dropping} onClose={() => setDropping(null)} />}
    </Section>
  );
}

function AddFromTodoist({ shown, onPick }: { shown: Set<string>; onPick: (id: string, title: string) => void }) {
  const all = useApi<{ id: string; content: string; due: { date: string } | null }[]>('/api/todoist/tasks');
  const options = (all.data ?? []).filter((t) => !shown.has(t.id)).slice(0, 60);
  if (!options.length) return null;
  return (
    <Item>
      <Icon name="Plus" size={14} />
      <select className="select grow" value="" aria-label="Add a must-do from your Todoist tasks" onChange={(e) => { const t = options.find((o) => o.id === e.target.value); if (t) onPick(t.id, t.content); }}>
        <option value="">Add a must-do from Todoist…</option>
        {options.map((t) => <option key={t.id} value={t.id}>{t.content}{t.due ? ` (${relDay(t.due.date)})` : ''}</option>)}
      </select>
    </Item>
  );
}

function PlanPage() {
  const { date, plan: p } = usePlanDay();
  const [, navigate] = useLocation();
  const mustDo = useMustDo(date);
  const gate = useUrgencyGate();
  const [busy, setBusy] = useState(false);
  if (!p || !date) return <Page title="Plan the Day" width="narrow"><div /></Page>;
  const over = p.capacity.loadMin > p.capacity.freeMin;
  const shown = new Set([...p.mustDos, ...p.optional, ...p.homework, ...p.other].map((t) => t.id));
  const accept = async () => { setBusy(true); try { await send('/api/plan/accept', { date }); toast('Plan accepted.'); } catch { /* toasted */ } finally { setBusy(false); } };
  const draft = async () => {
    setBusy(true);
    try {
      const out = await send<{ changeSetId: string | null; text: string }>('/api/plan/ai-draft', { date });
      if (out.changeSetId) navigate(`/changes/${out.changeSetId}`); else toast(out.text || 'Claude had nothing to suggest.');
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  return (
    <Page title="Plan the Day" subtitle={fmtDayLong(date)} width="narrow"
      actions={<>
        {p.acceptedAt && <Tag tone="green">Accepted {fmtTime(p.acceptedAt)}</Tag>}
        {p.aiEnabled && <Button icon="Sparkles" disabled={busy} onClick={draft}>Draft with Claude</Button>}
        <Button variant="primary" disabled={!p.canAccept || busy} onClick={accept} title={p.canAccept ? undefined : p.blockers[0]}>Accept Plan</Button>
      </>}>
      <Section title="Capacity" why="Estimates are padded ×1.5 because plans run long (planning fallacy, Buehler, Griffin & Ross 1994)">
        <Group pad>
          <div className="row between num" style={{ marginBottom: 8 }}>
            <span><strong>{fmtDur(p.capacity.loadMin)}</strong> <span className="muted">planned</span></span>
            <span><strong>{fmtDur(p.capacity.freeMin)}</strong> <span className="muted">free before the stop</span></span>
          </div>
          <CapacityBar loadMin={p.capacity.loadMin} freeMin={p.capacity.freeMin} />
          <p className={`small ${over ? 'plan-over' : 'muted'}`} style={{ marginTop: 8 }}>
            {over ? `Over by ${fmtDur(p.capacity.overByMin)}. Accept Plan unlocks when it fits.` : p.blockers.length ? p.blockers[0] : 'Fits, with room for overruns.'}
          </p>
        </Group>
      </Section>

      {over && <TriagePanel p={p} date={date} mustDo={mustDo} />}

      <Section title="Must-dos" why="Fewer priorities, more finished (Ivy Lee method)"
        end={<Tag tone={p.cap.used > p.cap.limit ? 'amber' : undefined}>{p.cap.used} of {p.cap.limit}</Tag>}
        footer={p.cap.used > p.cap.limit ? <span className="plan-over">That’s over the limit. Make one optional or swap one out.</span> : undefined}>
        <Group>
          {p.mustDos.map((t) => (
            <PlanRow key={t.id} t={t} date={date} gate={gate}
              actions={t.done ? <Tag tone="green">Done</Tag> : <>
                <Button variant="plain" onClick={() => void mustDo.makeOptional(t.id, t.content)}>Optional</Button>
                <Button variant="plain" onClick={() => mustDo.remove(t.id)} aria-label={`Remove ${t.content} from must-dos`}>Remove</Button></>} />
          ))}
          {!p.mustDos.length && <div className="empty">Nothing chosen yet. Pick up to {p.cap.limit} that would make today a good day.</div>}
          <AddFromTodoist shown={shown} onPick={(id, title) => void mustDo.add(id, title)} />
        </Group>
      </Section>

      {p.homework.length > 0 && (
        <Section title="Homework" why="Its own lane: it counts toward capacity, not toward the must-do limit">
          <Group>{p.homework.map((t) => <PlanRow key={t.id} t={t} date={date} gate={gate} actions={<Button variant="plain" onClick={() => void mustDo.makeOptional(t.id, t.content)}>Optional</Button>} />)}</Group>
        </Section>
      )}

      {p.other.length > 0 && (
        <Section title="Other tasks due" why="Everything else dated for today, including what’s overdue">
          <Group>
            {p.other.map((t) => (
              <PlanRow key={t.id} t={t} date={date} gate={gate}
                actions={<><Button variant="plain" onClick={() => void mustDo.add(t.id, t.content)}>Make Must-Do</Button><Button variant="plain" onClick={() => void mustDo.makeOptional(t.id, t.content)}>Optional</Button></>} />
            ))}
          </Group>
        </Section>
      )}

      {p.optional.length > 0 && (
        <Section title="Optional" why="On the list, but not counted in the limit or the load">
          <Group>
            {p.optional.map((t) => (
              <PlanRow key={t.id} t={t} date={date} gate={gate}
                actions={<><Button variant="plain" onClick={() => void mustDo.add(t.id, t.content)}>Make Must-Do</Button><Button variant="plain" onClick={() => mustDo.remove(t.id)}>Remove</Button></>} />
            ))}
          </Group>
        </Section>
      )}
      {mustDo.sheet}
      {gate.sheet}
    </Page>
  );
}

// ---------------------------------------------------------------- Today widgets
function MustDosWidget() {
  const { date, plan: p } = usePlanDay();
  const [, navigate] = useLocation();
  if (!p || !date) return null;
  const toggle = (t: Row, done: boolean) => quietly(send(`/api/todoist/tasks/${t.id}/${done ? 'close' : 'reopen'}`));
  const rowFor = (t: Row) => (
    <Item key={t.id} className={t.done ? 'done' : ''}>
      <Check checked={t.done} onChange={(v) => toggle(t, v)} label={`${t.done ? 'Reopen' : 'Complete'} ${t.content}`} />
      <div className="title">
        <div className="ellipsis">{t.content}</div>
        {t.nextAction && <div className="sub ellipsis">{t.nextAction}</div>}
      </div>
      {t.carryCount > 0 && <Tag tone={t.carryCount >= 2 ? 'amber' : undefined}>Carried {t.carryCount}×</Tag>}
      <span className="meta num">{fmtDur(t.effectiveMin)}</span>
    </Item>
  );
  return (
    <Section title="Must-dos" why="Fewer priorities, more finished (Ivy Lee method)"
      end={<>
        <Tag tone={p.cap.used > p.cap.limit ? 'amber' : undefined}>{p.cap.used} of {p.cap.limit}</Tag>
        <Button onClick={() => navigate('/plan')}>Plan the Day</Button>
      </>}>
      <Group>
        {p.mustDos.map(rowFor)}
        {p.optional.length > 0 && <div className="plan-sublabel">Optional</div>}
        {p.optional.map(rowFor)}
        {!p.mustDos.length && !p.optional.length && (
          <Empty action={<Button variant="primary" onClick={() => navigate('/plan')}>Plan the Day</Button>}>Choose up to {p.cap.limit} things that would make today a good day.</Empty>
        )}
      </Group>
      {p.acceptedAt && <div className="plan-footnote tiny faint">Plan accepted at {fmtTime(p.acceptedAt)}.</div>}
    </Section>
  );
}

function HomeworkWidget() {
  const { date, plan: p } = usePlanDay();
  if (!p || !date || !p.homework.length) return null;
  return (
    <Section title="Homework" why="Its own lane: counts toward capacity, not toward your 3 must-dos">
      <Group>
        {p.homework.map((t) => (
          <Item key={t.id}>
            <Check checked={false} onChange={() => quietly(send(`/api/todoist/tasks/${t.id}/close`))} label={`Complete ${t.content}`} />
            <div className="title"><div className="ellipsis">{t.content}</div><div className="sub ellipsis">{t.projectName}</div></div>
            {t.due && t.due.date !== date && <Tag tone={t.due.date < date ? 'amber' : undefined}>{t.due.date < date ? 'Overdue' : `Due ${relDay(t.due.date)}`}</Tag>}
            <span className="meta num">{fmtDur(t.effectiveMin)}</span>
          </Item>
        ))}
      </Group>
    </Section>
  );
}

type TriageDialog = { kind: 'slot' | 'delegate' | 'drop'; task: TriageTask };

function CarryTriageWidget() {
  const { date } = usePlanDay();
  const q = useApi<TriageTask[]>('/api/plan/triage-queue');
  const [dialog, setDialog] = useState<TriageDialog | null>(null);
  const tasks = q.data ?? [];
  if (!date || !tasks.length) return null;
  const decide = (task: TriageTask, decision: 'first', msg: string) => send('/api/plan/triage', { taskId: task.id, decision }).then(() => toast(msg)).catch(() => {});
  return (
    <Section title="Needs a decision" why="A specific plan stops unfinished tasks from nagging (Masicampo & Baumeister 2011)">
      <Group className="plan-carry">
        {tasks.map((t) => (
          <div key={t.id}>
            <Item>
              <Icon name="TriangleAlert" size={15} style={{ color: 'var(--amber)' }} />
              <div className="title">
                <div className="ellipsis">{t.content}</div>
                <div className="sub">Carried {t.carryCount} times. There is no 4th roll.{t.nextAction ? ` Next: ${t.nextAction}` : ''}</div>
              </div>
              <Tag tone="amber">Triage</Tag>
            </Item>
            <div className="plan-carry-actions">
              <Button onClick={() => void decide(t, 'first', 'It’s the first must-do tomorrow.')}>Do First Tomorrow</Button>
              <Button onClick={() => setDialog({ kind: 'slot', task: t })}>Give It a Slot…</Button>
              <Button onClick={() => setDialog({ kind: 'delegate', task: t })}>Delegate…</Button>
              <Button variant="danger" onClick={() => setDialog({ kind: 'drop', task: t })}>Drop…</Button>
            </div>
          </div>
        ))}
      </Group>
      {dialog?.kind === 'slot' && <SlotSheet task={dialog.task} date={date} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delegate' && <DelegateSheet task={dialog.task} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'drop' && <TriageDropSheet task={dialog.task} onClose={() => setDialog(null)} />}
    </Section>
  );
}

function SlotSheet({ task, date, onClose }: { task: TriageTask; date: string; onClose: () => void }) {
  const [d, setD] = useState(tomorrowOf(date));
  const [time, setTime] = useState('16:00');
  const go = async () => {
    try { await send('/api/plan/triage', { taskId: task.id, decision: 'slot', slotStart: `${d}T${time}:00` }); toast('Slot added to your calendar.'); onClose(); } catch { /* toasted */ }
  };
  return (
    <Sheet open onClose={onClose} title={`Give “${task.content}” a fixed slot`}
      subtitle={`A calendar block of ${fmtDur(task.estimateMin ?? 30)}, never past your stop. The block is created when you confirm.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!d || !time} onClick={go}>Add to Calendar</Button></>}>
      <div className="plan-sheet-row"><span>Day</span><Input type="date" min={date} value={d} onChange={(e) => setD(e.target.value)} aria-label="Day" /></div>
      <div className="plan-sheet-row"><span>Start</span><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Start time" /></div>
    </Sheet>
  );
}

function DelegateSheet({ task, onClose }: { task: TriageTask; onClose: () => void }) {
  const [owner, setOwner] = useState('');
  const [note, setNote] = useState('');
  const go = async () => {
    try { await send('/api/plan/triage', { taskId: task.id, decision: 'delegate', owner, reason: note }); toast(`Delegated to ${owner}.`); onClose(); } catch { /* toasted */ }
  };
  return (
    <Sheet open onClose={onClose} title={`Delegate “${task.content}”`} subtitle="It leaves your plan and gets the waiting label in Todoist."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!owner.trim()} onClick={go}>Delegate</Button></>}>
      <div className="plan-sheet-row"><span>Owner</span><Input autoFocus value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who’s taking it?" aria-label="Owner" /></div>
      <div className="plan-sheet-row"><span>Comment</span><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional, added to the task" aria-label="Comment" /></div>
    </Sheet>
  );
}

function TriageDropSheet({ task, onClose }: { task: TriageTask; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const go = async () => { try { await send('/api/plan/triage', { taskId: task.id, decision: 'drop', reason }); onClose(); } catch { /* toasted */ } };
  return (
    <Sheet open onClose={onClose} title={`Drop “${task.content}”?`} subtitle="Carried three times is data, not failure. It’s completed in Todoist with a note; nothing is deleted."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={go}>Drop Task</Button></>}>
      <Input style={{ width: '100%' }} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional)" aria-label="Reason" />
    </Sheet>
  );
}

const roundUp5 = (ms: number) => Math.ceil(ms / 300_000) * 300_000;

function DeepBlockWidget() {
  const { date } = usePlanDay();
  const info = useApi<DeepInfo>(date ? `/api/plan/deep-block?date=${date}` : null);
  const [open, setOpen] = useState(false);
  const d = info.data;
  if (!date || !d) return null;
  if (!d.block && !d.gaps.length) return null;
  return (
    <Section title="Deep work" why="One project per block avoids attention residue (Leroy 2009)">
      <Group>
        {d.block ? (
          <Item>
            <Icon name="CalendarCheck" size={16} />
            <div className="title"><div className="ellipsis">{d.block.project}</div><div className="sub num">{fmtTimeShort(d.block.start)}–{fmtTime(d.block.end)}</div></div>
            <Tag tone="green">On calendar</Tag>
          </Item>
        ) : (
          <Item>
            <div className="title"><div>No deep block yet</div><div className="sub">{d.minutes} minutes on one project, in a free gap before your stop.</div></div>
            <Button onClick={() => setOpen(true)}>Plan a Block…</Button>
          </Item>
        )}
      </Group>
      {open && <DeepBlockSheet d={d} onClose={() => setOpen(false)} />}
    </Section>
  );
}

function DeepBlockSheet({ d, onClose }: { d: DeepInfo; onClose: () => void }) {
  const firstStart = (g: DeepInfo['gaps'][number]) => {
    const t = d.date === dt(new Date(serverNow()).toISOString()).toISODate() ? Math.max(dt(g.start).toMillis(), roundUp5(serverNow())) : dt(g.start).toMillis();
    return dt(new Date(t).toISOString()).toFormat('HH:mm');
  };
  const usable = d.gaps.filter((g) => g.minutes >= 60);
  const [project, setProject] = useState(d.projects[0]?.name ?? '');
  const [gap, setGap] = useState(0);
  const [time, setTime] = useState(usable[0] ? firstStart(usable[0]) : '16:00');
  const [minutes, setMinutes] = useState(d.minutes);
  const g = usable[gap];
  const start = dt(`${d.date}T${time}:00`);
  const end = start.plus({ minutes });
  const fits = !!g && start.toMillis() >= dt(g.start).toMillis() && end.toMillis() <= dt(g.end).toMillis();
  const go = async () => {
    try { await send('/api/plan/deep-block', { date: d.date, project, start: time, minutes }); toast('Deep block added to your calendar.'); onClose(); } catch { /* toasted */ }
  };
  return (
    <Sheet open onClose={onClose} title="Plan a deep block" subtitle="One project, 60 to 90 minutes. The block goes on your calendar when you confirm, and never past your stop."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!project.trim() || !fits} onClick={go}>Add to Calendar</Button></>}>
      <div className="plan-sheet-row"><span>Project</span>
        {d.projects.length ? (
          <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">{d.projects.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}</Select>
        ) : <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project name" aria-label="Project" />}
      </div>
      <div className="plan-sheet-row"><span>Free gap</span>
        <Select value={gap} onChange={(e) => { const i = Number(e.target.value); setGap(i); setTime(firstStart(usable[i])); }} aria-label="Free gap">
          {usable.map((x, i) => <option key={x.start} value={i}>{fmtTimeShort(x.start)}–{fmtTime(x.end)} ({fmtDur(x.minutes)})</option>)}
        </Select>
      </div>
      <div className="plan-sheet-row"><span>Start</span><Input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Start time" /></div>
      <div className="plan-sheet-row"><span>Length</span>
        <div className="seg" role="group" aria-label="Length">{[60, 75, 90].map((m) => <button key={m} type="button" aria-pressed={m === minutes} onClick={() => setMinutes(m)}>{m} min</button>)}</div>
      </div>
      <p className={`small plan-gap-note ${fits ? 'muted' : 'plan-over'}`}>{fits ? `${fmtTimeShort(start.toISO()!)}–${fmtTime(end.toISO()!)}` : 'That doesn’t fit inside the gap. Start earlier or shorten it.'}</p>
    </Sheet>
  );
}

function MessagesWidget() {
  const { date } = usePlanDay();
  const q = useApi<Slot[]>(date ? `/api/plan/messages?date=${date}` : null);
  if (!date || !q.data?.length) return null;
  return (
    <Section title="Messages" why="Two batches a day means fewer task switches (attention residue, Leroy 2009)">
      <Group>
        {q.data.map((s) => (
          <Item key={s.id} className="plan-quiet">
            <Icon name="Mail" size={15} />
            <div className="title"><div>{s.label}</div>{s.id === 'shutdown' && <div className="sub num">{s.time}</div>}</div>
            {s.blocked ? <Tag tone="green">On calendar</Tag> : <Button variant="plain" onClick={() => quietly(send('/api/plan/messages/block', { date, slot: s.id }))}>Block 15 Min</Button>}
          </Item>
        ))}
      </Group>
    </Section>
  );
}

export default defineWebModule({
  id: 'plan',
  routes: [{ path: '/plan', component: PlanPage, work: true }],
  widgets: { 'must-dos': MustDosWidget, homework: HomeworkWidget, 'carry-triage': CarryTriageWidget, 'deep-block': DeepBlockWidget, messages: MessagesWidget },
  commands: [{ id: 'plan.open', label: 'Plan the day', group: 'Plan', run: () => '/plan' }],
});
