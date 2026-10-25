import './checkin.css';
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Button, IconButton, Input, Select, Segmented, Field, Why } from '@web/ui';
import { addDays } from '../../../src/core/time';
import { weekendDrift, TARGET_MIN, TARGET_MAX, SLEEP_RULES } from '../sleep';
import type { CheckinEntry, Metric, MetricType } from '../manifest';

interface CheckinState {
  date: string;
  submitted: boolean;
  entry: CheckinEntry | null;
  summary: string | null;
  napNote: string | null;
  prefill: { bedtime: string; wakeTime: string };
  metrics: Metric[];
}

const source = (id: string) => SLEEP_RULES.find((r) => r.id === id)?.source;
/** Stored instants are zoned ISO strings, so the wall-clock time is already in the text. */
const hm = (iso: string) => iso.slice(11, 16);

/** Only the notes that apply to this check-in: the 8 to 10 hour target, weekend wake drift, and the nap guide. */
function Notes({ s }: { s: CheckinState }) {
  const e = s.entry!;
  const entries = useApi<CheckinEntry[]>(`/api/checkin/entries?from=${addDays(s.date, -13)}&to=${s.date}`);
  const day = useApi<{ schoolDays?: number[] }>('/api/settings/day');
  const drift = weekendDrift(entries.data ?? [], day.data?.schoolDays ?? [1, 2, 3, 4, 5], 90);
  const notes: ReactNode[] = [];
  if (e.sleepMin < TARGET_MIN) notes.push(<Why key="target" source={source('target')}>Under the 8 to 10 hours recommended for teens.</Why>);
  else if (e.sleepMin > TARGET_MAX) notes.push(<Why key="target" source={source('target')}>Longer than the 8 to 10 hours recommended for teens.</Why>);
  if (drift.met) notes.push(<Why key="drift" source={source('weekend')}>{drift.detail}</Why>);
  if (s.napNote) notes.push(<Why key="nap" source={source('naps')}>{s.napNote}</Why>);
  return notes.length ? <div className="checkin-notes">{notes}</div> : null;
}

function Done({ s, onEdit }: { s: CheckinState; onEdit: () => void }) {
  return (
    <Section>
      <Group>
        <div className="checkin-done">
          <span className="grow num">{s.summary}</span>
          <Button variant="plain" onClick={onEdit}>Edit</Button>
        </div>
        <Notes s={s} />
      </Group>
    </Section>
  );
}

const ENERGY = Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: String(i) }));

