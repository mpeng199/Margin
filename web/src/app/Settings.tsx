import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Page } from './Page';
import { Section, Group, Item, Toggle, Input, Select, TextArea, Button, Tag } from '../ui';
import { useModules, type ModuleInfo } from '../lib/hooks';
import { useApi, queryClient } from '../lib/query';
import { api } from '../lib/api';
import { toast } from '../ui/toast';
import { webModule } from '../lib/webModule';

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function SettingsPage({ module }: { module?: string }) {
  const modules = useModules();
  const list = (modules.data ?? []).slice().sort((a, b) => Number(b.core) - Number(a.core) || a.name.localeCompare(b.name));
  const current = list.find((m) => m.id === (module ?? 'general')) ?? null;
  return (
    <Page title="Settings" width="wide">
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          <Link href="/settings" className="side-item" aria-current={!module ? 'page' : undefined}>Modules</Link>
          {list.filter((m) => m.enabled && (m.hasSettings || webModule(m.id)?.settingsPanel)).map((m) => (
            <Link key={m.id} href={`/settings/${m.id}`} className="side-item" aria-current={module === m.id ? 'page' : undefined}>{m.name}</Link>
          ))}
        </nav>
        <div>{!module ? <ModulesList list={list} /> : current ? <ModuleSettings m={current} /> : <p className="muted">Unknown module.</p>}</div>
      </div>
    </Page>
  );
}

function ModulesList({ list }: { list: ModuleInfo[] }) {
  const toggle = async (m: ModuleInfo, on: boolean) => {
    await api.post(`/api/modules/${m.id}/enabled`, { enabled: on });
    void queryClient.invalidateQueries();
    toast(`${m.name} ${on ? 'on' : 'off'}`);
  };
  return (
    <Section title="Modules" why="Every feature is a module. Turning one off hides it everywhere and keeps its data.">
      <Group>
        {list.map((m) => (
          <Item key={m.id}>
            <div className="title">
              <div className="row">{m.name}{m.core && <Tag>Core</Tag>}</div>
              <div className="sub">{m.description}</div>
            </div>
            <Toggle checked={m.enabled} disabled={m.core} label={`${m.name} enabled`} onChange={(v) => void toggle(m, v)} />
          </Item>
        ))}
      </Group>
    </Section>
  );
}

function ModuleSettings({ m }: { m: ModuleInfo }) {
  const Custom = webModule(m.id)?.settingsPanel;
  return (
    <>
      {Custom && <Custom />}
      {m.hasSettings && <AutoForm m={m} />}
    </>
  );
}

/** Form generated from the module's JSON Schema (zod → JSON Schema on the server). */
function AutoForm({ m }: { m: ModuleInfo }) {
  const values = useApi<Record<string, any>>(`/api/settings/${m.id}`);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (values.data) setDraft(values.data); }, [values.data]);
  if (!draft) return null;
  const hidden = new Set(webModule(m.id)?.settingsHide ?? []);
  const props: Record<string, any> = Object.fromEntries(Object.entries(m.settingsSchema?.properties ?? {}).filter(([k]) => !hidden.has(k)));
  const dirty = JSON.stringify(draft) !== JSON.stringify(values.data);
  const save = async () => {
    try {
      await api.patch(`/api/settings/${m.id}`, draft);
      toast('Saved');
      void queryClient.invalidateQueries();
    } catch (e: any) {
      toast(e.body?.issues?.[0] ? `${e.body.issues[0].path.join('.')}: ${e.body.issues[0].message}` : e.message);
    }
  };
  return (
    <Section title={m.name} why={m.description} end={<><Button disabled={!dirty} onClick={() => setDraft(values.data!)}>Revert</Button><Button variant="primary" disabled={!dirty} onClick={save}>Save</Button></>}>
      <Group>
        {Object.entries(props).map(([key, schema]) => (
          <Item key={key} style={{ alignItems: isBlock(schema) ? 'flex-start' : 'center' }}>
            <div className="title" style={{ maxWidth: isBlock(schema) ? 220 : undefined }}>
              <div>{humanize(key)}</div>
              {schema.description && <div className="sub">{schema.description}</div>}
            </div>
            <div style={{ flex: isBlock(schema) ? 1 : undefined }}>
              <FieldFor schema={schema} value={draft[key]} onChange={(v) => setDraft({ ...draft, [key]: v })} label={humanize(key)} />
            </div>
          </Item>
        ))}
      </Group>
    </Section>
  );
}

