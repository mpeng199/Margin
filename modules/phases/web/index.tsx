import './phases.css';
import { defineWebModule } from '@web/lib/module';
import { useApi } from '@web/lib/query';
import { Icon } from '@web/ui';
import type { Phase, PhaseInfo } from '../manifest';

const PHASE_NAMES: Record<Phase, string> = { stabilize: 'Stabilize', recover: 'Recover', rebuild: 'Rebuild' };

/** "Stabilize · week 1 of 2", with the rules for this phase one click away. */
function PhaseBanner() {
  const { data: p } = useApi<PhaseInfo>('/api/phases/current');
  if (!p) return null;
  const of = p.phaseWeeks && p.week <= p.phaseWeeks ? ` of ${p.phaseWeeks}` : '';
  return (
    <details className="phase-banner">
      <summary>
        <strong>{PHASE_NAMES[p.phase]}</strong> · week {p.week}{of}
        <Icon name="ChevronRight" size={14} className="chev" />
      </summary>
      <div className="phase-body">
        <ul>{p.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        {p.holdReason && <p>{p.holdReason}</p>}
      </div>
    </details>
  );
}

export default defineWebModule({
  id: 'phases',
  widgets: { phase: PhaseBanner },
});
