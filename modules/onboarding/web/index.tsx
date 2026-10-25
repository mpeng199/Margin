import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { useApi, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';
import { useModules } from '@web/lib/hooks';
import { Section, Group, Item, Button, Input, Select, Toggle, Tag, Banner, toast, CapacityBar, Icon } from '@web/ui';
import { fmtDur, fmtDay } from '@web/lib/format';
import { TodoistAccount } from '../../todoist/web';
import { GoogleAccount } from '../../google/web';
import './onboarding.css';

const TITLES = ['Connect your accounts', 'When do you wake up?', 'Your fixed weekly blocks', 'Off-day and weekly review', 'Projects become tabs', 'Delphic Medicine owners', 'Application deadlines', 'A baseline to measure against'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function Onboarding() {
  const state = useApi<{ step: number; completed: boolean; steps: string[] }>('/api/onboarding/state');
  const [step, setStep] = useState<number | null>(null);
  const [, navigate] = useLocation();
  const modules = useModules();
  const has = (id: string) => !!modules.data?.find((m) => m.id === id && m.enabled);
  useEffect(() => { if (state.data && step === null) setStep(Math.min(state.data.step, TITLES.length - 1)); }, [state.data, step]);
  if (step === null) return null;
  const go = async (n: number, skipped?: string) => {
    if (n >= TITLES.length) {
      await api.post('/api/onboarding/complete');
      await queryClient.invalidateQueries();
      navigate('/today');
      return;
    }
    await api.post('/api/onboarding/step', { step: n, skipped });
    setStep(n);
  };
  const next = () => go(step + 1);
  const skip = () => go(step + 1, TITLES[step]);
  const body = [
    <Accounts key="a" />,
    <Wake key="w" />,
    <Blocks key="b" hasGoogle={has('google')} />,
    <Week key="k" hasReview={has('review')} hasOffday={has('offday')} />,
    has('projects') ? <Projects key="p" /> : <Unavailable key="p" what="Projects" />,
    has('delegation') ? <Owners key="o" /> : <Unavailable key="o" what="Delegation" />,
    has('projects') ? <Deadlines key="d" /> : <Unavailable key="d" what="Projects" />,
    <Baseline key="z" has={has} />,
  ][step];
  return (
    <div className="ob">
      <div className="ob-drag" />
      <div className="ob-inner">
        <div className="ob-progress" aria-label={`Step ${step + 1} of ${TITLES.length}`}>
          {TITLES.map((t, i) => <span key={t} className={i < step ? 'done' : i === step ? 'now' : ''} title={t} />)}
        </div>
        <p className="ob-eyebrow muted small">Step {step + 1} of {TITLES.length} · about {Math.max(1, Math.round(((TITLES.length - step) * 10) / TITLES.length))} min left</p>
        <h1 className="ob-title">{TITLES[step]}</h1>
        <div className="ob-body">{body}</div>
        <div className="ob-nav">
          {step > 0 && <Button onClick={() => go(step - 1)}>Back</Button>}
          <span className="grow" />
          <Button variant="plain" onClick={skip}>Skip</Button>
          <Button variant="primary" size="large" onClick={next}>{step === TITLES.length - 1 ? 'Finish' : 'Continue'}</Button>
        </div>
      </div>
    </div>
  );
}

function Unavailable({ what }: { what: string }) {
  return <p className="muted">{what} isn’t turned on. You can set this up later from Settings.</p>;
}

function Accounts() {
  return (
    <>
      <p className="ob-lede">Margin reads your tasks and calendars so it can plan around reality. It writes only after you say yes, and never deletes anything. Skip this to explore on realistic mock data; you can connect later in Settings.</p>
      <TodoistAccount compact />
      <GoogleAccount compact />
      <p className="small muted" style={{ marginTop: 16 }}>Claude is optional and off by default. Turn it on in Settings → Claude.</p>
    </>
  );
}

function Wake() {
  const settings = useApi<any>('/api/settings/day');
  const [wake, setWake] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => { if (settings.data && wake === null) setWake(settings.data.wakeTime); }, [settings.data, wake]);
  useEffect(() => {
    if (!wake) return;
    api.post('/api/day/anchors/preview', { wakeTime: wake, weekdayWake: [null, null, null, null, null, null, null], dateWake: {} }).then(setPreview).catch(() => {});
  }, [wake]);
  const save = async (v: string) => { setWake(v); await api.patch('/api/settings/day', { wakeTime: v }); void queryClient.invalidateQueries(); };
  if (wake === null) return null;
  return (
    <>
      <p className="ob-lede">Everything else is computed from this, never typed in: lights-out leaves 8 hours of sleep plus about 30 minutes to fall asleep, and the hard stop leaves an hour with no screens before that.</p>
      <div className="ob-wake">
        <input type="time" className="input ob-time" value={wake} onChange={(e) => void save(e.target.value)} aria-label="Wake time" />
      </div>
      {preview && (
        <Group pad>
          <div className="ob-math num">
            {preview.math.map((l: string) => <div key={l}>{l}</div>)}
          </div>
          <p className="why-line" style={{ marginTop: 10 }}>Teens need 8–10 hours (AASM). On school nights the stop never moves later than this.</p>
        </Group>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>Early mornings (like badminton) get per-day overrides in Settings → Day anchors.</p>
    </>
  );
}

interface Block { id: string; label: string; kind: string; days: number[]; start: string; end: string }
function Blocks({ hasGoogle }: { hasGoogle: boolean }) {
  const seed = useApi<Block[]>('/api/onboarding/seed-blocks');
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [saved, setSaved] = useState(false);
  const week = useApi<any>(saved ? '/api/day/week' : null);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  useEffect(() => { if (seed.data && !blocks) setBlocks(seed.data); }, [seed.data, blocks]);
  if (!blocks) return null;
  const upd = (i: number, patch: Partial<Block>) => { setSaved(false); setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b))); };
  const save = async () => {
    await api.patch('/api/settings/day', { fixedBlocks: blocks });
    setSaved(true);
    void queryClient.invalidateQueries();
  };
  const toCalendar = async () => {
    try { const r = await api.post<{ message: string }>('/api/onboarding/blocks-to-calendar'); setCalMsg(r.message); } catch (e: any) { toast(e.message); }
  };
  const weekdays = week.data?.days.filter((d: any) => [1, 2, 3, 4, 5].includes(new Date(d.date + 'T12:00').getDay() || 7)) ?? [];
  return (
    <>
      <p className="ob-lede">Seeded from your current schedule. Edit anything that’s off, then check what’s left before the stop.</p>
      <Group>
        {blocks.map((b, i) => (
          <Item key={b.id} className="ob-block">
            <Input value={b.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label="Block name" style={{ width: 110 }} />
            <div className="days-picker" role="group" aria-label={`${b.label} days`}>
              {'MTWTFSS'.split('').map((d, k) => (
                <button key={k} type="button" aria-pressed={b.days.includes(k + 1)} aria-label={DAYS[k]}
                  onClick={() => upd(i, { days: b.days.includes(k + 1) ? b.days.filter((x) => x !== k + 1) : [...b.days, k + 1].sort() })}>{d}</button>
              ))}
            </div>
            <Input type="time" value={b.start} onChange={(e) => upd(i, { start: e.target.value })} aria-label="Start" />
            <span className="faint">–</span>
            <Input type="time" value={b.end} onChange={(e) => upd(i, { end: e.target.value })} aria-label="End" />
            <button className="btn icon" aria-label={`Remove ${b.label}`} onClick={() => { setSaved(false); setBlocks(blocks.filter((_, j) => j !== i)); }}><Icon name="X" size={14} /></button>
          </Item>
        ))}
      </Group>
      <div className="row" style={{ marginTop: 10 }}>
        <Button onClick={() => { setSaved(false); setBlocks([...blocks, { id: crypto.randomUUID(), label: 'Block', kind: 'other', days: [1, 2, 3, 4, 5], start: '16:00', end: '17:00' }]); }} icon="Plus">Add Block</Button>
        <span className="grow" />
        <Button variant="primary" onClick={save}>{saved ? 'Saved' : 'Save and Check Capacity'}</Button>
      </div>
      {saved && week.data && (
        <Section title="What’s left before your stop" why="Free minutes between fixed blocks and the hard stop">
          <Group>
            {weekdays.map((d: any) => (
              <Item key={d.date}>
                <span style={{ width: 90 }}>{fmtDay(d.date)}</span>
                <div className="grow"><CapacityBar freeMin={Math.max(d.freeMin, 1)} loadMin={0} compact /></div>
                <span className="num" style={{ width: 70, textAlign: 'right', color: d.status === 'none' ? 'var(--amber)' : undefined }}>{fmtDur(d.freeMin)}</span>
              </Item>
            ))}
          </Group>
          {week.data.weekdaysWithoutCapacity.length > 0 ? (
            <div style={{ marginTop: 10 }}><Banner tone="amber" icon="TriangleAlert" why="Changing workload beats coping techniques (Panagioti 2017).">
              {week.data.weekdaysWithoutCapacity.length} weekdays have almost no free time before the stop. That’s a load problem, not a discipline problem. The projects step is where you change it.
            </Banner></div>
          ) : (
            <p className="small muted" style={{ marginTop: 8 }}>About {fmtDur(week.data.weekdayFreeMin / 5)} free on an average weekday, before homework.</p>
          )}
          {hasGoogle && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="small muted grow">{calMsg ?? 'Put school and lab on a separate “Margin · Blocks” calendar so your phone shows them too?'}</span>
              {!calMsg && <Button onClick={toCalendar}>Yes, Add Them</Button>}
            </div>
          )}
        </Section>
      )}
    </>
  );
}

