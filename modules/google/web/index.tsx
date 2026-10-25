import { useEffect, useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';
import { Section, Group, Item, Button, Input, Tag, Banner, Toggle, TextArea, toast } from '@web/ui';
import { dt } from '@web/lib/format';

interface Status {
  mode: 'mock' | 'live'; clientConfigured: boolean; connected: boolean; needsReconnect: boolean; connecting: boolean;
  scopes: string[]; canWriteOwned: boolean; lastSyncAt: string | null; lastError: string | null; blocksCalendarId: string | null;
}

function openExternal(url: string) {
  const m = (window as any).margin;
  if (m?.openExternal) m.openExternal(url); else window.open(url, '_blank', 'noopener');
}

export async function connectGoogle(primaryWrites = false) {
  try {
    const r = await api.post<{ url: string | null; mock: boolean }>('/api/google/connect', { primaryWrites });
    if (r.url) { openExternal(r.url); toast('Finish signing in to Google in your browser.'); }
    else toast('Mock calendars connected.');
    void queryClient.invalidateQueries();
  } catch (e: any) { toast(e.message); }
}

/** Google OAuth client (from Google Cloud) + connect. Tokens live in the Keychain. */
export function GoogleAccount({ compact }: { compact?: boolean }) {
  const status = useApi<Status>('/api/google/status', { refetchInterval: (q) => (q.state.data?.connecting ? 1500 : false) });
  const cals = useApi<{ id: string; summary: string; color: string | null; primary: boolean; appKind: string | null; hidden: boolean }[]>('/api/google/calendars');
  const settings = useApi<{ hiddenCalendars: string[] }>('/api/settings/google');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [json, setJson] = useState('');
  const saveClient = useAction('post', '/api/google/client', () => { setClientId(''); setSecret(''); setJson(''); });
  const sync = useAction('post', '/api/google/sync');
  const useMock = useAction('post', '/api/google/use-mock');
  const disconnect = useAction('post', '/api/google/disconnect');
  const s = status.data;
  useEffect(() => {
    if (!json.trim()) return;
    try {
      const j = JSON.parse(json);
      const c = j.installed ?? j.web ?? j;
      if (c.client_id) setClientId(c.client_id);
      if (c.client_secret) setSecret(c.client_secret);
    } catch { /* still typing */ }
  }, [json]);
  if (!s) return null;
  const live = s.mode === 'live';
  const hidden = new Set(settings.data?.hiddenCalendars ?? []);
  const toggleHidden = async (id: string, show: boolean) => {
    const next = show ? [...hidden].filter((x) => x !== id) : [...hidden, id];
    await api.patch('/api/settings/google', { hiddenCalendars: next });
    void queryClient.invalidateQueries();
  };
  return (
    <Section title="Google Calendar" why="Margin reads all your calendars and writes only to calendars it creates."
      end={s.needsReconnect ? <Tag tone="amber">Reconnect needed</Tag> : live ? <Tag tone="green">Connected</Tag> : <Tag>Mock data</Tag>}>
      {s.needsReconnect && (
        <div style={{ marginBottom: 8 }}>
          <Banner tone="amber" icon="RefreshCw" action={<Button variant="primary" onClick={() => connectGoogle(s.canWriteOwned)}>Reconnect</Button>}
            why="Google expires sign-ins after 7 days while an app is in Testing. Publishing it (README step 2.8) stops this.">
            <strong>Google sign-in expired.</strong> Calendars stopped syncing.
          </Banner>
        </div>
      )}
      <Group>
        {!s.clientConfigured || (!live && !compact) ? (
          <Item style={{ alignItems: 'stretch', flexDirection: 'column', gap: 8 }}>
            <div className="small muted">Create a Desktop OAuth client in Google Cloud (README, step 2), then paste the downloaded JSON or the ID and secret. Stored in the Keychain.</div>
            <TextArea rows={2} placeholder='Paste client_secret_….json contents (optional)' value={json} onChange={(e) => setJson(e.target.value)} aria-label="OAuth client JSON" />
            <div className="row">
              <Input className="grow" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client ID" />
              <Input className="grow" type="password" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Client secret" />
              <Button disabled={clientId.length < 10 || secret.length < 6} onClick={() => saveClient.mutate({ clientId, clientSecret: secret } as any)}>Save Client</Button>
            </div>
          </Item>
        ) : null}
        <Item>
          <div className="title">
            <div>{live ? 'Connected' : s.clientConfigured ? 'Ready to connect' : 'Using mock calendars'}</div>
            <div className="sub">{s.lastSyncAt ? `Synced ${dt(s.lastSyncAt).toRelative()}` : 'Not synced yet'}{s.canWriteOwned ? ' · may write to your own calendars after you confirm each change' : ''}</div>
          </div>
          {s.connecting ? <span className="small muted">Waiting for Google…</span> : (
            <>
              {(s.clientConfigured && !live) && <Button variant="primary" onClick={() => connectGoogle(false)}>Connect Google</Button>}
              {live && <Button onClick={() => sync.mutate({} as any)} disabled={sync.isPending}>Sync Now</Button>}
              {live && <Button variant="danger" onClick={() => disconnect.mutate({} as any)}>Disconnect</Button>}
            </>
          )}
        </Item>
        {live && !compact && (
          <Item>
            <div className="title"><div>Allow writes to my own calendars</div><div className="sub">Off by default. Needs Google’s “events on calendars you own” permission and a yes for every single change.</div></div>
            <Toggle checked={s.canWriteOwned} label="Allow writes to my own calendars" onChange={(v) => v ? connectGoogle(true) : connectGoogle(false)} />
          </Item>
        )}
      </Group>
      {s.lastError && !s.needsReconnect && <div style={{ marginTop: 8 }}><Banner tone="amber" icon="TriangleAlert">{s.lastError}</Banner></div>}
      {!compact && (cals.data?.length ?? 0) > 0 && (
        <Section title="Calendars">
          <Group>
            {cals.data!.map((c) => (
              <Item key={c.id}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: c.color ?? 'var(--ink-3)', flex: 'none' }} />
                <div className="title ellipsis">{c.summary}{c.primary ? <span className="faint"> · primary</span> : ''}{c.appKind ? <span className="faint"> · Margin</span> : ''}</div>
                <Toggle checked={!hidden.has(c.id)} label={`Show ${c.summary}`} onChange={(v) => void toggleHidden(c.id, v)} />
              </Item>
            ))}
          </Group>
        </Section>
      )}
      {live && !compact && <div style={{ marginTop: 8 }}><Button variant="plain" onClick={() => useMock.mutate({} as any)}>Switch to Mock Calendars</Button></div>}
    </Section>
  );
}

/** One-click reconnect when Google returns invalid_grant (SPEC 3). */
function ReconnectBanner() {
  const status = useApi<Status>('/api/google/status');
  if (!status.data?.needsReconnect) return null;
  return (
    <Banner tone="amber" icon="RefreshCw" action={<Button variant="primary" onClick={() => connectGoogle(status.data!.canWriteOwned)}>Reconnect</Button>}>
      <strong>Google Calendar needs you to sign in again.</strong> Events aren't syncing until you do.
    </Banner>
  );
}

export default defineWebModule({
  id: 'google',
  settingsPanel: () => <GoogleAccount />,
  widgets: { reconnect: ReconnectBanner },
  commands: [{ id: 'google.sync', label: 'Sync Google Calendar now', group: 'Accounts', run: async () => { await fetch('/api/google/sync', { method: 'POST', headers: { 'x-margin': '1' } }); } }],
});
