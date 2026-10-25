import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { api } from '@web/lib/api';
import { useApi, useAction, queryClient } from '@web/lib/query';
import { useNow } from '@web/lib/hooks';
import { fmtDur, fmtTime, fmtTimeShort, todayISO, ZONE } from '@web/lib/format';
import { Section, Group, Item, Button, Select, Field, Banner, Empty, toast } from '@web/ui';
import type { ActiveFocus, FocusLog, FocusProject } from '../manifest';
import './focus.css';

const WHY = 'Micro-breaks restore energy (Albulescu 2022); one project at a time avoids attention residue (Leroy 2009).';

type Running = ActiveFocus & { projectName: string };
interface FocusState { session: Running | null; last: { projectId: string; taskId: string } | null; workMin: number; breakMin: number }
type LogWithName = FocusLog & { projectName: string };

const useFocus = () => useApi<FocusState>('/api/focus/active', { refetchInterval: 20_000 });
const clock = (ms: number) => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(r).padStart(2, '0')}`;
};

/** Milliseconds left in the current phase, ticking once a second. Asks for a refresh when it reaches zero. */
function useRemaining(s: Running) {
  const now = useNow(1000);
  const left = s.endsAt ? Date.parse(s.endsAt) - now : s.remainingMs;
  const done = left <= 0;
  useEffect(() => { if (done) void queryClient.invalidateQueries(); }, [done, s.id, s.phase]);
  return left;
}

function useControls() {
  const pause = useAction('post', '/api/focus/pause');
  const resume = useAction('post', '/api/focus/resume');
  const stop = useAction('post', '/api/focus/stop');
  return { pause, resume, stop };
}

/** Project (and optional task) picker with the start button. Shared by the page and the Today widget. */
function StartControls({ state, compact }: { state: FocusState; compact?: boolean }) {
  const projects = useApi<FocusProject[]>('/api/focus/projects');
  const list = projects.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const projectId = picked ?? (state.last && list.some((p) => p.id === state.last!.projectId) ? state.last.projectId : list[0]?.id ?? '');
  const tasks = useApi<{ id: string; content: string }[]>(!compact && projectId ? `/api/focus/tasks?projectId=${encodeURIComponent(projectId)}` : null);
  const start = useAction('post', '/api/focus/start', () => setTask(''));
  if (!list.length) return <p className="small muted">No active projects to focus on. Add or resume one in Projects.</p>;
  const continuing = !!state.last && state.last.projectId === projectId;
  const go = () => start.mutate({ projectId, taskId: task || undefined } as any);
  const picker = (
    <Select aria-label="Project" value={projectId} onChange={(e) => { setPicked(e.target.value); setTask(''); }}>
      {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
  if (compact) {
    return (
      <div className="focus-widget-picker">
        {picker}
        <Button variant="primary" icon="Play" disabled={start.isPending} onClick={go}>{continuing ? 'Continue' : 'Start'}</Button>
      </div>
    );
  }
  return (
    <div className="focus-start">
      <Field label="Project">{picker}</Field>
      {!!tasks.data?.length && (
        <Field label="Task (optional)">
          <Select value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">No specific task</option>
            {tasks.data.map((t) => <option key={t.id} value={t.id}>{t.content}</option>)}
          </Select>
        </Field>
      )}
      <Button variant="primary" size="large" icon="Play" disabled={start.isPending} onClick={go}>
        {continuing ? 'Continue' : 'Start'} · {state.workMin} min
      </Button>
    </div>
  );
}

function Stage({ s }: { s: Running }) {
  const left = useRemaining(s);
  const { pause, resume, stop } = useControls();
  const tasks = useApi<{ id: string; content: string }[]>(s.taskId ? `/api/focus/tasks?projectId=${encodeURIComponent(s.projectId)}` : null);
  const taskName = s.taskId ? tasks.data?.find((t) => t.id === s.taskId)?.content : null;
  const pct = Math.min(100, Math.max(0, (1 - left / s.phaseMs) * 100));
  if (s.phase === 'break') {
    return (
      <div className="focus-stage is-break">
        <div className="focus-break-title">Break</div>
        <p className="focus-break-line">{s.breakMin === 10 ? 'Ten' : s.breakMin} minutes away from screens. Look out a window, refill water.</p>
        <div className="focus-clock num" role="timer" aria-label="Break time left">{clock(left)}</div>
        <div className="focus-actions" style={{ marginTop: 'var(--s4)' }}>
          <Button variant="plain" disabled={stop.isPending} onClick={() => stop.mutate({} as any)}>Skip Break</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="focus-stage">
      <div className="focus-eyebrow"><span className="focus-dot" style={{ background: 'var(--accent)' }} />{s.projectName}{taskName ? ` · ${taskName}` : ''}</div>
      <div className="focus-clock num" role="timer" aria-label="Time left in this block" data-paused={s.paused}>{clock(left)}</div>
      <div className="focus-sub">{s.paused ? 'Paused' : s.cutoffLimited ? `Ends at your stop, ${fmtTime(s.cutoff)}` : `Ends at ${fmtTime(s.endsAt!)}`}</div>
      <div className="focus-bar" aria-hidden="true"><div style={{ transform: `scaleX(${pct / 100})` }} /></div>
      <div className="focus-actions">
        {s.paused
          ? <Button icon="Play" disabled={resume.isPending} onClick={() => resume.mutate({} as any)}>Resume</Button>
          : <Button icon="Pause" disabled={pause.isPending} onClick={() => pause.mutate({} as any)}>Pause</Button>}
        <Button disabled={stop.isPending} onClick={() => stop.mutate({} as any)}>Stop and Log {s.workedMin} min</Button>
      </div>
    </div>
  );
}

function StopWarning({ s }: { s: Running }) {
  if (s.phase !== 'work' || !s.stopWarning) return null;
  return (
    <Banner tone="amber" icon="Moon" why="Detaching after hours has the strongest link to lower fatigue (Bennett 2018).">
      <strong>Your stop is in {s.minutesToCutoff} minute{s.minutesToCutoff === 1 ? '' : 's'}.</strong> This block ends then, and what you did so far is logged.
    </Banner>
  );
}

function Totals({ logs }: { logs: LogWithName[] }) {
  const today = todayISO();
  const byProject = new Map<string, { name: string; min: number }>();
  for (const l of logs) byProject.set(l.projectId, { name: l.projectName, min: (byProject.get(l.projectId)?.min ?? 0) + l.minutes });
  const todays = logs.filter((l) => l.start.slice(0, 10) === today);
  return (
    <>
      <Section title="Today">
        <Group>
          {todays.length ? todays.map((l) => (
            <Item key={l.id}>
              <div className="title">{l.projectName}</div>
              <span className="meta num">{fmtTimeShort(l.start)}–{fmtTime(l.end)}</span>
              <span className="meta focus-total">{fmtDur(l.minutes)}</span>
            </Item>
          )) : <Empty>No blocks logged yet today.</Empty>}
        </Group>
      </Section>
      <Section title="Last 7 days">
        <Group>
          {byProject.size ? [...byProject.entries()].sort((a, b) => b[1].min - a[1].min).map(([id, v]) => (
            <Item key={id}><div className="title">{v.name}</div><span className="meta focus-total">{fmtDur(v.min)}</span></Item>
          )) : <Empty>Nothing logged this week. Misses are just data.</Empty>}
        </Group>
      </Section>
    </>
  );
}

function FocusPage() {
  const state = useFocus();
  const from = DateTime.fromISO(todayISO(), { zone: ZONE }).minus({ days: 6 }).toISODate()!;
  const logs = useApi<LogWithName[]>(`/api/focus/logs?from=${from}`);
  const s = state.data?.session ?? null;
  return (
    <Page title="Focus" width="narrow">
      {s && <StopWarning s={s} />}
      <Section title={s ? (s.phase === 'break' ? 'On a break' : 'In progress') : 'Start a block'} why={WHY}>
        {s ? <Group className="focus-group"><Stage s={s} /></Group>
          : state.data ? <Group pad><StartControls state={state.data} /></Group> : null}
      </Section>
      <Totals logs={logs.data ?? []} />
    </Page>
  );
}

function RunningRow({ s }: { s: Running }) {
  const left = useRemaining(s);
  const [, navigate] = useLocation();
  const { pause, resume, stop } = useControls();
  return (
    <>
      <div className="row">
        <div className="grow">
          <div className="focus-widget-clock num" role="timer" aria-label="Time left">{clock(left)}</div>
          <div className="small muted">{s.phase === 'break' ? 'Break. Away from screens.' : s.paused ? `Paused · ${s.projectName}` : s.projectName}</div>
        </div>
        {s.phase === 'work' && (s.paused
          ? <Button icon="Play" onClick={() => resume.mutate({} as any)}>Resume</Button>
          : <Button icon="Pause" onClick={() => pause.mutate({} as any)}>Pause</Button>)}
        <Button onClick={() => stop.mutate({} as any)}>{s.phase === 'break' ? 'Skip Break' : 'Stop'}</Button>
        <Button variant="plain" onClick={() => navigate('/focus')}>Open</Button>
      </div>
      <StopWarning s={s} />
    </>
  );
}

/** Today widget: the running timer, or a project picker with Start / Continue. */
function TimerWidget() {
  const state = useFocus();
  if (!state.data) return null;
  const s = state.data.session;
  return (
    <Section title="Focus" why={WHY}>
      <Group pad>{s ? <RunningRow s={s} /> : <StartControls state={state.data} compact />}</Group>
    </Section>
  );
}

async function act(path: string, body?: unknown, done?: string) {
  try { await api.post(path, body); await queryClient.invalidateQueries(); if (done) toast(done); }
  catch (e: any) { toast(e?.message ?? 'Something went wrong'); }
}

export default defineWebModule({
  id: 'focus',
  routes: [{ path: '/focus', component: FocusPage, work: true }],
  widgets: { timer: TimerWidget },
  commands: [
    {
      id: 'focus.start', label: 'Start Focus Block', group: 'Focus',
      run: async ({ navigate }) => {
        const st = await api.get<FocusState>('/api/focus/active');
        if (!st.session && st.last) await act('/api/focus/start', st.last);
        navigate('/focus');
      },
    },
    { id: 'focus.stop', label: 'Stop Focus Block', group: 'Focus', run: async () => { await act('/api/focus/stop', {}, 'Focus block stopped.'); } },
  ],
});