function Week({ hasReview, hasOffday }: { hasReview: boolean; hasOffday: boolean }) {
  const day = useApi<any>('/api/settings/day');
  const review = useApi<any>(hasReview ? '/api/settings/review' : null);
  if (!day.data) return null;
  const setDay = async (patch: any) => { await api.patch('/api/settings/day', patch); void queryClient.invalidateQueries(); };
  const setReview = async (patch: any) => { await api.patch('/api/settings/review', patch); void queryClient.invalidateQueries(); };
  return (
    <>
      <p className="ob-lede">One full day a week with no work views and no work notifications, and a 45-minute review to decide what to cut.</p>
      <Group>
        <Item>
          <div className="title"><div>Off-day</div><div className="sub">Detaching from work is the recovery experience most linked to lower fatigue (Bennett 2018).</div></div>
          <Select value={day.data.offDay} onChange={(e) => void setDay({ offDay: Number(e.target.value) })} aria-label="Off-day">
            {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
          </Select>
        </Item>
        {review.data && (
          <Item>
            <div className="title"><div>Weekly review</div><div className="sub">Guided, about 45 minutes. Produces one set of changes for you to approve.</div></div>
            <Select value={review.data.reviewDay} onChange={(e) => void setReview({ reviewDay: Number(e.target.value) })} aria-label="Review day">
              {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </Select>
            <Input type="time" value={review.data.reviewTime} onChange={(e) => void setReview({ reviewTime: e.target.value })} aria-label="Review time" />
          </Item>
        )}
      </Group>
      {!hasOffday && <p className="small muted" style={{ marginTop: 8 }}>The off-day module is off; turn it on in Settings → Modules to enforce this.</p>}
    </>
  );
}

const STATUSES = [['core', 'Core'], ['maintain', 'Maintain'], ['pause', 'Pause'], ['drop', 'Drop']] as const;
function Projects() {
  const seeds = useApi<any[]>('/api/projects/seed-suggestions');
  const existing = useApi<any[]>('/api/projects');
  const td = useApi<{ id: string; name: string; inbox: boolean }[]>('/api/todoist/projects');
  const tdStatus = useApi<any>('/api/todoist/status');
  const [rows, setRows] = useState<any[] | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (seeds.data && !rows) setRows(seeds.data.map((s) => ({ ...s, include: true, link: 'label', createCalendar: true })));
  }, [seeds.data, rows]);
  if (existing.data && existing.data.length > 0 && !rows?.length) {
    return <p className="muted">You already have {existing.data.length} project tabs. Manage them from the sidebar.</p>;
  }
  if (!rows) return null;
  const left = tdStatus.data?.plan?.projectsLeft ?? 99;
  const upd = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const create = async () => {
    try {
      await api.post('/api/projects/onboarding', { items: rows.filter((r) => r.include) });
      setDone(true);
      toast('Project tabs created.');
      void queryClient.invalidateQueries();
    } catch (e: any) { toast(e.message); }
  };
  const nonSchoolCore = rows.filter((r) => r.include && r.status === 'core' && !r.isSchool).length;
  return (
    <>
      <p className="ob-lede">Each project gets its own tab, timeline and Google calendar. The statuses are where recovery actually happens: carrying less beats coping better.</p>
      {nonSchoolCore > 2 && <div style={{ marginBottom: 10 }}><Banner tone="amber" icon="TriangleAlert" why="Work-in-progress limit: 2 non-school Core projects">{nonSchoolCore} non-school projects are marked Core. Pick two; the rest go to Maintain or Pause.</Banner></div>}
      <Group>
        {rows.map((r, i) => (
          <Item key={r.key ?? r.name} className="ob-proj" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={r.include} onChange={(e) => upd(i, { include: e.target.checked })} aria-label={`Include ${r.name}`} style={{ marginTop: 6 }} />
            <div className="title">
              <Input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label="Project name" style={{ width: '100%' }} disabled={!r.include} />
              {r.note && <div className="sub" style={{ marginTop: 4 }}>{r.note}</div>}
            </div>
            <Select value={r.status} onChange={(e) => upd(i, { status: e.target.value })} aria-label={`${r.name} status`} disabled={!r.include}>
              {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Select value={r.link} onChange={(e) => upd(i, { link: e.target.value })} aria-label={`${r.name} Todoist link`} disabled={!r.include}>
              <option value="label">Todoist label</option>
              {left > 0 && <option value="create">New Todoist project</option>}
              {(td.data ?? []).filter((p) => !p.inbox).map((p) => <option key={p.id} value={`project:${p.id}`}>Link “{p.name}”</option>)}
              <option value="none">No Todoist link</option>
            </Select>
            <label className="row small" title="Create its own Google calendar"><Toggle checked={r.createCalendar} label="Own calendar" onChange={(v) => upd(i, { createCalendar: v })} /> Calendar</label>
          </Item>
        ))}
      </Group>
      {left <= 2 && <p className="small muted" style={{ marginTop: 8 }}>Your Todoist plan has room for {left} more project{left === 1 ? '' : 's'}, so most tabs link to a label instead. Tasks still live in Todoist.</p>}
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        {done ? <Tag tone="green">Created</Tag> : <Button variant="primary" onClick={create}>Create Tabs</Button>}
      </div>
    </>
  );
}

const DELPHIC_FUNCTIONS = ['Manuscript intake and reviewer assignment', 'Editing and production', 'Outreach and social media', 'Operations and scheduling'];
function Owners() {
  const projects = useApi<any[]>('/api/projects');
  const delphic = projects.data?.find((p) => /delphic/i.test(p.name));
  const [owners, setOwners] = useState<string[]>(DELPHIC_FUNCTIONS.map(() => ''));
  const [saved, setSaved] = useState(false);
  if (!delphic) return <p className="muted">Create the Delphic Medicine tab in the previous step to set its owners here, or add them later in its People tab.</p>;
  const save = async () => {
    try {
      for (let i = 0; i < DELPHIC_FUNCTIONS.length; i++) {
        await api.post('/api/delegation/functions', { projectId: delphic.id, name: DELPHIC_FUNCTIONS[i], owner: owners[i] || null, cadence: 'weekly', checkinMin: 20 });
      }
      setSaved(true);
      toast('Owners saved.');
    } catch (e: any) { toast(e.message); }
  };
  return (
    <>
      <p className="ob-lede">Delphic runs through owners so it fits in a 20-minute check-in plus 30 minutes of decisions on Sundays. Who owns each function?</p>
      <Group>
        {DELPHIC_FUNCTIONS.map((f, i) => (
          <Item key={f}>
            <div className="title">{f}</div>
            <Input placeholder="Owner’s name" value={owners[i]} onChange={(e) => setOwners(owners.map((o, j) => (j === i ? e.target.value : o)))} aria-label={`Owner for ${f}`} />
          </Item>
        ))}
      </Group>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        {saved ? <Tag tone="green">Saved</Tag> : <Button variant="primary" onClick={save}>Save Owners</Button>}
      </div>
    </>
  );
}

function Deadlines() {
  const projects = useApi<any[]>('/api/projects');
  const apps = projects.data?.find((p) => /application/i.test(p.name));
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const parsed = useMemo(() => text.split('\n').map((l) => {
    const m = l.match(/^(.*?)[\s,–—-]+(\d{4}-\d{2}-\d{2})\s*$/);
    return m ? { title: m[1].trim(), date: m[2], kind: 'deadline' } : null;
  }).filter(Boolean) as { title: string; date: string; kind: string }[], [text]);
  if (!apps) return <p className="muted">No applications project yet. Add deadlines later from its Timeline.</p>;
  const save = async () => {
    try {
      await api.post(`/api/projects/${apps.id}/milestones/bulk`, parsed);
      setSaved(parsed.length);
      void queryClient.invalidateQueries();
    } catch (e: any) { toast(e.message); }
  };
  return (
    <>
      <p className="ob-lede">These go on {apps.name}’s own timeline and calendar, not your main one, so they don’t crowd Today until they matter.</p>
      <textarea className="textarea" rows={6} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={'One per line, with the date last:\nRSI application — 2027-01-14\nSSP application — 2027-02-20\nMIT PRIMES — 2026-12-01'} aria-label="Application deadlines" />
      <p className="small muted" style={{ marginTop: 6 }}>{parsed.length ? `${parsed.length} deadline${parsed.length === 1 ? '' : 's'} recognized.` : 'Use YYYY-MM-DD dates.'}</p>
      <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        {saved !== null ? <Tag tone="green">Imported {saved}</Tag> : <Button variant="primary" disabled={!parsed.length} onClick={save}>Import Deadlines</Button>}
      </div>
    </>
  );
}

const RED_FLAGS = [
  'Thoughts of death, self-harm, or suicide',
  'Low mood or loss of interest most days for 2+ weeks',
  'Panic attacks or persistent physical symptoms',
  'Under about 6 hours of sleep most nights, even with the chance to sleep',
  'Big changes in eating or weight, or using caffeine, nicotine, alcohol or other drugs to cope',
];
function Baseline({ has }: { has: (id: string) => boolean }) {
  const [v, setV] = useState({ bedtime: '23:30', wakeTime: '06:30', caffeineTime: '15:00', energy: 4, dread: 6, effective: 4, phase1Start: new Date().toISOString().slice(0, 10) });
  const [flags, setFlags] = useState<boolean[]>(RED_FLAGS.map(() => false));
  const [saved, setSaved] = useState(false);
  const [, navigate] = useLocation();
  const save = async () => {
    const redFlags = RED_FLAGS.filter((_, i) => flags[i]);
    try {
      if (has('checkin')) await api.post('/api/checkin/baseline', { ...v, redFlags });
      if (has('phases')) await api.patch('/api/settings/phases', { phase1Start: v.phase1Start });
      if (has('habits')) await api.post('/api/habits/phase-one').catch(() => {});
      if (redFlags.length && has('gethelp')) await api.post('/api/gethelp/red-flags', { answers: RED_FLAGS.map((q, i) => ({ question: q, yes: flags[i] })) }).catch(() => {});
      setSaved(true);
      void queryClient.invalidateQueries();
      if (redFlags.length) navigate('/help');
    } catch (e: any) { toast(e.message); }
  };
  const slider = (key: 'energy' | 'dread' | 'effective', label: string) => (
    <Item>
      <div className="title">{label}</div>
      <input type="range" min={0} max={10} value={v[key]} onChange={(e) => setV({ ...v, [key]: Number(e.target.value) })} aria-label={label} style={{ width: 180 }} />
      <span className="num" style={{ width: 22, textAlign: 'right' }}>{v[key]}</span>
    </Item>
  );
  return (
    <>
      <p className="ob-lede">Honest numbers for where you are now, so the weekly review can tell whether the plan is working.</p>
      <Group>
        <Item><div className="title">Actual bedtime lately</div><Input type="time" value={v.bedtime} onChange={(e) => setV({ ...v, bedtime: e.target.value })} aria-label="Bedtime" /></Item>
        <Item><div className="title">Actual wake time lately</div><Input type="time" value={v.wakeTime} onChange={(e) => setV({ ...v, wakeTime: e.target.value })} aria-label="Wake time" /></Item>
        <Item><div className="title">Last caffeine, usually</div><Input type="time" value={v.caffeineTime} onChange={(e) => setV({ ...v, caffeineTime: e.target.value })} aria-label="Caffeine time" /></Item>
        {slider('energy', 'Energy (0–10)')}
        {slider('dread', 'Dread or cynicism (0–10)')}
        {slider('effective', '“I’m effective” (0–10)')}
        <Item><div className="title"><div>Phase 1 starts</div><div className="sub">Stabilize for two weeks: hold the stop, sleep first, nothing new.</div></div><Input type="date" value={v.phase1Start} onChange={(e) => setV({ ...v, phase1Start: e.target.value })} aria-label="Phase 1 start" /></Item>
      </Group>
      <Section title="Any of these, lately?" why="Any yes opens Get help. It’s there to help, not to label you.">
        <Group>
          {RED_FLAGS.map((f, i) => (
            <Item key={f}>
              <div className="title">{f}</div>
              <Toggle checked={flags[i]} label={f} onChange={(x) => setFlags(flags.map((y, j) => (j === i ? x : y)))} />
            </Item>
          ))}
        </Group>
      </Section>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        {saved ? <Tag tone="green">Saved</Tag> : <Button variant="primary" onClick={save}>Save Baseline</Button>}
      </div>
    </>
  );
}

export default defineWebModule({
  id: 'onboarding',
  routes: [{ path: '/onboarding', component: Onboarding }],
  commands: [{ id: 'onboarding.restart', label: 'Run onboarding again', group: 'Setup', run: async ({ navigate }) => { await api.post('/api/onboarding/restart'); await queryClient.invalidateQueries(); navigate('/onboarding'); } }],
});
