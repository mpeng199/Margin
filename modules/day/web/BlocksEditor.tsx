import { useEffect, useState } from 'react';
import { Section, Group, Item, Button, Input, Icon, toast } from '@web/ui';
import { useApi, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';

export interface Block { id: string; label: string; kind: string; days: number[]; start: string; end: string }
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Rows of fixed weekly blocks (name, days, start–end). Used by onboarding and Settings → Day anchors. */
export function FixedBlocksEditor({ blocks, onChange }: { blocks: Block[]; onChange: (b: Block[]) => void }) {
  const upd = (i: number, patch: Partial<Block>) => onChange(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <>
      <Group>
        {blocks.map((b, i) => (
          <Item key={b.id} className="day-block">
            <Input value={b.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label="Block name" style={{ width: 96 }} />
            <div className="days-picker" role="group" aria-label={`${b.label} days`}>
              {'MTWTFSS'.split('').map((d, k) => (
                <button key={k} type="button" aria-pressed={b.days.includes(k + 1)} aria-label={DAYS[k]}
                  onClick={() => upd(i, { days: b.days.includes(k + 1) ? b.days.filter((x) => x !== k + 1) : [...b.days, k + 1].sort() })}>{d}</button>
              ))}
            </div>
            <Input type="time" value={b.start} onChange={(e) => upd(i, { start: e.target.value })} aria-label={`${b.label} start`} />
            <span className="faint">–</span>
            <Input type="time" value={b.end} onChange={(e) => upd(i, { end: e.target.value })} aria-label={`${b.label} end`} />
            <button className="btn icon" aria-label={`Remove ${b.label}`} onClick={() => onChange(blocks.filter((_, j) => j !== i))}><Icon name="X" size={14} /></button>
          </Item>
        ))}
        {!blocks.length && <div className="empty">No fixed blocks. Add school, lab, practice and dinner so capacity is honest.</div>}
      </Group>
      <div className="row" style={{ marginTop: 10 }}>
        <Button icon="Plus" onClick={() => onChange([...blocks, { id: crypto.randomUUID(), label: 'Block', kind: 'other', days: [1, 2, 3, 4, 5], start: '16:00', end: '17:00' }])}>Add Block</Button>
      </div>
    </>
  );
}

/** Settings → Day anchors: the fixed blocks, edited as rows instead of JSON. */
export function DaySettingsPanel() {
  const settings = useApi<{ fixedBlocks: Block[] }>('/api/settings/day');
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  useEffect(() => { if (settings.data) setBlocks(settings.data.fixedBlocks); }, [settings.data]);
  if (!blocks) return null;
  const dirty = JSON.stringify(blocks) !== JSON.stringify(settings.data?.fixedBlocks);
  const save = async () => {
    try { await api.patch('/api/settings/day', { fixedBlocks: blocks }); toast('Saved'); void queryClient.invalidateQueries(); }
    catch (e: any) { toast(e.message); }
  };
  return (
    <Section title="Fixed blocks" why="School, lab, commute, gym, dinner: the time that isn't yours to plan."
      end={<><Button disabled={!dirty} onClick={() => setBlocks(settings.data!.fixedBlocks)}>Revert</Button><Button variant="primary" disabled={!dirty} onClick={save}>Save</Button></>}>
      <FixedBlocksEditor blocks={blocks} onChange={setBlocks} />
    </Section>
  );
}
