import './rules.css';
import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, useAction } from '@web/lib/query';
import { useModules } from '@web/lib/hooks';
import { dt } from '@web/lib/format';
import { Section, Group, Item, Button, IconButton, Sheet, Banner, Tag, Toggle, Field, Input, Select, TextArea, Empty, Why } from '@web/ui';

// ---- shapes returned by the daemon (see src/core/rules.ts) ----
interface JProp { type?: string; enum?: unknown[]; default?: unknown; description?: string; minimum?: number; maximum?: number; maxLength?: number }
interface JSchema { properties?: Record<string, JProp> }
interface CatItem { id: string; label: string; description?: string; module: string; available: boolean; params: JSchema | null }
interface Catalog { conditions: CatItem[]; actions: CatItem[] }
interface RuleBody {
  id?: string; name: string; enabled: boolean;
  when: { condition: string; params: Record<string, unknown> }[];
  then: { action: string; params: Record<string, unknown> }[];
  why?: string; source?: string;
}
type Rule = RuleBody & { id: string; builtin: boolean; available: boolean };
interface Firing { id: string; ruleId: string; ruleName: string; firedAt: string; detail: string; resolvedAt?: string | null }
interface Alert { id: string; detail: string; why: string | null; source: string | null; tone: 'amber' | 'green'; text: string | null }

// ---- Today: active rule alerts ----
// Reads /api/rules/alerts (active firings minus Get help, with each rule's banner look). Hiding is per day and, unlike
// POST /api/rules/firings/:id/dismiss, never lifts a lock such as "no new projects".
function AlertsWidget() {
  const { data } = useApi<Alert[]>('/api/rules/alerts');
  const hide = useAction<string>('post', (id) => `/api/rules/alerts/${id}/hide`);
  if (!data?.length) return null;
  return (
    <>
      {data.map((a) => {
        const text = a.text ?? a.detail;
        return (
          <Banner key={a.id} tone={a.tone} icon={a.tone === 'green' ? 'CircleCheck' : 'TriangleAlert'} onDismiss={() => hide.mutate(a.id)}
            why={a.why ? <Why source={a.source ?? undefined}>{a.why}</Why> : undefined}>
            <div>{text}</div>
            {a.text && !a.text.includes(a.detail) && <div className="small muted">{a.detail}</div>}
          </Banner>
        );
      })}
    </>
  );
}

// ---- editor ----
interface Step { id: string; params: Record<string, unknown> }
interface Draft { id?: string; builtin?: boolean; name: string; enabled: boolean; when: Step[]; then: Step[]; why: string; source: string }

const blank = (): Draft => ({ name: '', enabled: true, when: [], then: [], why: '', source: '' });
const toDraft = (r: Rule): Draft => ({
  id: r.id, builtin: r.builtin, name: r.name, enabled: r.enabled,
  when: r.when.map((w) => ({ id: w.condition, params: w.params ?? {} })),
  then: r.then.map((t) => ({ id: t.action, params: t.params ?? {} })),
  why: r.why ?? '', source: r.source ?? '',
});
/** The server stores whatever it is sent, so send the rule's own fields only (no builtin/available flags). */
const toBody = (r: Rule): RuleBody => ({ id: r.id, name: r.name, enabled: r.enabled, when: r.when, then: r.then, why: r.why, source: r.source });
const fromDraft = (d: Draft): RuleBody => ({
  ...(d.id ? { id: d.id } : {}), name: d.name.trim(), enabled: d.enabled,
  when: d.when.map((s) => ({ condition: s.id, params: s.params })),
  then: d.then.map((s) => ({ action: s.id, params: s.params })),
  why: d.why.trim() || undefined, source: d.source.trim() || undefined,
});

/** Start a step from the schema's defaults (an enum with no default starts on its first option). */
const defaults = (schema: JSchema | null): Record<string, unknown> => Object.fromEntries(
  Object.entries(schema?.properties ?? {})
    .map(([k, p]) => [k, p.default ?? (p.enum ? p.enum[0] : undefined)] as const)
    .filter(([, v]) => v !== undefined));
