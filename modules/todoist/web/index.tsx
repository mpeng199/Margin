import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Item, Button, Input, Tag, Banner } from '@web/ui';
import { dt } from '@web/lib/format';

interface Status {
  mode: 'mock' | 'live'; connected: boolean; lastSyncAt: string | null; lastError: string | null;
  plan: { maxProjects: number; durations: boolean; activeProjects: number; projectsLeft: number } | null;
  user: { name: string | null } | null;
}

/** Connect Todoist with a personal API token (stored in the macOS Keychain). */
export function TodoistAccount({ compact }: { compact?: boolean }) {
  const status = useApi<Status>('/api/todoist/status');
  const [token, setToken] = useState('');
  const connect = useAction('post', '/api/todoist/connect', () => setToken(''));
  const mock = useAction('post', '/api/todoist/use-mock');
  const sync = useAction('post', '/api/todoist/sync');
  const disconnect = useAction('post', '/api/todoist/disconnect');
  const s = status.data;
  if (!s) return null;
  const live = s.mode === 'live';
  return (
    <Section title="Todoist" why="Source of truth for tasks. Margin never deletes your tasks or projects."
      end={live ? <Tag tone="green">Connected</Tag> : <Tag>Mock data</Tag>}>
      <Group>
        {live ? (
          <Item>
            <div className="title">
              <div>{s.user?.name ? `Signed in as ${s.user.name}` : 'Connected with your API token'}</div>
              <div className="sub">{s.lastSyncAt ? `Synced ${dt(s.lastSyncAt).toRelative()}` : 'Not synced yet'}{s.plan ? ` · ${s.plan.activeProjects} of ${s.plan.maxProjects} projects used` : ''}</div>
            </div>
            <Button onClick={() => sync.mutate({} as any)} disabled={sync.isPending}>Sync Now</Button>
            <Button variant="danger" onClick={() => disconnect.mutate({} as any)}>Disconnect</Button>
          </Item>
        ) : (
          <Item style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
            <div className="small muted">Paste your API token from Todoist → Settings → Integrations → Developer. It's stored in your Mac's Keychain, never in a file.</div>
            <div className="row" style={{ width: '100%' }}>
              <Input type="password" className="grow" placeholder="API token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Todoist API token" autoComplete="off" />
              <Button variant="primary" disabled={token.length < 10 || connect.isPending} onClick={() => connect.mutate({ token } as any)}>{connect.isPending ? 'Connecting…' : 'Connect'}</Button>
            </div>
            {!compact && <div className="tiny faint">Using mock data until you connect: a local stand-in that behaves like Todoist.</div>}
          </Item>
        )}
        {s.plan && !s.plan.durations && (
          <Item><div className="title small muted">Your plan doesn't include task durations, so estimates are kept in Margin. {s.plan.projectsLeft === 0 ? 'Project limit reached: new tabs link to a label instead.' : ''}</div></Item>
        )}
      </Group>
      {s.lastError && <div style={{ marginTop: 8 }}><Banner tone="amber" icon="TriangleAlert">{s.lastError}</Banner></div>}
      {live && !compact && <div style={{ marginTop: 8 }}><Button variant="plain" onClick={() => mock.mutate({} as any)}>Switch to Mock Data</Button></div>}
    </Section>
  );
}

export default defineWebModule({
  id: 'todoist',
  settingsPanel: () => <TodoistAccount />,
  commands: [{ id: 'todoist.sync', label: 'Sync Todoist now', group: 'Accounts', run: async () => { await fetch('/api/todoist/sync', { method: 'POST', headers: { 'x-margin': '1' } }); } }],
});
