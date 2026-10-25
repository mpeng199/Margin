import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Page } from '@web/app/Page';
import { api } from '@web/lib/api';
import { useApi } from '@web/lib/query';
import { fmtDur, relDay } from '@web/lib/format';
import { Section, Group, Item, Button, Sheet, Field, Input, Select, Segmented, Banner, Empty, Tag, Icon, toast } from '@web/ui';
import { slugify } from '../model';
import { ActivateSheet } from './views/Activate';
import { Dot, ErrorLine, ICONS, Swatches, useSend, type Project, type Summary, type SummaryProject, type Template } from './shared';
import { PALETTE } from '../model';

type Link = 'none' | 'project' | 'create' | 'label';
interface TdStatus { connected: boolean; plan: { maxProjects: number; projectsLeft: number } | null }

function NewProjectSheet({ onClose, locked, projects }: { onClose: () => void; locked?: string; projects: Project[] }) {
  const [, navigate] = useLocation();
  const { busy, error, run } = useSend();
  const templates = useApi<Template[]>('/api/projects/templates');
  const td = useApi<TdStatus>('/api/todoist/status');
  const tdProjects = useApi<{ id: string; name: string; inbox?: boolean }[]>('/api/todoist/projects');
  const tdLabels = useApi<{ id: string; name: string }[]>('/api/todoist/labels');
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[projects.length % PALETTE.length]);
  const [icon, setIcon] = useState('Folder');
  const [templateId, setTemplateId] = useState('');
  const [hours, setHours] = useState('');
  const [link, setLink] = useState<Link>('none');
  const [tdProject, setTdProject] = useState('');
  const [label, setLabel] = useState('');
  const [calendar, setCalendar] = useState(false);
  const full = !!td.data?.plan && td.data.plan.projectsLeft <= 0;
  const takenP = new Set(projects.filter((p) => !p.archived && p.todoist?.type === 'project').map((p) => p.todoist!.id));
  const takenL = new Set(projects.filter((p) => !p.archived && p.todoist?.type === 'label').map((p) => p.todoist!.name));
  const freeProjects = (tdProjects.data ?? []).filter((p) => !p.inbox && !takenP.has(p.id));
  useEffect(() => { const t = templates.data?.find((x) => x.id === templateId); if (t?.data.icon) setIcon(t.data.icon); }, [templateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const id = await run(async () => {
      const made = await api.post<Project>('/api/projects', {
        name, color, icon, ...(templateId ? { templateId } : {}), ...(hours ? { sizeMin: Math.round(Number(hours) * 60) } : {}),
      });
      return made.id;
    });
    if (!id) return;
    const notes: string[] = [];
    try {
      if (link === 'project' && tdProject) await api.post(`/api/projects/${id}/todoist`, { mode: 'project', projectId: tdProject });
      else if (link === 'label') await api.post(`/api/projects/${id}/todoist`, { mode: 'label', name: label.trim() || slugify(name) });
      else if (link === 'create') await api.post(`/api/projects/${id}/todoist`, { mode: 'create', confirm: true });
    } catch (e: any) { notes.push(`Todoist link: ${e.message}`); }
    try { if (calendar) await api.post(`/api/projects/${id}/calendar-link`, { mode: 'create' }); } catch (e: any) { notes.push(`Calendar: ${e.message}`); }
    if (notes.length) toast(`Created ${name}. ${notes.join(' ')} Link it from the Overview.`, undefined, 8000);
    onClose();
    navigate(`/projects/${id}`);
  };

  return (
    <Sheet open onClose={onClose} title="New Project" subtitle="New projects start as Proposed and become active after you pause or drop something of equal size."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim() || !!locked || (link === 'project' && !tdProject) || (link === 'create' && full)} onClick={submit}>Create Project</Button></>}>
      <div className="stack">
        {locked && <Banner tone="amber" icon="Lock">{locked}</Banner>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !locked && !busy) void submit(); }} /></Field>
        <Field label="Color"><Swatches value={color} onChange={setColor} /></Field>
        <div className="form-grid">
          <Field label="Icon"><Select value={icon} onChange={(e) => setIcon(e.target.value)}>{ICONS.map((i) => <option key={i}>{i}</option>)}</Select></Field>
          <Field label="Status" hint="Activate it from the project or the weekly review."><Input value="Proposed" disabled readOnly /></Field>
          <Field label="Template" hint={templates.data?.find((t) => t.id === templateId)?.description}>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">None</option>
              {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Typical hours a week" hint="Used to compare projects when trading one for another."><Input type="number" min={0} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" /></Field>
        </div>
        <Field label="Todoist">
          <Segmented label="Todoist link" value={link} onChange={setLink} options={[{ value: 'none', label: 'None' }, { value: 'project', label: 'Existing Project' }, { value: 'create', label: 'New Project' }, { value: 'label', label: 'Label' }]} />
        </Field>
        {link === 'project' && (
          <Field label="Todoist project">
            <Select value={tdProject} onChange={(e) => setTdProject(e.target.value)}>
              <option value="">Choose a project</option>
              {freeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        )}
        {link === 'label' && <Field label="Label" hint="Tasks with this label show on the tab. Created if it doesn’t exist."><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={slugify(name || 'project')} list="pj-labels" /><datalist id="pj-labels">{(tdLabels.data ?? []).filter((l) => !takenL.has(l.name)).map((l) => <option key={l.id} value={l.name} />)}</datalist></Field>}
        {link === 'create' && full && (
          <Banner tone="amber" icon="Info">Your Todoist plan allows {td.data!.plan!.maxProjects} active projects and all are in use. Choose Label instead: tasks still live in Todoist and the tab shows them the same way.</Banner>
        )}
        {link === 'create' && !full && <p className="small muted">Creates an empty Todoist project with this name and links the tab to it.</p>}
        <div className="row">
          <div className="grow"><div>Create its own calendar</div><div className="small muted">A Google calendar for this project’s phases, milestones and sessions.</div></div>
          <Segmented label="Own calendar" value={calendar ? 'yes' : 'no'} onChange={(v) => setCalendar(v === 'yes')} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
        </div>
        <ErrorLine error={error} />
      </div>
    </Sheet>
  );
}

