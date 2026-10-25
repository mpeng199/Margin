import { useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Page } from '@web/app/Page';
import { useApi } from '@web/lib/query';
import { useEnabled } from '@web/lib/hooks';
import { Segmented, Button, Empty, Group, Section } from '@web/ui';
import { People } from '../../delegation/web';
import { Dot, StatusTag, type Detail } from './shared';
import { OverviewView } from './views/Overview';
import { TasksView } from './views/Tasks';
import { TimelineView } from './views/Timeline';
import { CalendarView } from './views/CalendarView';
import { NotesView } from './views/Notes';
import { LogView } from './views/Log';

export const VIEWS = [
  { value: 'overview', label: 'Overview' }, { value: 'tasks', label: 'Tasks' }, { value: 'timeline', label: 'Timeline' }, { value: 'calendar', label: 'Calendar' },
  { value: 'people', label: 'People' }, { value: 'notes', label: 'Notes' }, { value: 'log', label: 'Log' },
] as const;
export type View = (typeof VIEWS)[number]['value'];

export function ProjectPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const q = useApi<Detail>(`/api/projects/${id}`);
  const [, navigate] = useLocation();
  const search = useSearch();
  const wanted = new URLSearchParams(search).get('v');
  const view: View = VIEWS.find((v) => v.value === wanted)?.value ?? 'overview';
  const setView = (v: View) => navigate(`/projects/${id}${v === 'overview' ? '' : `?v=${v}`}`, { replace: true });
  const people = useEnabled('delegation');

  // ⌘⌥1–7 jump between sub-views.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
      const m = /^Digit([1-7])$/.exec(e.code);
      if (m) { e.preventDefault(); setView(VIEWS[Number(m[1]) - 1].value); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const p = q.data;
  if (q.isError && !p) {
    return <Page title="Project" width="narrow"><Section><Group><Empty action={<Button onClick={() => navigate('/projects')}>All Projects</Button>}>This project no longer exists.</Empty></Group></Section></Page>;
  }
  return (
    <Page title={p ? <span className="pj-title"><Dot color={p.color} size={12} />{p.name}</span> : 'Project'} subtitle={p ? <StatusTag status={p.status} /> : undefined} width={view === 'timeline' || view === 'calendar' ? 'full' : 'wide'}>
      <div className="pj-viewbar">
        <Segmented label="Project view" value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
        <span className="faint tiny">⌘⌥1 to 7</span>
      </div>
      {p && (
        <div key={`${id}:${view}`}>
          {view === 'overview' && <OverviewView id={id} project={p} />}
          {view === 'tasks' && <TasksView id={id} hasLink={!!p.todoist} goOverview={() => setView('overview')} />}
          {view === 'timeline' && <TimelineView id={id} project={p} />}
          {view === 'calendar' && <CalendarView id={id} project={p} />}
          {view === 'people' && (people ? <People projectId={id} /> : <Section><Group><Empty>Delegation is turned off. Turn it on in Settings to track owners and waiting-on items.</Empty></Group></Section>)}
          {view === 'notes' && <NotesView id={id} />}
          {view === 'log' && <LogView id={id} />}
        </div>
      )}
    </Page>
  );
}
