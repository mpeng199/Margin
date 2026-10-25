import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { api } from '@web/lib/api';
import { queryClient, useApi } from '@web/lib/query';
import { fmtDay, relDay, relDayLower, todayISO } from '@web/lib/format';
import { daysBetween } from '@core/time';
import { Section, Group, Item, Button, IconButton, Sheet, Field, Input, Select, TextArea, Check, Tag, Empty, Banner, toast } from '@web/ui';
import type { Cadence, CheckinNote, DelegatedFunction, Script, WaitingItem } from '../manifest';

const CADENCE: Record<Cadence, string> = { weekly: 'Weekly', biweekly: 'Every two weeks', monthly: 'Monthly' };

function useSend() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true); setError(null);
    try { const out = await fn(); void queryClient.invalidateQueries(); return out; }
    catch (e: any) { setError(e?.message ?? 'Something went wrong. Try again.'); return null; }
    finally { setBusy(false); }
  };
  return { busy, error, run };
}
const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" style={{ color: 'var(--amber)', fontSize: 'var(--t-callout)' }}>{error}</p> : null);

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
  catch { toast('Couldn’t copy. Select the text and copy it yourself.'); }
}

// ---------------------------------------------------------------- People (used by the project tabs)
function FunctionSheet({ projectId, fn, onClose }: { projectId: string; fn?: DelegatedFunction; onClose: () => void }) {
  const { busy, error, run } = useSend();
  const [name, setName] = useState(fn?.name ?? '');
  const [owner, setOwner] = useState(fn?.owner ?? '');
  const [rights, setRights] = useState(fn?.decisionRights ?? '');
  const [good, setGood] = useState(fn?.goodEnough ?? '');
  const [due, setDue] = useState(fn?.dueDate ?? '');
  const [cadence, setCadence] = useState<Cadence>(fn?.cadence ?? 'weekly');
  const [mins, setMins] = useState(String(fn?.checkinMin ?? 20));
  const [sure, setSure] = useState(false);
  const save = async () => {
    const body = { name, owner: owner.trim() || null, decisionRights: rights, goodEnough: good, dueDate: due || null, cadence, checkinMin: Math.min(120, Math.max(5, Number(mins) || 20)) };
    if (await run(() => (fn ? api.patch(`/api/delegation/functions/${fn.id}`, body) : api.post('/api/delegation/functions', { projectId, ...body })))) onClose();
  };
  return (
    <Sheet open onClose={onClose} wide title={fn ? 'Edit Function' : 'New Function'} subtitle="A function is a piece of this project that one person owns."
      footer={<>
        {fn && <div className="left"><Button disabled={busy} onClick={async () => { if (!sure) return setSure(true); if (await run(() => api.del(`/api/delegation/functions/${fn.id}`))) onClose(); }}>{sure ? 'Remove With Its Notes' : 'Remove…'}</Button></div>}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={save}>{fn ? 'Save' : 'Add Function'}</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Function"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Intake and reviewers" /></Field>
          <Field label="Owner" hint="Leave empty if nobody owns it yet."><Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Name" /></Field>
        </div>
        <Field label="Decision rights" hint="What the owner can decide without asking you."><TextArea rows={2} value={rights} onChange={(e) => setRights(e.target.value)} /></Field>
        <Field label="Good enough" hint="Written down, so done has a definition."><TextArea rows={2} value={good} onChange={(e) => setGood(e.target.value)} /></Field>
        <div className="form-grid">
          <Field label="Due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Check-in"><Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>{(Object.keys(CADENCE) as Cadence[]).map((c) => <option key={c} value={c}>{CADENCE[c]}</option>)}</Select></Field>
          <Field label="Check-in length (minutes)"><Input type="number" min={5} max={120} step={5} value={mins} onChange={(e) => setMins(e.target.value)} /></Field>
        </div>
        <Err error={error} />
      </div>
    </Sheet>
  );
}

function CheckinSheet({ fn, onClose }: { fn: DelegatedFunction; onClose: () => void }) {
  const { busy, error, run } = useSend();
  const [note, setNote] = useState('');
  return (
    <Sheet open onClose={onClose} title={`Check-in: ${fn.name}`} subtitle={fn.owner ? `With ${fn.owner}. Logging it moves the next one to ${CADENCE[fn.cadence].toLowerCase()} from today.` : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={async () => { if (await run(() => api.post(`/api/delegation/functions/${fn.id}/checkins`, { note }))) onClose(); }}>Log Check-in</Button></>}>
      <div className="stack"><Field label="Notes" hint="What was decided, what is blocked, what you owe them."><TextArea rows={5} value={note} onChange={(e) => setNote(e.target.value)} /></Field><Err error={error} /></div>
    </Sheet>
  );
}

function WaitingSheet({ projectId, item, fns, onClose }: { projectId: string; item?: WaitingItem; fns: DelegatedFunction[]; onClose: () => void }) {
  const { busy, error, run } = useSend();
  const [what, setWhat] = useState(item?.what ?? '');
  const [who, setWho] = useState(item?.who ?? '');
  const [due, setDue] = useState(item?.due ?? '');
  const [fnId, setFnId] = useState(item?.functionId ?? '');
  const [sure, setSure] = useState(false);
  const save = async () => {
    const body = { what, who, due: due || null, functionId: fnId || null };
    if (await run(() => (item ? api.patch(`/api/delegation/waiting/${item.id}`, body) : api.post('/api/delegation/waiting', { projectId, ...body })))) onClose();
  };
  return (
    <Sheet open onClose={onClose} title={item ? 'Edit Waiting-on Item' : 'Add Waiting-on Item'} subtitle="Something you are waiting for someone else to do or send."
      footer={<>
        {item && <div className="left"><Button disabled={busy} onClick={async () => { if (!sure) return setSure(true); if (await run(() => api.del(`/api/delegation/waiting/${item.id}`))) onClose(); }}>{sure ? 'Remove Item' : 'Remove…'}</Button></div>}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !what.trim()} onClick={save}>{item ? 'Save' : 'Add'}</Button></>}>
      <div className="stack">
        <Field label="Waiting for"><Input value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Reviewer assignments" /></Field>
        <div className="form-grid">
          <Field label="From whom"><Input value={who} onChange={(e) => setWho(e.target.value)} /></Field>
          <Field label="Expected by"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        </div>
        {fns.length > 0 && <Field label="Function"><Select value={fnId} onChange={(e) => setFnId(e.target.value)}><option value="">None</option>{fns.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Field>}
        <Err error={error} />
      </div>
    </Sheet>
  );
}

/** Owners, check-ins and waiting-on for one project. Rendered by the project's People tab. */
export function People({ projectId }: { projectId: string }) {
  const fns = useApi<DelegatedFunction[]>(`/api/delegation/functions?projectId=${projectId}`);
  const waiting = useApi<WaitingItem[]>(`/api/delegation/waiting?projectId=${projectId}`);
  const notes = useApi<CheckinNote[]>(`/api/delegation/checkins?projectId=${projectId}`);
  const [sheet, setSheet] = useState<null | { t: 'fn'; fn?: DelegatedFunction } | { t: 'checkin'; fn: DelegatedFunction } | { t: 'wait'; item?: WaitingItem }>(null);
  const today = todayISO();
  const list = fns.data ?? [];
  const name = (id: string) => list.find((f) => f.id === id)?.name ?? 'Removed function';
  const done = async (w: WaitingItem) => { try { await api.patch(`/api/delegation/waiting/${w.id}`, { done: true }); void queryClient.invalidateQueries(); } catch (e: any) { toast(e.message); } };
  return (
    <>
      <Section title="Functions" why="One owner, written decision rights, and a written good-enough per function." end={<Button icon="Plus" onClick={() => setSheet({ t: 'fn' })}>Add Function</Button>}>
        <Group>
          {list.length ? list.map((f) => {
            const late = f.owner && f.nextCheckin < today ? daysBetween(f.nextCheckin, today) : 0;
            return (
              <Item key={f.id}>
                <div className="title">
                  <div>{f.name}</div>
                  <div className="sub">{f.owner ? `Owner: ${f.owner}` : 'No owner yet'}{f.dueDate ? `. Due ${fmtDay(f.dueDate)}` : ''}</div>
                  {f.decisionRights && <div className="sub">Decides: {f.decisionRights}</div>}
                  {f.goodEnough && <div className="sub">Good enough: {f.goodEnough}</div>}
                </div>
                {f.owner && (late ? <Tag tone="amber">Check-in {late} day{late === 1 ? '' : 's'} overdue</Tag> : <Tag>Next check-in {relDayLower(f.nextCheckin)}</Tag>)}
                <span className="meta">{CADENCE[f.cadence]}, {f.checkinMin} min</span>
                {f.owner && <Button onClick={() => setSheet({ t: 'checkin', fn: f })}>Log Check-in…</Button>}
                <IconButton icon="Pencil" label={`Edit ${f.name}`} onClick={() => setSheet({ t: 'fn', fn: f })} />
              </Item>
            );
          }) : <Empty action={<Button onClick={() => setSheet({ t: 'fn' })}>Add Function</Button>}>No functions yet. Split the project into pieces someone else can own.</Empty>}
        </Group>
      </Section>

      <Section title="Waiting on" end={<Button icon="Plus" onClick={() => setSheet({ t: 'wait' })}>Add</Button>}>
        <Group>
          {waiting.data?.length ? waiting.data.map((w) => {
            const late = w.due && w.due < today;
            return (
              <Item key={w.id}>
                <Check checked={false} onChange={() => void done(w)} label={`Mark received: ${w.what}`} />
                <div className="title">{w.what}<div className="sub">{w.who ? `From ${w.who}. ` : ''}Since {fmtDay(w.since)}{w.functionId ? `. ${name(w.functionId)}` : ''}</div></div>
                {w.due && (late ? <Tag tone="amber">Late, was due {fmtDay(w.due)}</Tag> : <span className="meta">by {fmtDay(w.due)}</span>)}
                <IconButton icon="Pencil" label={`Edit ${w.what}`} onClick={() => setSheet({ t: 'wait', item: w })} />
              </Item>
            );
          }) : <Empty>Nothing pending.</Empty>}
        </Group>
      </Section>

      <Section title="Check-in notes">
        <Group>
          {notes.data?.length ? notes.data.slice(0, 12).map((n) => (
            <Item key={n.id}><div className="title">{name(n.functionId)}<div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{n.note || 'No notes.'}</div></div><span className="meta">{fmtDay(n.date)}</span></Item>
          )) : <Empty>No check-ins logged yet.</Empty>}
        </Group>
      </Section>

      {sheet?.t === 'fn' && <FunctionSheet projectId={projectId} fn={sheet.fn} onClose={() => setSheet(null)} />}
      {sheet?.t === 'checkin' && <CheckinSheet fn={sheet.fn} onClose={() => setSheet(null)} />}
      {sheet?.t === 'wait' && <WaitingSheet projectId={projectId} item={sheet.item} fns={list} onClose={() => setSheet(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- Say-no scripts
function ScriptSheet({ script, onClose }: { script?: Script; onClose: () => void }) {
  const { busy, error, run } = useSend();
  const [title, setTitle] = useState(script?.title ?? '');
  const [body, setBody] = useState(script?.body ?? '');
  const [sure, setSure] = useState(false);
  return (
    <Sheet open onClose={onClose} title={script ? 'Edit Script' : 'New Script'}
      footer={<>
        {script && <div className="left"><Button disabled={busy} onClick={async () => { if (!sure) return setSure(true); if (await run(() => api.del(`/api/delegation/scripts/${script.id}`))) onClose(); }}>{sure ? 'Remove Script' : 'Remove…'}</Button></div>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !body.trim()} onClick={async () => { if (await run(() => (script ? api.patch(`/api/delegation/scripts/${script.id}`, { title, body }) : api.post('/api/delegation/scripts', { title, body })))) onClose(); }}>Save</Button></>}>
      <div className="stack">
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="At capacity" /></Field>
        <Field label="Script" hint="Write it the way you would say it. Use X, Y and Z for the parts that change."><TextArea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <Err error={error} />
      </div>
    </Sheet>
  );
}

function DraftSheet({ scripts, onClose }: { scripts: Script[]; onClose: () => void }) {
  const { busy, error, run } = useSend();
  const [situation, setSituation] = useState('');
  const [scriptId, setScriptId] = useState('');
  const [text, setText] = useState('');
  return (
    <Sheet open onClose={onClose} wide title="Draft with Claude" subtitle="Claude writes a reply you can copy. Nothing is sent anywhere."
      footer={<><Button onClick={onClose}>Close</Button>{text && <Button onClick={() => void copy(text)}>Copy to Clipboard</Button>}
        <Button variant="primary" disabled={busy || !situation.trim()} onClick={async () => { const out = await run(() => api.post<{ text: string }>('/api/delegation/draft', { situation, ...(scriptId ? { scriptId } : {}) })); if (out) setText(out.text); }}>{text ? 'Draft Again' : 'Draft'}</Button></>}>
      <div className="stack">
        <Field label="What are they asking for?"><TextArea rows={3} value={situation} onChange={(e) => setSituation(e.target.value)} placeholder="A club officer wants me to run the spring fundraiser." /></Field>
        <Field label="Start from"><Select value={scriptId} onChange={(e) => setScriptId(e.target.value)}><option value="">No script</option>{scripts.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select></Field>
        <Err error={error} />
        {text && <Field label="Draft"><TextArea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
      </div>
    </Sheet>
  );
}

function ScriptsPage() {
  const scripts = useApi<Script[]>('/api/delegation/scripts');
  const ai = useApi<{ enabled: boolean }>('/api/delegation/draft/available');
  const [, navigate] = useLocation();
  const search = useSearch();
  const [edit, setEdit] = useState<{ script?: Script } | null>(null);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(search).get('new') === '1') { setEdit({}); navigate('/scripts', { replace: true }); }
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = scripts.data ?? [];
  return (
    <Page title="Say-No Scripts" width="narrow" actions={<>
      {ai.data?.enabled && <Button icon="Sparkles" onClick={() => setDrafting(true)}>Draft with Claude</Button>}
      <Button variant="primary" icon="Plus" onClick={() => setEdit({})}>New Script</Button></>}>
      <Section title="Scripts" why="A decision made in advance is easier to keep than one made under pressure. Edit these until they sound like you.">
        <Group>
          {list.length ? list.map((s) => (
            <Item key={s.id}>
              <div className="title"><div>{s.title}</div><div className="sub selectable" style={{ whiteSpace: 'pre-wrap' }}>{s.body}</div></div>
              <Button onClick={() => void copy(s.body)}>Copy to Clipboard</Button>
              <IconButton icon="Pencil" label={`Edit ${s.title}`} onClick={() => setEdit({ script: s })} />
            </Item>
          )) : <Empty action={<Button onClick={() => setEdit({})}>New Script</Button>}>No scripts. Write the sentence you want ready the next time you need to say no.</Empty>}
        </Group>
      </Section>
      {ai.data && !ai.data.enabled && <Banner icon="Sparkles">Drafting with Claude is off. Turn Claude on in Settings to get a draft; copying scripts works without it.</Banner>}
      {edit && <ScriptSheet script={edit.script} onClose={() => setEdit(null)} />}
      {drafting && <DraftSheet scripts={list} onClose={() => setDrafting(false)} />}
    </Page>
  );
}

export default defineWebModule({
  id: 'delegation',
  routes: [{ path: '/scripts', component: ScriptsPage, work: false }],
  commands: [
    { id: 'delegation.scripts', label: 'Copy a Say-No Script', group: 'Delegation', run: () => '/scripts' },
    { id: 'delegation.script.new', label: 'New Say-No Script', group: 'Delegation', run: () => '/scripts?new=1' },
  ],
});