const humanize = (k: string) => { const s = k.replace(/([A-Z])/g, ' $1').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A small form from a JSON Schema: number, string, boolean and enum fields. Anything else keeps its server default. */
function ParamFields({ schema, value, onChange }: { schema: JSchema | null; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return null;
  const set = (k: string, v: unknown) => { const next = { ...value }; if (v === undefined) delete next[k]; else next[k] = v; onChange(next); };
  return (
    <div className="rules-params">
      {props.map(([k, p]) => {
        const v = value[k] ?? p.default;
        const label = humanize(k);
        if (p.enum) {
          return <Field key={k} label={label} hint={p.description}>
            <Select value={String(v ?? p.enum[0])} onChange={(e) => set(k, e.target.value)}>{p.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}</Select>
          </Field>;
        }
        if (p.type === 'boolean') {
          return <Field key={k} label={label} hint={p.description}><div><Toggle checked={!!v} onChange={(x) => set(k, x)} label={label} /></div></Field>;
        }
        if (p.type === 'number' || p.type === 'integer') {
          return <Field key={k} label={label} hint={p.description}>
            <Input type="number" min={p.minimum} max={p.maximum} step={p.type === 'integer' ? 1 : 'any'} value={v === undefined ? '' : String(v)}
              onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))} />
          </Field>;
        }
        if (p.type === 'string') {
          const long = (p.maxLength ?? 0) > 120;
          return <div key={k} className={long ? 'wide' : undefined}><Field label={label} hint={p.description}>
            {long
              ? <TextArea rows={3} maxLength={p.maxLength} value={String(v ?? '')} onChange={(e) => set(k, e.target.value)} />
              : <Input maxLength={p.maxLength} value={String(v ?? '')} onChange={(e) => set(k, e.target.value)} />}
          </Field></div>;
        }
        return null;
      })}
    </div>
  );
}

function Steps({ title, items, steps, onChange, addLabel }: { title: string; items: CatItem[]; steps: Step[]; onChange: (s: Step[]) => void; addLabel: string }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const setAt = (i: number, step: Step) => onChange(steps.map((s, j) => (j === i ? step : s)));
  const first = items.find((o) => o.available);
  return (
    <div className="rules-block">
      <h3>{title}</h3>
      {steps.map((s, i) => {
        const it = byId.get(s.id);
        return (
          <div className="rules-step" key={i}>
            <div className="head">
              <Select aria-label={title} value={s.id} onChange={(e) => { const n = byId.get(e.target.value)!; setAt(i, { id: n.id, params: defaults(n.params) }); }}>
                {!it && <option value={s.id}>{s.id} (unknown)</option>}
                {items.map((o) => <option key={o.id} value={o.id} disabled={!o.available && o.id !== s.id}>{o.label}{o.available ? '' : ' (unavailable)'}</option>)}
              </Select>
              <IconButton icon="X" label="Remove" onClick={() => onChange(steps.filter((_, j) => j !== i))} />
            </div>
            {it?.description && <div className="small muted">{it.description}</div>}
            <ParamFields schema={it?.params ?? null} value={s.params} onChange={(p) => setAt(i, { ...s, params: p })} />
          </div>
        );
      })}
      <div style={{ marginTop: steps.length ? 'var(--s2)' : 0 }}>
        <Button icon="Plus" disabled={!first} onClick={() => first && onChange([...steps, { id: first.id, params: defaults(first.params) }])}>{addLabel}</Button>
      </div>
    </div>
  );
}