function ProjectRow({ p, sp, restartDue, onActivate }: { p: Project; sp?: SummaryProject; restartDue?: boolean; onActivate?: () => void }) {
  const [, navigate] = useLocation();
  const go = () => navigate(`/projects/${p.id}`);
  const spent = sp?.spent;
  const next = sp?.nextMilestone;
  return (
    <Item onClick={go} role="link" tabIndex={0} onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) go(); }}>
      <Dot color={p.color} size={12} />
      <div className="title">
        <div>{p.name}</div>
        <div className="sub">
          {p.status === 'pause' && p.restartDate ? `Restart decision ${relDay(p.restartDate).toLowerCase()}` : next ? `${next.title}, ${relDay(next.date).toLowerCase()}` : p.purpose || (p.status === 'maintain' ? p.maintenance?.action : '') || 'No milestone set'}
        </div>
      </div>
      {p.isSchool && <Tag>School</Tag>}
      {restartDue && <Tag tone="amber">Restart date reached</Tag>}
      {spent && spent.budgetMin > 0 && <span className="meta num" title="This week, logged against budget">{fmtDur(spent.actualMin)} of {fmtDur(spent.budgetMin)}</span>}
      {onActivate ? <Button onClick={(e) => { e.stopPropagation(); onActivate(); }}>Activate…</Button> : <Icon name="ChevronRight" size={14} className="faint" />}
    </Item>
  );
}

export function ProjectsPage() {
  const sum = useApi<Summary>('/api/projects/summary');
  const archived = useApi<Project[]>('/api/projects?archived=1');
  const [, navigate] = useLocation();
  const search = useSearch();
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState<Project | null>(null);
  useEffect(() => {
    if (new URLSearchParams(search).get('new') === '1') { setCreating(true); navigate('/projects', { replace: true }); }
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = sum.data;
  const by = (st: string) => (s?.projects ?? []).filter((p) => p.status === st);
  const dropped = (archived.data ?? []).filter((p) => p.status === 'drop');
  const locked = s && !s.canAdd.allowed ? s.canAdd.reason ?? 'Adding projects is locked right now.' : undefined;
  const groups: { title: string; list: SummaryProject[]; why?: string }[] = [
    { title: 'Core', list: by('core') }, { title: 'Maintain', list: by('maintain'), why: 'Each has a weekly minimum and a cap.' },
    { title: 'Paused', list: by('pause'), why: 'Hidden from Today and planning. Tasks are kept.' },
  ];
  return (
    <Page title="Projects" actions={<Button variant="primary" icon="Plus" disabled={!!locked} title={locked} onClick={() => setCreating(true)}>New Project</Button>}>
      {locked && <div style={{ marginTop: 12 }}><Banner tone="amber" icon="Lock">{locked}</Banner></div>}
      {s && (
        <Section title="Work in progress" why="Two non-school projects at a time (Margin spec 4.5).">
          <Group pad>
            <div className="row">
              <div className="pj-wip" role="meter" aria-valuemin={0} aria-valuemax={s.wip.limit} aria-valuenow={s.wip.count} aria-label="Non-school projects that are Core">
                {Array.from({ length: Math.max(s.wip.limit, s.wip.count) }, (_, i) => <span key={i} data-on={i < s.wip.count} data-over={i >= s.wip.limit} />)}
              </div>
              <div className="grow"><span className="num">{s.wip.count} of {s.wip.limit}</span> non-school projects are Core</div>
              {s.wip.exceeded ? <Tag tone="amber">Over the limit</Tag> : s.wip.full ? <Tag>Full</Tag> : <Tag tone="green">Room for one more</Tag>}
            </div>
            {s.wip.exceeded && <p className="small muted" style={{ marginTop: 8 }}>Pause or drop one from its Overview.</p>}
          </Group>
        </Section>
      )}
      {s && s.proposed.length > 0 && (
        <Section title="Proposed" why="Yes requires a no. Activate one by pausing or dropping something of equal size.">
          <Group>{s.proposed.map((p) => <ProjectRow key={p.id} p={p} sp={s.projects.find((x) => x.id === p.id)} onActivate={() => setActivating(p)} />)}</Group>
        </Section>
      )}
      {groups.map((g) => g.list.length > 0 && (
        <Section key={g.title} title={g.title} why={g.why}>
          <Group>{g.list.map((p) => <ProjectRow key={p.id} p={p} sp={p} restartDue={s?.restartDue.includes(p.id)} />)}</Group>
        </Section>
      ))}
      {dropped.length > 0 && <Section title="Dropped" why="Archived with their data."><Group>{dropped.map((p) => <ProjectRow key={p.id} p={p} />)}</Group></Section>}
      {s && !s.projects.length && !dropped.length && <Section><Group><Empty action={<Button variant="primary" onClick={() => setCreating(true)} disabled={!!locked}>New Project</Button>}>No projects yet.</Empty></Group></Section>}
      {creating && <NewProjectSheet onClose={() => setCreating(false)} locked={locked} projects={[...(s?.projects ?? []), ...(archived.data ?? [])]} />}
      <ActivateSheet project={activating} tradeoffs={s?.tradeoffs ?? []} onClose={() => setActivating(null)} />
    </Page>
  );
}