const isBlock = (s: any) => (s.type === 'array' && s.items?.type === 'object') || s.type === 'object' || (s.type === 'array' && s.items?.type === 'string' && !s.items?.enum);

function FieldFor({ schema, value, onChange, label }: { schema: any; value: any; onChange: (v: any) => void; label: string }) {
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type ?? (schema.anyOf ? 'anyOf' : 'string')];
  if (schema.enum) {
    return <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label}>{schema.enum.map((o: string) => <option key={o} value={o}>{humanize(String(o))}</option>)}</Select>;
  }
  if (types.includes('boolean')) return <Toggle checked={!!value} onChange={onChange} label={label} />;
  if (types.includes('integer') || types.includes('number')) {
    if (/day|weekday/i.test(label) && schema.minimum === 1 && schema.maximum === 7) {
      return <Select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label}>{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select>;
    }
    return <Input type="number" style={{ width: 90 }} value={value ?? ''} min={schema.minimum} max={schema.maximum} step={types.includes('integer') ? 1 : 0.1} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} aria-label={label} />;
  }
  if (types.includes('string')) {
    if (schema.pattern === '^\\d{2}:\\d{2}$') return <Input type="time" value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label} />;
    if (schema.format === 'date' || schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$') return <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label} />;
    return <Input value={value ?? ''} style={{ width: 260 }} onChange={(e) => onChange(e.target.value)} aria-label={label} />;
  }
  if (types.includes('array') && (schema.items?.type === 'integer' || schema.items?.type === 'number') && schema.items?.maximum === 7) {
    const set = new Set<number>(value ?? []);
    return (
      <div className="days-picker" role="group" aria-label={label}>
        {DAYS.map((d, i) => (
          <button key={i} type="button" aria-pressed={set.has(i + 1)} aria-label={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]}
            onClick={() => { const n = new Set(set); n.has(i + 1) ? n.delete(i + 1) : n.add(i + 1); onChange([...n].sort()); }}>{d}</button>
        ))}
      </div>
    );
  }
  if (types.includes('array') && schema.minItems === 7 && schema.maxItems === 7 && (schema.items?.anyOf ?? []).some((x: any) => x.type === 'string' && String(x.pattern ?? '').includes(':'))) {
    const v: (string | null)[] = value ?? [null, null, null, null, null, null, null];
    return (
      <div className="weekday-times" role="group" aria-label={label}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => (
          <label key={d} className="row small">
            <span style={{ width: 30 }} className="muted">{d}</span>
            <Input type="time" value={v[i] ?? ''} aria-label={`${d} wake time`} onChange={(e) => onChange(v.map((x, j) => (j === i ? e.target.value || null : x)))} />
            {v[i] && <button type="button" className="btn plain small" onClick={() => onChange(v.map((x, j) => (j === i ? null : x)))}>Clear</button>}
          </label>
        ))}
        <span className="tiny faint">Blank means your usual wake time.</span>
      </div>
    );
  }
  if (types.includes('array') && schema.items?.type === 'string' && !schema.items?.enum) {
    return <TextArea rows={3} style={{ width: '100%' }} value={(value ?? []).join('\n')} onChange={(e) => onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} aria-label={label} placeholder="One per line" />;
  }
  return <JsonField value={value} onChange={onChange} label={label} />;
}

function JsonField({ value, onChange, label }: { value: any; onChange: (v: any) => void; label: string }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState(false);
  return (
    <TextArea rows={Math.min(14, text.split('\n').length + 1)} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11, borderColor: err ? 'var(--red)' : undefined }}
      value={text} aria-label={label}
      onChange={(e) => { setText(e.target.value); try { onChange(JSON.parse(e.target.value)); setErr(false); } catch { setErr(true); } }} />
  );
}

export const humanize = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()).replace(/ min$/i, ' (min)');
