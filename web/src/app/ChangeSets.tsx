import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Page } from './Page';
import { Section, Group, Item, Button, Empty, Tag, Icon, Input } from '../ui';
import { useApi, queryClient } from '../lib/query';
import { api } from '../lib/api';
import { toast } from '../ui/toast';
import { dt } from '../lib/format';
import type { ChangeSet, Change } from '@core/changesets';

const SOURCE: Record<string, string> = {
  claude: 'Claude', review: 'Weekly review', bulk: 'Bulk edit', onboarding: 'Onboarding', shutdown: 'Shutdown', user: 'You', mcp: 'Claude (MCP)',
};

export function ChangeSetsPage() {
  const pending = useApi<ChangeSet[]>('/api/changesets?status=pending');
  const all = useApi<ChangeSet[]>('/api/changesets');
  const history = (all.data ?? []).filter((s) => s.status !== 'pending').slice(0, 20);
  return (
    <Page title="Review changes" width="narrow">
      <p className="muted" style={{ marginTop: 4 }}>Bulk edits and anything Claude suggests wait here. Nothing reaches Todoist or Google Calendar until you apply it.</p>
      <Section title="Waiting for you">
        <Group>
          {pending.data?.length ? pending.data.map((s) => <SetRow key={s.id} s={s} />) : <Empty>Nothing to review.</Empty>}
        </Group>
      </Section>
      {history.length > 0 && (
        <Section title="Recent">
          <Group>{history.map((s) => <SetRow key={s.id} s={s} />)}</Group>
        </Section>
      )}
    </Page>
  );
}

function SetRow({ s }: { s: ChangeSet }) {
  const [, navigate] = useLocation();
  const applied = s.changes.filter((c) => c.status === 'applied').length;
  return (
    <Item onClick={() => navigate(`/changes/${s.id}`)}>
      <Icon name={s.source === 'claude' || s.source === 'mcp' ? 'Sparkles' : 'ListChecks'} />
      <div className="title">
        <div className="ellipsis">{s.title}</div>
        <div className="sub">{SOURCE[s.source] ?? s.source} · {dt(s.createdAt).toRelative()} · {s.changes.length} change{s.changes.length === 1 ? '' : 's'}</div>
      </div>
      {s.status === 'pending' ? <Tag tone="accent">Review</Tag> : <Tag tone={s.status === 'applied' ? 'green' : s.status === 'discarded' ? undefined : 'amber'}>{s.status === 'partial' ? `${applied} of ${s.changes.length} applied` : s.status}</Tag>}
      <Icon name="ChevronRight" size={14} className="faint" />
    </Item>
  );
}

