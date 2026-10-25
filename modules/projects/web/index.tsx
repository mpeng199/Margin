import './projects.css';
import { useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction } from '@web/lib/query';
import { Icon } from '@web/ui';
import type { Project } from '../model';
import { ProjectsPage } from './ProjectsPage';
import { ProjectPage, VIEWS } from './ProjectPage';

const readOpen = () => { try { return localStorage.getItem('pj.paused') === '1'; } catch { return false; } };

/** Projects under the main nav. ⌥⌘↑/↓ on a focused row moves it; Paused projects collapse into their own group. */
function Sidebar({ locked }: { locked: boolean }) {
  const { data } = useApi<Project[]>('/api/projects');
  const [loc, navigate] = useLocation();
  const [open, setOpen] = useState(readOpen);
  const focusId = useRef<string | null>(null);
  const reorder = useAction<{ ids: string[] }>('post', '/api/projects/reorder', () => {
    const id = focusId.current;
    if (id) setTimeout(() => document.querySelector<HTMLElement>(`[data-pj-row="${id}"]`)?.focus(), 60);
  });
  const list = data ?? [];
  const live = list.filter((p) => p.status !== 'pause');
  const paused = list.filter((p) => p.status === 'pause');
  const move = (id: string, dir: -1 | 1) => {
    const i = live.findIndex((p) => p.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= live.length) return;
    const ids = live.map((p) => p.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    focusId.current = id;
    reorder.mutate({ ids: [...ids, ...paused.map((p) => p.id)] });
  };
  const toggle = () => { const v = !open; setOpen(v); try { localStorage.setItem('pj.paused', v ? '1' : '0'); } catch { /* ignore */ } };
  const row = (p: Project, reorderable: boolean) => {
    const active = loc === `/projects/${p.id}`;
    return (
      <Link key={p.id} href={`/projects/${p.id}`} data-pj-row={p.id} className={`side-item pj-side-row${locked ? ' locked' : ''}`} aria-current={active ? 'page' : undefined}
        title={reorderable ? `${p.name}. ⌥⌘↑ and ⌥⌘↓ reorder.` : p.name}
        onKeyDown={(e) => {
          if (!reorderable || !e.altKey || !e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault(); move(p.id, e.key === 'ArrowUp' ? -1 : 1);
        }}>
        <span className="dot" style={{ background: p.color }} aria-hidden="true" />
        <span className="pj-name">{p.name}</span>
        {p.status === 'proposed' && <span className="count">Proposed</span>}
      </Link>
    );
  };
  return (
    <>
      <div className="side-section" role="presentation">
        <span>Projects</span>
        <button type="button" className="pj-side-add" aria-label="New project" title="New project" onClick={() => navigate('/projects?new=1')}><Icon name="Plus" size={13} strokeWidth={2.25} /></button>
      </div>
      {live.map((p) => row(p, true))}
      {paused.length > 0 && (
        <>
          <button type="button" className="side-item pj-paused-toggle" aria-expanded={open} onClick={toggle}>
            <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} />
            <span>Paused</span><span className="count">{paused.length}</span>
          </button>
          {open && <div className="pj-paused">{paused.map((p) => row(p, false))}</div>}
        </>
      )}
    </>
  );
}

const currentId = () => /^\/projects\/([^/?]+)/.exec(window.location.pathname)?.[1] ?? null;

export default defineWebModule({
  id: 'projects',
  routes: [
    { path: '/projects', component: ProjectsPage, work: true },
    { path: '/projects/:id', component: ProjectPage, work: true },
  ],
  sidebar: Sidebar,
  commands: [
    { id: 'projects.new', label: 'New Project', group: 'Projects', run: () => '/projects?new=1' },
    { id: 'projects.all', label: 'Show All Projects', group: 'Projects', run: () => '/projects' },
    ...VIEWS.map((v, i) => ({
      id: `projects.view.${v.value}`, label: `Project: ${v.label}`, group: 'Projects', shortcut: `⌘⌥${i + 1}`,
      run: () => { const id = currentId(); return id ? `/projects/${id}${v.value === 'overview' ? '' : `?v=${v.value}`}` : '/projects'; },
    })),
  ],
});
