import { defineWebModule } from '@web/lib/module';
import { useApi, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';
import { Section, Group, Item, Button, Banner, Tag, Empty, Spinner, toast } from '@web/ui';
import { dt } from '@web/lib/format';
import type { UpdateStatus } from '../manifest';
import './update.css';

const PHASE: Record<string, string> = {
  starting: 'Starting the update…', pulling: 'Downloading the new version…', installing: 'Installing new dependencies…',
  building: 'Building…', restarting: 'Restarting Margin…',
};
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'unknown');
const busy = (s?: UpdateStatus) => !!s && !!PHASE[s.phase];

export function useUpdate() {
  return useApi<UpdateStatus>('/api/update/status', { refetchInterval: (q) => (busy(q.state.data) ? 2000 : 5 * 60_000) });
}

async function applyUpdate() {
  try {
    await api.post('/api/update/apply');
    toast('Updating. Margin will restart in about a minute.');
    void queryClient.invalidateQueries();
  } catch (e: any) { toast(e.message); }
}

function Changes({ s, max = 3 }: { s: UpdateStatus; max?: number }) {
  return (
    <ul className="upd-changes">
      {s.changes.slice(0, max).map((c) => <li key={c.sha}>{c.subject}</li>)}
      {s.changes.length > max && <li className="faint">and {s.changes.length - max} more</li>}
    </ul>
  );
}

/** Today: one quiet banner when a newer Margin is on GitHub. */
function UpdateBanner() {
  const q = useUpdate();
  const s = q.data;
  if (!s) return null;
  if (busy(s)) return <Banner icon="RefreshCw"><strong>{PHASE[s.phase]}</strong> Margin will reload when it’s done.</Banner>;
  if (!s.available || s.dismissed) return null;
  return (
    <Banner icon="ArrowDownToLine"
      action={<div className="row"><Button onClick={() => api.post('/api/update/dismiss').then(() => queryClient.invalidateQueries())}>Later</Button><Button variant="primary" disabled={!s.canApply} onClick={applyUpdate}>Update and Restart</Button></div>}
      why={s.blockedReason ?? undefined}>
      <strong>A new version of Margin is ready.</strong> {s.behind === 1 ? '1 change' : `${s.behind} changes`} since yours.
      <Changes s={s} />
    </Banner>
  );
}

/** Settings → Updates. */
function UpdatesPanel() {
  const q = useUpdate();
  const s = q.data;
  const check = async () => {
    const r = await api.post<UpdateStatus>('/api/update/check');
    toast(r.error ? r.error : r.available ? `${r.behind} new change${r.behind === 1 ? '' : 's'} available.` : 'Margin is up to date.');
    void queryClient.invalidateQueries();
  };
  if (!s) return null;
  return (
    <Section title="Updates" why="New versions come from the Margin repository on GitHub. Nothing installs until you choose to."
      end={<Button onClick={check} disabled={busy(s)}>Check Now</Button>}>
      <Group>
        <Item>
          <div className="title"><div>Installed</div><div className="sub num">{short(s.installed)}{s.installedAt ? ` · ${dt(s.installedAt).toFormat('MMM d, h:mm a')}` : ''}</div></div>
          {s.available ? <Tag tone="accent">Update available</Tag> : s.checkedAt && !s.error ? <Tag tone="green">Up to date</Tag> : null}
        </Item>
        {busy(s) && <Item><Spinner /><div className="title">{PHASE[s.phase]}</div></Item>}
        {s.available && (
          <Item style={{ alignItems: 'flex-start' }}>
            <div className="title">
              <div>Latest <span className="num faint">{short(s.latest)}</span></div>
              <Changes s={s} max={10} />
              {s.blockedReason && <div className="sub" style={{ color: 'var(--amber)' }}>{s.blockedReason}</div>}
            </div>
            <Button variant="primary" disabled={!s.canApply} onClick={applyUpdate}>Update and Restart</Button>
          </Item>
        )}
        {s.error && <Item><div className="title small" style={{ color: 'var(--amber)' }}>{s.error}</div></Item>}
        <Item><div className="title sub">{s.checkedAt ? `Last checked ${dt(s.checkedAt).toRelative()}` : 'Not checked yet'}{s.remote ? ` · ${s.remote.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '')}` : ''}</div></Item>
      </Group>
      {!s.available && !s.checkedAt && <Empty>Margin checks once an hour while it’s running.</Empty>}
    </Section>
  );
}

export default defineWebModule({
  id: 'update',
  widgets: { banner: UpdateBanner },
  settingsPanel: UpdatesPanel,
  commands: [{ id: 'update.check', label: 'Check for updates', group: 'Margin', run: () => '/settings/update' }],
});