export function ChangeSetPage({ id }: { id: string }) {
  const q = useApi<ChangeSet>(`/api/changesets/${id}`);
  const kinds = useApi<{ kind: string; label: string; editable: string[] }[]>('/api/changesets/kinds');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();
  const s = q.data;
  useEffect(() => { if (s) setSelected(new Set(s.changes.filter((c) => c.status === 'pending').map((c) => c.id))); }, [s?.id, s?.status]);
  if (!s) return <Page title="Review changes" width="narrow"><div /></Page>;
  const pending = s.status === 'pending';
  const toggle = (cid: string) => setSelected((x) => { const n = new Set(x); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  const apply = async (ids?: string[]) => {
    setBusy(true);
    try {
      const out = await api.post<ChangeSet>(`/api/changesets/${id}/apply`, { changeIds: ids });
      const ok = out.changes.filter((c) => c.status === 'applied').length;
      const failed = out.changes.filter((c) => c.status === 'failed').length;
      toast(failed ? `Applied ${ok}. ${failed} failed — see below.` : `Applied ${ok} change${ok === 1 ? '' : 's'}.`);
      void queryClient.invalidateQueries();
    } finally { setBusy(false); }
  };
  const discard = async () => {
    await api.post(`/api/changesets/${id}/discard`);
    toast('Discarded. Nothing was changed.');
    void queryClient.invalidateQueries();
    navigate('/changes');
  };
  return (
    <Page title={s.title} width="narrow" actions={<Link href="/changes" className="btn plain">All changes</Link>}>
      {s.summary && <div className="group pad md selectable" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{s.summary}</div>}
      <Section title={`${s.changes.length} change${s.changes.length === 1 ? '' : 's'}`} end={pending && (
        <button className="btn plain" onClick={() => setSelected(selected.size === s.changes.length ? new Set() : new Set(s.changes.map((c) => c.id)))}>
          {selected.size === s.changes.length ? 'Select none' : 'Select all'}
        </button>
      )}>
        <Group>
          {s.changes.map((c) => (
            <ChangeRow key={c.id} c={c} pending={pending} checked={selected.has(c.id)} onToggle={() => toggle(c.id)}
              editable={kinds.data?.find((k) => k.kind === c.kind)?.editable ?? []} setId={id} label={kinds.data?.find((k) => k.kind === c.kind)?.label} />
          ))}
        </Group>
      </Section>
      {pending && (
        <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <Button variant="danger" onClick={discard} disabled={busy}>Discard All</Button>
          <Button onClick={() => apply([...selected])} disabled={busy || selected.size === 0 || selected.size === s.changes.length}>Apply Selected ({selected.size})</Button>
          <Button variant="primary" onClick={() => apply()} disabled={busy}>Apply All</Button>
        </div>
      )}
    </Page>
  );
}

function ChangeRow({ c, pending, checked, onToggle, editable, setId, label }: { c: Change; pending: boolean; checked: boolean; onToggle: () => void; editable: string[]; setId: string; label?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const keys = Object.keys(c.payload).filter((k) => !k.startsWith('_') && !/(^id$|Id$|_id$)/.test(k));
  const save = async () => {
    await api.patch(`/api/changesets/${setId}/changes/${c.id}`, draft);
    setEditing(false);
    void queryClient.invalidateQueries();
  };
  return (
    <Item className="change-row" style={{ alignItems: 'flex-start' }}>
      {pending ? <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Include: ${c.title}`} style={{ marginTop: 3 }} /> : <StatusIcon status={c.status} />}
      <div className="title">
        <div>{c.title}</div>
        <div className="sub">{label ?? c.kind}</div>
        <dl className="diff selectable">
          {keys.map((k) => {
            const before = c.before?.[k];
            const after = c.payload[k];
            if (editing && editable.includes(k)) {
              return [<dt key={k + 'l'}>{humanize(k)}</dt>, <dd key={k}><Input defaultValue={fmt(after)} onChange={(e) => setDraft((d) => ({ ...d, [k]: parse(e.target.value, after) }))} /></dd>];
            }
            if (before !== undefined && fmt(before) === fmt(after)) return null;
            return [<dt key={k + 'l'}>{humanize(k)}</dt>, <dd key={k}>{before !== undefined && before !== null && <del>{fmt(before)}</del>}<ins>{fmt(after)}</ins></dd>];
          })}
        </dl>
        {c.error && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{c.error}</div>}
      </div>
      {pending && editable.length > 0 && (editing
        ? <><Button onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>
        : <Button variant="plain" onClick={() => setEditing(true)}>Edit</Button>)}
    </Item>
  );
}

function StatusIcon({ status }: { status: string }) {
  const map: Record<string, [string, string]> = { applied: ['CircleCheck', 'var(--green)'], failed: ['CircleAlert', 'var(--amber)'], skipped: ['CircleMinus', 'var(--ink-3)'], pending: ['Circle', 'var(--ink-3)'] };
  const [icon, color] = map[status] ?? map.pending;
  return <span style={{ color, marginTop: 1 }} title={status}><Icon name={icon} /></span>;
}
const humanize = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
function fmt(v: any): string {
  if (v == null) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dt(v).toFormat('EEE MMM d, h:mm a');
  if (Array.isArray(v)) return v.map(fmt).join(', ');
  if (typeof v === 'object') return v.string ?? v.date ?? v.datetime ?? JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
function parse(text: string, original: any) {
  if (typeof original === 'number') return Number(text);
  if (typeof original === 'boolean') return text.toLowerCase().startsWith('y');
  return text;
}