function RuleSheet({ initial, catalog, onClose }: { initial: Draft; catalog: Catalog; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const create = useAction('post', '/api/rules', onClose);
  const update = useAction<RuleBody>('put', (b) => `/api/rules/${b.id}`, onClose);
  const remove = useAction<string>('del', (id) => `/api/rules/${id}`, onClose);
  const ready = d.name.trim() && d.when.length > 0 && d.then.length > 0;
  const busy = create.isPending || update.isPending;
  const save = () => (d.id ? update.mutate(fromDraft(d)) : create.mutate(fromDraft(d) as any));
  return (
    <Sheet open onClose={onClose} wide title={d.id ? 'Edit rule' : 'New rule'}
      subtitle="When every condition is true, the actions run once. It can fire again after the conditions clear."
      footer={<>
        {d.id && !d.builtin && <Button variant="danger" onClick={() => { if (window.confirm('Delete this rule?')) remove.mutate(d.id!); }}>Delete Rule</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ready || busy} onClick={save}>Save Rule</Button>
      </>}>
      <Field label="Name"><Input style={{ width: '100%' }} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
      <Steps title="When all of these are true" items={catalog.conditions} steps={d.when} onChange={(when) => setD({ ...d, when })} addLabel="Add Condition" />
      <Steps title="Then" items={catalog.actions} steps={d.then} onChange={(then) => setD({ ...d, then })} addLabel="Add Action" />
      <div className="rules-block">
        <h3>Why this rule exists</h3>
        <div className="rules-params">
          <div className="wide"><Field label="Reason"><Input value={d.why} maxLength={240} onChange={(e) => setD({ ...d, why: e.target.value })} /></Field></div>
          <Field label="Source"><Input value={d.source} maxLength={80} placeholder="Author Year" onChange={(e) => setD({ ...d, source: e.target.value })} /></Field>
        </div>
      </div>
    </Sheet>
  );
}

export function RulesEditor() {
  const rules = useApi<Rule[]>('/api/rules');
  const catalog = useApi<Catalog>('/api/rules/catalog');
  const history = useApi<Firing[]>('/api/rules/history');
  const modules = useModules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const toggle = useAction<RuleBody>('put', (b) => `/api/rules/${b.id}`);
  const cat = catalog.data;
  const list = rules.data ?? [];
  const names = new Map(list.map((r) => [r.id, r.name]));
  const modName = (id: string) => modules.data?.find((m) => m.id === id)?.name ?? id;
  const label = (kind: 'conditions' | 'actions', id: string) => cat?.[kind].find((c) => c.id === id)?.label ?? id;
  const missing = (r: Rule) => [...new Set([
    ...r.when.map((w) => cat?.conditions.find((c) => c.id === w.condition)),
    ...r.then.map((t) => cat?.actions.find((a) => a.id === t.action)),
  ].filter((c) => c && !c.available).map((c) => modName(c!.module)))];

  return (
    <>
      <Section title="Rules" why="Decided in advance, so you don’t have to decide when you’re tired (Gollwitzer & Sheeran 2006)."
        end={<Button icon="Plus" disabled={!cat} onClick={() => setDraft(blank())}>New Rule</Button>}>
        <Group>
          {list.map((r) => {
            const needs = missing(r);
            return (
              <Item key={r.id} className={r.enabled && r.available ? '' : 'rules-off'}>
                <div className="title">
                  <div className="rules-name"><span>{r.name}</span>{!r.available && <Tag>Unavailable</Tag>}</div>
                  <div className="sub">If {r.when.map((w) => lc(label('conditions', w.condition))).join(' and ')}</div>
                  {needs.length > 0 && <div className="sub">Needs {needs.join(' and ')} turned on.</div>}
                  {r.why && <div className="sub"><Why source={r.source}>{r.why}</Why></div>}
                </div>
                <Button variant="plain" disabled={!cat} onClick={() => setDraft(toDraft(r))}>Edit</Button>
                <Toggle checked={r.enabled} label={`${r.name}: on`} onChange={() => toggle.mutate({ ...toBody(r), enabled: !r.enabled })} />
              </Item>
            );
          })}
          {!list.length && <Empty>No rules yet.</Empty>}
        </Group>
      </Section>

      <Section title="History" why="Each time a rule fired.">
        <Group>
          {(history.data ?? []).slice(0, 15).map((h) => (
            <Item key={h.id}>
              <div className="title">
                <div>{names.get(h.ruleId) ?? h.ruleName}</div>
                <div className="sub">{h.detail}</div>
              </div>
              <span className="meta num">{dt(h.firedAt).toFormat('EEE, MMM d')}</span>
              <Tag tone={h.resolvedAt ? undefined : 'accent'}>{h.resolvedAt ? 'Cleared' : 'Active'}</Tag>
            </Item>
          ))}
          {!history.data?.length && <Empty>Nothing has fired yet.</Empty>}
        </Group>
      </Section>

      {draft && cat && <RuleSheet initial={draft} catalog={cat} onClose={() => setDraft(null)} />}
    </>
  );
}

function RulesPage() {
  return <Page title="Rules" width="narrow"><RulesEditor /></Page>;
}

export default defineWebModule({
  id: 'rules',
  routes: [{ path: '/rules', component: RulesPage, work: false }],
  widgets: { alerts: AlertsWidget },
  settingsPanel: RulesEditor,
  commands: [{ id: 'rules.open', label: 'Open rules', group: 'Rules', run: () => '/rules' }],
});
