import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useLocation } from 'wouter';
import { Icon } from '../ui';
import { usePaletteOpen, closePalette, openCapture } from './palette-store';
import { webModules } from '../lib/webModule';
import { useModules } from '../lib/hooks';
import { useApi } from '../lib/query';

export function Palette({ nav }: { nav: { id: string; label: string; icon: string; path: string; shortcut?: string }[] }) {
  const open = usePaletteOpen();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');
  const modules = useModules();
  const enabled = new Set((modules.data ?? []).filter((m) => m.enabled).map((m) => m.id));
  const projects = useApi<any[]>(enabled.has('projects') && open ? '/api/projects' : null);
  const notes = useApi<{ id: string; title: string; area: string }[]>(enabled.has('brain') && open ? '/api/brain/titles' : null);
  useEffect(() => { if (!open) setSearch(''); }, [open]);
  if (!open) return null;
  const go = (path: string) => { closePalette(); navigate(path); };
  const commands = webModules.filter((w) => enabled.has(w.id)).flatMap((w) => w.commands ?? []);
  const groups = new Map<string, typeof commands>();
  for (const c of commands) { const g = c.group ?? 'Actions'; groups.set(g, [...(groups.get(g) ?? []), c]); }
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closePalette(); }}>
      <Command label="Command palette" loop onKeyDown={(e) => { if (e.key === 'Escape') closePalette(); }}>
        <Command.Input autoFocus placeholder="Go to, or do…" value={search} onValueChange={setSearch} />
        <Command.List>
          <Command.Empty>No matches.</Command.Empty>
          <Command.Group heading="Go to">
            {nav.map((n) => (
              <Command.Item key={n.id} value={`go ${n.label}`} onSelect={() => go(n.path)}>
                <Icon name={n.icon} /> {n.label}
                {n.shortcut && <span className="kbd">{n.shortcut.replace('Mod+', '⌘')}</span>}
              </Command.Item>
            ))}
            {(projects.data ?? []).filter((p) => p.status !== 'drop').map((p) => (
              <Command.Item key={p.id} value={`project ${p.name}`} onSelect={() => go(`/projects/${p.id}`)}>
                <span className="dot" style={{ width: 9, height: 9, borderRadius: 5, background: p.color, display: 'inline-block', margin: '0 3px' }} /> {p.name}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Actions">
            <Command.Item value="quick capture new task" onSelect={() => { closePalette(); openCapture(); }}>
              <Icon name="Plus" /> Quick capture <span className="kbd">⌘N</span>
            </Command.Item>
            <Command.Item value="review changes" onSelect={() => go('/changes')}><Icon name="GitPullRequestArrow" /> Review changes</Command.Item>
            <Command.Item value="settings preferences" onSelect={() => go('/settings')}><Icon name="Settings" /> Settings <span className="kbd">⌘,</span></Command.Item>
            <Command.Item value="get help 988" onSelect={() => go('/help')}><Icon name="LifeBuoy" /> Get help</Command.Item>
          </Command.Group>
          {search.trim().length >= 2 && !!notes.data?.length && (
            <Command.Group heading="Notes">
              {notes.data.map((n) => (
                <Command.Item key={n.id} value={`note ${n.title} ${n.area}`} onSelect={() => go(`/brain/${n.id}`)}>
                  <Icon name="FileText" /> {n.title}<span className="kbd">{n.area}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {[...groups.entries()].map(([g, list]) => (
            <Command.Group key={g} heading={g}>
              {list.map((c) => (
                <Command.Item key={c.id} value={`${g} ${c.label}`} onSelect={async () => {
                  closePalette();
                  const out = await c.run({ navigate });
                  if (typeof out === 'string') navigate(out);
                }}>
                  {c.label}{c.shortcut && <span className="kbd">{c.shortcut}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
