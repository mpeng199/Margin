import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '@web/lib/api';
import { useApi, useAction } from '@web/lib/query';
import { fmtDur, relDay, fmtDay, todayISO } from '@web/lib/format';
import { addDays } from '@core/time';
import { Section, Group, Item, Button, Sheet, Field, Input, TextArea, Segmented, CapacityBar, Banner, Tag } from '@web/ui';
import { SEPARATIONS, type Separation } from '../../model';
import { ActivateSheet } from './Activate';
import { Links } from './Links';
import { ErrorLine, MaintenanceFields, StatusTag, emptyMaintenance, useSend, STATUS_LABEL, type Detail, type Maintenance, type Overview as Ov, type Project, type Status, type Summary } from '../shared';

const SEP_LABEL: Record<Separation, string> = { hidden: 'Hidden', milestones: 'Milestones and deadlines', everything: 'Everything' };
const SEP_NOTE: Record<Separation, string> = {
  hidden: 'Nothing from this project shows on Today or your main calendar except its work sessions and meetings.',
  milestones: 'Milestones and deadlines show on your main calendar. Phases and other all-day items stay here.',
  everything: 'Phases, milestones, deadlines and all-day items all show on your main calendar.',
};

/** A text field that saves when you leave it. */
function Inline({ label, value, onSave, multiline, placeholder }: { label: string; value: string; onSave: (v: string) => void; multiline?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value.trim()) onSave(v.trim()); };
  return (
    <Item>
      <div className="title">
        <div className="small muted">{label}</div>
        {multiline
          ? <TextArea className="bare pj-inline" rows={2} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} aria-label={label} />
          : <Input className="bare" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label={label} />}
      </div>
    </Item>
  );
}

function MaintenanceSheet({ p, onClose }: { p: Project; onClose: () => void }) {
  const { busy, error, run } = useSend();
  const [m, setM] = useState<Maintenance>(emptyMaintenance(p.maintenance));
  return (
    <Sheet open onClose={onClose} title="Maintenance Line" subtitle="The least this project gets each week while it is on Maintain."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={async () => { if (await run(() => api.patch(`/api/projects/${p.id}`, { maintenance: m }))) onClose(); }}>Save</Button></>}>
      <div className="stack"><MaintenanceFields value={m} onChange={setM} /><ErrorLine error={error} /></div>
    </Sheet>
  );
}

