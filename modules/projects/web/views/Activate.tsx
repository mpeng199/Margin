import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { api } from '@web/lib/api';
import { fmtDur, todayISO } from '@web/lib/format';
import { addDays } from '@core/time';
import { Button, Sheet, Field, Select, Input, Segmented, Why } from '@web/ui';
import { ErrorLine, MaintenanceFields, emptyMaintenance, useSend, type Project, type Maintenance } from '../shared';

/** "Yes requires a no": a proposed project activates only after pausing or dropping something of equal or larger size. */
export function ActivateSheet({ project, tradeoffs, onClose }: { project: Project | null; tradeoffs: Project[]; onClose: () => void }) {
  const [, navigate] = useLocation();
  const { busy, error, run, setError } = useSend();
  const options = tradeoffs.filter((t) => t.id !== project?.id);
  const [tradeOffId, setTrade] = useState('');
  const [action, setAction] = useState<'pause' | 'drop'>('pause');
  const [restart, setRestart] = useState(addDays(todayISO(), 28));
  const [target, setTarget] = useState<'core' | 'maintain'>('core');
  const [mt, setMt] = useState<Maintenance>(emptyMaintenance());
  useEffect(() => {
    if (!project) return;
    setError(null); setAction('pause'); setTarget('core'); setMt(emptyMaintenance(project.maintenance)); setRestart(addDays(todayISO(), 28));
    setTrade(options.find((t) => t.sizeMin >= project.sizeMin)?.id ?? options[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  if (!project) return null;
  const submit = async () => {
    const out = await run(() => api.post<Project & { changeSetId?: string }>(`/api/projects/${project.id}/activate`, {
      tradeOffId: tradeOffId || null, action, ...(action === 'pause' && tradeOffId ? { restartDate: restart } : {}), status: target, ...(target === 'maintain' ? { maintenance: mt } : {}),
    }));
    if (!out) return;
    onClose();
    navigate(out.changeSetId ? `/changes/${out.changeSetId}` : `/projects/${project.id}`);
  };
  return (
    <Sheet open onClose={onClose} title={`Activate ${project.name}`} subtitle="Yes requires a no. Pick something of equal or larger size to pause or drop."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={submit}>Activate</Button></>}>
      <div className="stack">
        {options.length > 0 ? (
          <Field label="Pause or drop" hint={`${project.name} takes about ${project.sizeMin ? fmtDur(project.sizeMin) : 'no set time'} a week.`}>
            <Select value={tradeOffId} onChange={(e) => setTrade(e.target.value)}>
              {options.map((t) => <option key={t.id} value={t.id}>{t.name}, {t.sizeMin ? `${fmtDur(t.sizeMin)} a week` : 'no size set'}</option>)}
            </Select>
          </Field>
        ) : <p className="muted small">No other non-school project is active, so nothing needs to be traded.</p>}
        {tradeOffId && (
          <div className="row">
            <Segmented label="What happens to it" value={action} onChange={setAction} options={[{ value: 'pause', label: 'Pause' }, { value: 'drop', label: 'Drop' }]} />
            {action === 'pause' && <Field label="Restart date"><Input type="date" value={restart} min={addDays(todayISO(), 1)} onChange={(e) => setRestart(e.target.value)} /></Field>}
          </div>
        )}
        {action === 'drop' && tradeOffId && <p className="small muted">Dropping archives the tab and keeps its data. Its open Todoist tasks are closed out through a change set you review first.</p>}
        <Field label="Activate as">
          <Segmented label="Activate as" value={target} onChange={setTarget} options={[{ value: 'core', label: 'Core' }, { value: 'maintain', label: 'Maintain' }]} />
        </Field>
        {target === 'maintain' && <MaintenanceFields value={mt} onChange={setMt} />}
        <ErrorLine error={error} />
        <Why source="Panagioti 2017">Two non-school projects at a time. A new one waits until something of equal size steps aside.</Why>
      </div>
    </Sheet>
  );
}