function Form({ s, onDone }: { s: CheckinState; onDone: () => void }) {
  const e = s.entry;
  const [bed, setBed] = useState(e ? hm(e.bedtime) : s.prefill.bedtime);
  const [wake, setWake] = useState(e ? hm(e.wakeTime) : s.prefill.wakeTime);
  const [energy, setEnergy] = useState<number | null>(e?.energy ?? null);
  const [nap, setNap] = useState(e?.napMin ? String(e.napMin) : '');
  const [napStart, setNapStart] = useState(e?.napStart ?? '');
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(e?.extras ?? {}).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)])));
  const [label, setLabel] = useState('');
  const [type, setType] = useState<MetricType>('0-10');
  const save = useAction('post', '/api/checkin/submit', onDone);
  const addMetric = useAction('post', '/api/checkin/metrics', () => setLabel(''));
  const hideMetric = useAction<string>('del', (key) => `/api/checkin/metrics/${key}`);

  const submit = (en: number | null = energy) => {
    if (en == null || save.isPending) return;
    const extras: Record<string, number | boolean> = {};
    for (const m of s.metrics) {
      const v = vals[m.key];
      if (v === undefined || v === '') continue;
      extras[m.key] = m.type === 'yes/no' ? v === 'yes' : Number(v);
    }
    save.mutate({ bedtime: bed, wakeTime: wake, energy: en, napMin: nap ? Number(nap) : null, napStart: nap && napStart ? napStart : null, extras } as any);
  };
  // Return on an energy button picks it and saves, so the whole check-in works from the keyboard.
  const onKeyDown = (ev: KeyboardEvent<HTMLFormElement>) => {
    const t = ev.target as HTMLElement;
    if (ev.key !== 'Enter' || !t.closest('.checkin-energy') || !/^\d+$/.test(t.textContent ?? '')) return;
    ev.preventDefault();
    const n = Number(t.textContent);
    setEnergy(n);
    submit(n);
  };

  return (
    <Section title="Morning check-in">
      <form onSubmit={(ev: FormEvent) => { ev.preventDefault(); submit(); }} onKeyDown={onKeyDown}>
        <Group pad>
          <div className="checkin-times">
            <Field label="Bedtime"><Input type="time" required value={bed} onChange={(ev) => setBed(ev.target.value)} /></Field>
            <Field label="Woke up"><Input type="time" required value={wake} onChange={(ev) => setWake(ev.target.value)} /></Field>
          </div>
          <div className="checkin-energy">
            <div className="label" id="checkin-energy-label">Energy</div>
            <Segmented label="Energy, 0 to 10" value={energy == null ? '' : String(energy)} options={ENERGY} onChange={(v) => setEnergy(Number(v))} />
            <div className="ends"><span>0 empty</span><span>10 full</span></div>
          </div>
          <details className="checkin-more">
            <summary>More</summary>
            <div className="checkin-more-body">
              <div className="checkin-times">
                <Field label="Nap (minutes)"><Input type="number" min={0} max={240} inputMode="numeric" value={nap} onChange={(ev) => setNap(ev.target.value)} /></Field>
                <Field label="Nap started"><Input type="time" value={napStart} onChange={(ev) => setNapStart(ev.target.value)} /></Field>
              </div>
              {s.metrics.map((m) => (
                <div className="checkin-metric" key={m.key}>
                  <Field label={m.type === '0-10' ? `${m.label} (0 to 10)` : m.label}>
                    {m.type === 'yes/no'
                      ? <Segmented label={m.label} value={(vals[m.key] ?? '') as 'yes' | 'no'} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={(v) => setVals({ ...vals, [m.key]: v })} />
                      : <Input type="number" inputMode="decimal" min={m.type === '0-10' ? 0 : undefined} max={m.type === '0-10' ? 10 : undefined} step={m.type === '0-10' ? 1 : 'any'} value={vals[m.key] ?? ''} onChange={(ev) => setVals({ ...vals, [m.key]: ev.target.value })} />}
                  </Field>
                  <IconButton icon="X" label={`Hide ${m.label}`} onClick={() => hideMetric.mutate(m.key)} />
                </div>
              ))}
              <div className="checkin-add">
                <Input aria-label="New metric name" placeholder="Track something else" maxLength={40} value={label}
                  onChange={(ev) => setLabel(ev.target.value)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); if (label.trim()) addMetric.mutate({ label, type } as any); } }} />
                <Select aria-label="Metric type" value={type} onChange={(ev) => setType(ev.target.value as MetricType)}>
                  <option value="0-10">0 to 10</option>
                  <option value="yes/no">Yes / no</option>
                  <option value="number">Number</option>
                </Select>
                <Button disabled={!label.trim() || addMetric.isPending} onClick={() => addMetric.mutate({ label, type } as any)}>Add</Button>
              </div>
            </div>
          </details>
          <div className="checkin-actions">
            {energy == null && <span className="faint tiny" style={{ alignSelf: 'center', marginRight: 'var(--s3)' }}>Pick an energy level to save.</span>}
            <Button type="submit" variant="primary" disabled={energy == null || save.isPending}>Save Check-in</Button>
          </div>
        </Group>
      </form>
    </Section>
  );
}

function CheckinWidget() {
  const q = useApi<CheckinState>('/api/checkin/today');
  const [editing, setEditing] = useState(false);
  const s = q.data;
  if (!s) return null;
  return s.submitted && !editing ? <Done s={s} onEdit={() => setEditing(true)} /> : <Form s={s} onDone={() => setEditing(false)} />;
}

export default defineWebModule({
  id: 'checkin',
  widgets: { checkin: CheckinWidget },
});
