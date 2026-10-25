import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction } from '@web/lib/query';
import { Section, Group, Item, Button, IconButton, Input, Sheet, Why, Empty } from '@web/ui';
import type { Ritual, RitualStep } from '../manifest';
import './rituals.css';

type Row = Ritual & { customised: boolean };
interface Confirm { title: string; body: string; label: string; run: () => void }

const send = (steps: RitualStep[]) => steps.map(({ id, label, why, source }) => ({ id: id || undefined, label, why, source }));

function RitualEditor({ ritual, ask }: { ritual: Row; ask: (c: Confirm) => void }) {
  const [draft, setDraft] = useState('');
  const save = useAction<{ id: string; steps: unknown[] }>('put', (b) => `/api/rituals/${b.id}`);
  const reset = useAction<{ id: string }>('post', (b) => `/api/rituals/${b.id}/reset`);
  const steps = ritual.steps;
  const put = (next: RitualStep[]) => save.mutate({ id: ritual.id, steps: send(next) });
  const rename = (i: number, label: string) => {
    const t = label.trim();
    if (t && t !== steps[i].label) put(steps.map((s, k) => (k === i ? { ...s, label: t } : s)));
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    put(next);
  };
  const remove = (i: number) => {
    const s = steps[i];
    const go = () => put(steps.filter((_, k) => k !== i));
    if (s.core) ask({ title: `Remove “${s.label}”?`, body: `${s.why ? `${s.why} ` : ''}It’s a built-in step. Reset to Defaults brings it back.`, label: 'Remove Step', run: go });
    else go();
  };
  const add = () => { const t = draft.trim(); if (t) { put([...steps, { id: '', label: t }]); setDraft(''); } };
  return (
    <Section
      title={ritual.name}
      end={<Button variant="plain" disabled={!ritual.customised || reset.isPending} onClick={() => ask({ title: `Reset ${ritual.name.toLowerCase()} to defaults?`, body: 'Your renamed, reordered and added steps are replaced by the built-in list.', label: 'Reset to Defaults', run: () => reset.mutate({ id: ritual.id }) })}>Reset to Defaults</Button>}
    >
      <Group>
        {steps.map((s, i) => (
          <Item key={s.id}>
            <span className="rt-n num">{i + 1}</span>
            <div className="title">
              <Input
                className="rt-label"
                aria-label={`Step ${i + 1} name`}
                key={`${s.id}:${s.label}`}
                defaultValue={s.label}
                maxLength={160}
                onBlur={(e) => rename(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { (e.target as HTMLInputElement).value = s.label; (e.target as HTMLInputElement).blur(); }
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, e.key === 'ArrowUp' ? -1 : 1); }
                }}
              />
              {s.why && <div className="sub"><Why source={s.source}>{s.why}</Why></div>}
            </div>
            <div className="rt-btns">
              <IconButton icon="ChevronUp" label={`Move “${s.label}” up`} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton icon="ChevronDown" label={`Move “${s.label}” down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)} />
              <IconButton icon="Trash2" label={`Remove “${s.label}”`} disabled={steps.length === 1} onClick={() => remove(i)} />
            </div>
          </Item>
        ))}
      </Group>
      <form className="rt-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Input className="grow" aria-label={`New ${ritual.name.toLowerCase()} step`} placeholder="New step" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={160} />
        <Button disabled={!draft.trim() || save.isPending} onClick={add}>Add Step</Button>
      </form>
    </Section>
  );
}

function RitualsPanel() {
  const q = useApi<Row[]>('/api/rituals');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  if (!q.data) return <Empty>Loading…</Empty>;
  return (
    <>
      <p className="small muted rt-intro">
        These checklists run the shutdown, the weekly review and the morning. Rename, reorder, add or remove steps; built-in steps keep their reason and source.
      </p>
      {q.data.map((r) => <RitualEditor key={r.id} ritual={r} ask={setConfirm} />)}
      <Sheet
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ''}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={() => { confirm?.run(); setConfirm(null); }}>{confirm?.label}</Button></>}
      >
        <p className="muted">{confirm?.body}</p>
      </Sheet>
    </>
  );
}

export default defineWebModule({
  id: 'rituals',
  settingsPanel: RitualsPanel,
});