function StatusSheet({ p, onClose }: { p: Project; onClose: () => void }) {
  const [, navigate] = useLocation();
  const { busy, error, run, setError } = useSend();
  const [status, setStatus] = useState<Status>(p.status === 'pause' || p.status === 'drop' ? 'core' : p.status);
  const [restart, setRestart] = useState(p.restartDate ?? addDays(todayISO(), 28));
  const [mt, setMt] = useState<Maintenance>(emptyMaintenance(p.maintenance));
  const [archiveTd, setArchiveTd] = useState(false);
  useEffect(() => setError(null), [status, setError]);
  const submit = async () => {
    const body: Record<string, unknown> = { status, reason: `Changed from ${STATUS_LABEL[p.status]}` };
    if (status === 'pause') body.restartDate = restart;
    if (status === 'maintain') body.maintenance = mt;
    if (status === 'drop' && p.todoist?.type === 'project') body.archiveTodoistProject = archiveTd;
    const out = await run(() => api.post<Project & { changeSetId?: string }>(`/api/projects/${p.id}/status`, body));
    if (!out) return;
    onClose();
    if (out.changeSetId) navigate(`/changes/${out.changeSetId}`);
  };
  const opts: { value: Status; label: string }[] = [{ value: 'core', label: 'Core' }, { value: 'maintain', label: 'Maintain' }, { value: 'pause', label: 'Pause' }, { value: 'drop', label: 'Drop' }];
  return (
    <Sheet open onClose={onClose} title="Change Status" subtitle={`${p.name} is ${STATUS_LABEL[p.status].toLowerCase()} now.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || status === p.status} onClick={submit}>{status === 'drop' ? 'Drop Project' : status === 'pause' ? 'Pause Project' : `Set to ${STATUS_LABEL[status]}`}</Button></>}>
      <div className="stack">
        <Segmented label="New status" value={status} onChange={setStatus} options={p.isSchool ? opts.slice(0, 2) : opts} />
        {p.isSchool && <p className="small muted">School stays Core or Maintain. It can’t be paused or dropped here.</p>}
        {status === 'core' && <p className="small muted">Core projects get planned time every week. At most two non-school projects can be Core.</p>}
        {status === 'maintain' && <MaintenanceFields value={mt} onChange={setMt} />}
        {status === 'pause' && (
          <Field label="Restart date" hint="Hidden from Today and planning until then. Margin asks whether to bring it back; it never resumes on its own."><Input type="date" min={addDays(todayISO(), 1)} value={restart} onChange={(e) => setRestart(e.target.value)} /></Field>
        )}
        {status === 'drop' && (
          <>
            <p className="small">Dropping archives this tab and keeps its data. Its open Todoist tasks are closed out through a change set, which opens for your review. Nothing is deleted.</p>
            {p.todoist?.type === 'project' && (
              <label className="row small"><input type="checkbox" checked={archiveTd} onChange={(e) => setArchiveTd(e.target.checked)} /> Also archive the linked Todoist project (kept, not deleted)</label>
            )}
          </>
        )}
        <ErrorLine error={error} />
      </div>
    </Sheet>
  );
}

export function OverviewView({ id, project }: { id: string; project: Detail }) {
  const ov = useApi<Ov>(`/api/projects/${id}/overview`);
  const sum = useApi<Summary>('/api/projects/summary');
  const patch = useAction<Record<string, unknown>>('patch', `/api/projects/${id}`);
  const [sheet, setSheet] = useState<'status' | 'maint' | 'activate' | null>(null);
  const o = ov.data;
  const p = project;
  const b = o?.budget;
  const save = (k: string) => (v: string) => patch.mutate({ [k]: v });
  return (
    <>
      {p.status === 'proposed' && (
        <div style={{ marginTop: 12 }}>
          <Banner tone="amber" icon="Scale" action={<Button variant="primary" onClick={() => setSheet('activate')}>Activate…</Button>} why="Yes requires a no (Margin spec 4.5).">
            This project is proposed. Activating it means pausing or dropping something of equal or larger size.
          </Banner>
        </div>
      )}
      <Section title="About">
        <Group>
          <Inline label="Purpose" value={p.purpose} multiline placeholder="Why this project exists, in a sentence" onSave={save('purpose')} />
          <Inline label="Current goal" value={p.goal} placeholder="What done looks like this term" onSave={save('goal')} />
          {(p.status === 'maintain' || p.maintenance) && (
            <Item>
              <div className="title"><div className="small muted">Maintenance line</div>
                {p.maintenance ? <>{p.maintenance.action}<div className="sub">Up to {fmtDur(p.maintenance.capMin)} a week. Told: {p.maintenance.told || 'nobody yet'}.</div></> : <span className="muted">Not set</span>}
              </div>
              <Button onClick={() => setSheet('maint')}>Edit…</Button>
            </Item>
          )}
          <Item>
            <div className="title"><div className="small muted">Next milestone</div>
              {o?.nextMilestone ? <>{o.nextMilestone.title}<div className="sub">{fmtDay(o.nextMilestone.date)}, {relDay(o.nextMilestone.date).toLowerCase()}{o.nextMilestone.kind === 'deadline' ? ', deadline' : ''}</div></> : <span className="muted">None on the timeline</span>}
            </div>
            {o?.currentPhase && <Tag>{o.currentPhase.title}</Tag>}
          </Item>
        </Group>
      </Section>

      <Section title="This week" why="Time logged to this project against what you budgeted.">
        <Group pad>
          {b && b.budgetMin > 0 ? (
            <>
              <div className="row"><span className="grow num">{fmtDur(b.actualMin)} of {fmtDur(b.budgetMin)}</span>{b.over && <Tag tone="amber">Over budget</Tag>}</div>
              <div style={{ margin: '8px 0 6px' }}><CapacityBar loadMin={b.actualMin} freeMin={b.budgetMin} /></div>
              <div className="small muted">Focus timer {fmtDur(b.focusMin)}. Calendar sessions {fmtDur(b.eventMin)}.</div>
            </>
          ) : <div className="small muted">No weekly budget yet. {b && b.actualMin > 0 ? `${fmtDur(b.actualMin)} logged this week.` : ''}</div>}
          <Field label="Weekly budget (minutes)"><Input type="number" min={0} step={15} defaultValue={p.weeklyBudgetMin || ''} key={p.weeklyBudgetMin} onBlur={(e) => { const n = Math.max(0, Math.round(Number(e.target.value) || 0)); if (n !== p.weeklyBudgetMin) patch.mutate({ weeklyBudgetMin: n }); }} /></Field>
        </Group>
      </Section>

      <Section title="Open loops">
        <Group>
          <Item><div className="title">Open tasks</div><span className="meta num">{o?.openLoops.openTasks ?? 0}</span></Item>
          <Item><div className="title">Overdue</div><span className="meta num">{o?.openLoops.overdue ?? 0}</span></Item>
          {(o?.openLoops.waiting ?? []).map((w) => (
            <Item key={w.id}><div className="title">Waiting on {w.who || 'someone'}<div className="sub">{w.what}</div></div><span className="meta">{w.due ? `due ${relDay(w.due).toLowerCase()}` : `since ${relDay(w.since).toLowerCase()}`}</span></Item>
          ))}
        </Group>
      </Section>

      {o && o.hotspots.length > 0 && (
        <Section title="Carry-over hotspots" why="Tasks that rolled over twice or more are usually too big, unclear, or not yours.">
          <Group>
            {o.hotspots.map((h) => (
              <Item key={h.id}><div className="title">{h.content}{h.nextAction && <div className="sub">Next action: {h.nextAction}</div>}</div><Tag tone="amber">Carried {h.carryCount}×</Tag></Item>
            ))}
          </Group>
        </Section>
      )}

      <Section title="Status">
        <Group>
          <Item>
            <div className="title">Status<div className="sub">{p.status === 'pause' && p.restartDate ? `Restart decision ${fmtDay(p.restartDate)}` : p.status === 'maintain' ? 'Held at its maintenance line' : p.status === 'core' ? 'Planned every week' : ''}</div></div>
            <StatusTag status={p.status} />
            {p.status !== 'proposed' && <Button onClick={() => setSheet('status')}>Change…</Button>}
          </Item>
          {(o?.statusLog ?? []).slice(0, 3).map((s) => (
            <Item key={s.id}><div className="title small muted">{s.from ? `${STATUS_LABEL[s.from]} to ${STATUS_LABEL[s.to]}` : `Created as ${STATUS_LABEL[s.to]}`}{s.note ? `. ${s.note}` : ''}</div><span className="meta">{fmtDay(s.at.slice(0, 10))}</span></Item>
          ))}
        </Group>
      </Section>

      <Section title="Separation" why="Controls how much of this project reaches your main calendar and Today.">
        <Group pad>
          <Segmented label="Separation" value={p.separation} onChange={(v) => patch.mutate({ separation: v })} options={SEPARATIONS.map((s) => ({ value: s, label: SEP_LABEL[s] }))} />
          <p className="small muted" style={{ marginTop: 8 }}>{SEP_NOTE[p.separation]}</p>
        </Group>
      </Section>

      <Links p={p} />
      {sheet === 'status' && <StatusSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'maint' && <MaintenanceSheet p={p} onClose={() => setSheet(null)} />}
      <ActivateSheet project={sheet === 'activate' ? p : null} tradeoffs={sum.data?.tradeoffs ?? []} onClose={() => setSheet(null)} />
    </>
  );
}
