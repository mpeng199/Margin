import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { keepPreviousData } from '@tanstack/react-query';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi, queryClient } from '@web/lib/query';
import { api } from '@web/lib/api';
import { useHotkey } from '@web/lib/hooks';
import { DateTime } from 'luxon';
import { dt, fmtDay, todayISO, serverNow } from '@web/lib/format';
import { Section, Group, Item, Button, IconButton, Icon, Sheet, Input, Field, Banner, toast } from '@web/ui';
import { titleKey } from '../parse';
import type { Note, NoteSummary } from '../service';
import { Markdown, openTitle } from './Markdown';
import { Editor, type TitleRef } from './Editor';
import { useFilter, setFilter } from './store';
import './brain.css';

const refresh = () => queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/api/brain') });
const useTitles = () => useApi<TitleRef[]>('/api/brain/titles', { staleTime: 30_000 });
/** “5 minutes ago” against the daemon's clock (it is the time authority). */
const ago = (iso: string) => dt(iso).toRelative({ base: DateTime.fromMillis(serverNow()) });

/** Apple Notes-style date: time today, weekday this week, else the date. */
function when(n: NoteSummary) {
  if (n.date) return fmtDay(n.date);
  const d = dt(n.updatedAt);
  const days = Math.round(dt(`${todayISO()}T12:00:00`).startOf('day').diff(d.startOf('day'), 'days').days);
  return days === 0 ? d.toFormat('h:mm a') : days > 0 && days < 7 ? d.toFormat('cccc') : d.toFormat('M/d/yy');
}

async function newNote(navigate: (to: string) => void, area?: string | null) {
  const n = await api.post<Note>('/api/brain/notes', { area: area && area !== 'Journal' ? area : 'Inbox' });
  void refresh();
  navigate(`/brain/${n.id}?edit=1`);
}
async function openToday(navigate: (to: string) => void) {
  const n = await api.post<Note>('/api/brain/daily', {});
  void refresh();
  navigate(`/brain/${n.id}`);
}

// ------------------------------------------------------------------ page
function BrainPage({ params }: { params?: { id?: string } }) {
  const id = params?.id ?? null;
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const f = useFilter();
  const [importing, setImporting] = useState(false);

  // Links like /brain?tag=x and /brain?open=Title land here. Loading a URL never writes: an unknown title becomes a search.
  useEffect(() => {
    const tag = search.get('tag'), open = search.get('open');
    if (tag) setFilter({ tag, area: null, q: '', trash: false });
    if (open) {
      void api.get<{ id: string | null }>(`/api/brain/resolve?title=${encodeURIComponent(open)}`).then(({ id }) => {
        if (id) navigate(`/brain/${id}`, { replace: true });
        else setFilter({ q: open, area: null, tag: null, trash: false });
      }).catch(() => {});
    }
  }, [search.get('tag'), search.get('open')]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Page title="Brain" width="full" actions={<>
      <Button icon="CalendarDays" onClick={() => void openToday(navigate)} title="Open today’s journal note">Today</Button>
      <Button icon="SquarePen" onClick={() => void newNote(navigate, f.area)}>New Note</Button>
    </>}>
      <div className="brain">
        <NoteList selected={id} onImport={() => setImporting(true)} />
        <div className="brain-pane">
          {id ? <Contained key={id}><NoteView id={id} startEditing={search.get('edit') === '1'} /></Contained> : <Home />}
        </div>
      </div>
      <ImportSheet open={importing} onClose={() => setImporting(false)} />
    </Page>
  );
}

/** Notes hold text from many places (imports, calendars, Claude); one that fails to render shouldn't blank the app. */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error('brain: note failed to render', e); }
  render() {
    return this.state.failed
      ? <div className="brain-home"><h2>This note couldn’t be shown</h2><p className="muted">Something in its text tripped the renderer. Your text is saved; open another note.</p></div>
      : this.props.children;
  }
}

// ------------------------------------------------------------------ list
function NoteList({ selected, onImport }: { selected: string | null; onImport: () => void }) {
  const f = useFilter();
  const [, navigate] = useLocation();
  const [q, setQ] = useState(f.q);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setFilter({ q }), 180); return () => clearTimeout(t); }, [q]);
  /** ↑↓ move through the list and open each note, as in Notes. */
  const moveSelection = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('.brain-row')];
    const i = rows.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) { if (e.key === 'ArrowUp') searchRef.current?.focus(); return; }
    e.preventDefault();
    next.focus();
    next.click();
  };
  useEffect(() => { if (f.q !== q && !f.q) setQ(''); }, [f.q]); // eslint-disable-line react-hooks/exhaustive-deps
  useHotkey('Mod+Alt+f', () => searchRef.current?.focus());

  const areas = useApi<{ area: string; count: number }[]>('/api/brain/areas');
  const tags = useApi<{ tag: string; count: number }[]>('/api/brain/tags');
  const params = new URLSearchParams();
  if (f.area) params.set('area', f.area);
  if (f.tag) params.set('tag', f.tag);
  if (f.q.trim()) params.set('q', f.q.trim());
  const list = useApi<{ notes: NoteSummary[]; total: number }>(f.trash ? null : `/api/brain/notes?${params}`, { placeholderData: keepPreviousData });
  const trash = useApi<NoteSummary[]>(f.trash ? '/api/brain/trash' : null);
  const notes = (f.trash ? trash.data : list.data?.notes) ?? [];
  const scope = f.trash ? 'trash' : f.tag ? `tag:${f.tag}` : f.area ? `area:${f.area}` : '';
  const pinned = notes.filter((n) => n.pinned);
  const rest = notes.filter((n) => !n.pinned);

  const onScope = (v: string) => setFilter({
    trash: v === 'trash', area: v.startsWith('area:') ? v.slice(5) : null, tag: v.startsWith('tag:') ? v.slice(4) : null,
  });
  const compile = async () => {
    try {
      const r = await api.post<{ created: number; updated: number }>('/api/brain/compile', {});
      void refresh();
      toast(r.created || r.updated ? `Updated ${r.created + r.updated} note${r.created + r.updated === 1 ? '' : 's'} from Margin.` : 'Already up to date.');
    } catch (e: any) { toast(e.message); }
  };

  return (
    <aside className="brain-list" aria-label="Notes">
      <div className="brain-list-head">
        <label className="brain-search">
          <Icon name="Search" size={13} />
          <input ref={searchRef} className="input bare" value={q} placeholder="Search" aria-label="Search notes"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('');
              if (e.key === 'ArrowDown') { e.preventDefault(); itemsRef.current?.querySelector<HTMLElement>('.brain-row')?.focus(); }
            }} />
          {q && <button className="brain-clear" aria-label="Clear search" onClick={() => setQ('')}><Icon name="X" size={11} /></button>}
        </label>
        <select className="select brain-scope" value={scope} onChange={(e) => onScope(e.target.value)} aria-label="Show">
          <option value="">All Notes</option>
          {(areas.data ?? []).map((a) => <option key={a.area} value={`area:${a.area}`}>{a.area} ({a.count})</option>)}
          {!!tags.data?.length && (
            <optgroup label="Tags">{tags.data.map((t) => <option key={t.tag} value={`tag:${t.tag}`}>#{t.tag} ({t.count})</option>)}</optgroup>
          )}
          {f.tag && !tags.data?.some((t) => t.tag === f.tag) && <option value={`tag:${f.tag}`}>#{f.tag}</option>}
          <option value="trash">Recently Deleted</option>
        </select>
      </div>
      <div className="brain-items" ref={itemsRef} onKeyDown={moveSelection}>
        {pinned.length > 0 && <div className="brain-group-label">Pinned</div>}
        {pinned.map((n) => <NoteRow key={n.id} n={n} selected={selected === n.id} />)}
        {pinned.length > 0 && rest.length > 0 && <div className="brain-group-label">Notes</div>}
        {rest.map((n) => <NoteRow key={n.id} n={n} selected={selected === n.id} />)}
        {!notes.length && (list.data || trash.data) && (
          <p className="brain-list-empty">
            {f.trash ? 'Nothing deleted in the last 30 days.' : f.q ? `No notes match “${f.q}”.` : f.area || f.tag ? 'No notes here yet.' : 'No notes yet.'}
          </p>
        )}
        {f.trash && notes.length > 0 && <p className="brain-list-empty">Notes you wrote are removed for good after 30 days.</p>}
      </div>
      <div className="brain-list-foot">
        <span className="faint tiny num">{f.trash ? '' : `${list.data?.total ?? 0} note${list.data?.total === 1 ? '' : 's'}`}</span>
        <IconButton icon="RefreshCw" label="Update notes from Margin" onClick={() => void compile()} />
        <IconButton icon="FolderInput" label="Import a Markdown folder" onClick={onImport} />
        <IconButton icon="Settings" label="Brain settings" onClick={() => navigate('/settings/brain')} />
      </div>
    </aside>
  );
}

function NoteRow({ n, selected }: { n: NoteSummary; selected: boolean }) {
  return (
    <Link href={`/brain/${n.id}`} className="brain-row" aria-current={selected ? 'page' : undefined}>
      <div className="brain-row-title">
        {n.pinned && <Icon name="Pin" size={11} className="brain-pin" />}
        <span className="ellipsis">{n.title}</span>
        {n.private && <Icon name="Lock" size={11} className="brain-row-lock" />}
      </div>
      <div className="brain-row-sub"><span className="num">{when(n)}</span><span className="ellipsis">{n.snippet || (n.generated ? 'From Margin' : 'No text')}</span></div>
    </Link>
  );
}

// ------------------------------------------------------------------ empty pane
function Home() {
  const [, navigate] = useLocation();
  const areas = useApi<{ area: string; count: number }[]>('/api/brain/areas');
  const total = (areas.data ?? []).reduce((n, a) => n + a.count, 0);
  return (
    <div className="brain-home">
      <Icon name="Brain" size={30} strokeWidth={1.4} />
      <h2>{total ? 'Choose a note' : 'Your second brain'}</h2>
      <p className="muted">
        {total
          ? 'Or start a new one. Link notes with [[double brackets]] and group them with #tags.'
          : 'Margin fills it in from your routine, projects, people and days. Write anything else here: people, ideas, plans, reference.'}
      </p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <Button onClick={() => void openToday(navigate)}>Today’s Note</Button>
        <Button variant="primary" onClick={() => void newNote(navigate)}>New Note</Button>
      </div>
      {!!areas.data?.length && (
        <div className="brain-home-areas">
          {areas.data.map((a) => (
            <button key={a.area} className="brain-home-area" onClick={() => setFilter({ area: a.area, tag: null, trash: false })}>
              <span>{a.area}</span><span className="faint num">{a.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ note
function NoteView({ id, startEditing }: { id: string; startEditing: boolean }) {
  const q = useApi<Note>(`/api/brain/notes/${id}`, { staleTime: 0, retry: false });
  const titles = useTitles();
  const [, navigate] = useLocation();
  const [careHidden, setCareHidden] = useState(false);
  const n = q.data;
  // Until titles load, don't mark links as missing.
  const known = useMemo(() => (titles.data ? new Set(titles.data.map((t) => titleKey(t.title))) : undefined), [titles.data]);

  if (q.isError) {
    return <div className="brain-home"><h2>This note isn’t here</h2><p className="muted">It may have been deleted for good.</p><Button onClick={() => navigate('/brain')}>All Notes</Button></div>;
  }
  if (!n) return null;

  const patch = async (body: Partial<Pick<Note, 'pinned' | 'private' | 'area'>>, msg?: string) => {
    try { await api.patch(`/api/brain/notes/${id}`, body); void refresh(); if (msg) toast(msg); } catch (e: any) { toast(e.message); }
  };
  const remove = async () => {
    try {
      await api.del(`/api/brain/notes/${id}`);
      void refresh();
      navigate('/brain');
      toast('Moved to Recently Deleted.', { label: 'Undo', run: () => { void api.post(`/api/brain/notes/${id}/restore`).then(() => { void refresh(); navigate(`/brain/${id}`); }); } });
    } catch (e: any) { toast(e.message); }
  };
  const restore = async () => {
    try { await api.post(`/api/brain/notes/${id}/restore`); void refresh(); } catch (e: any) { toast(e.message); }
  };
  const deleted = !!n.deletedAt;
  // A brand-new note starts on its title; Return then moves to the text.
  const newNote = startEditing && !deleted && /^Untitled( \d+)?$/.test(n.title) && !n.body;

  return (
    <article className="brain-note" aria-label={n.title}>
      {deleted && <Banner icon="Trash" action={<Button onClick={() => void restore()}>Restore</Button>}>This note is in Recently Deleted.</Banner>}
      {n.care && !careHidden && (
        <Banner icon="LifeBuoy" action={<Button onClick={() => navigate('/help')}>Get Help</Button>} onDismiss={() => setCareHidden(true)}>
          If you’re thinking about hurting yourself, you don’t have to carry it alone. Call or text 988, any hour, and tell a trusted adult today.
        </Banner>
      )}
      <header className="brain-note-head">
        <TitleField note={n} autoFocus={newNote} />
        <div className="brain-meta">
          <AreaField note={n} disabled={deleted} />
          {n.tags.map((t) => (
            <button key={t} className="brain-chip" onClick={() => setFilter({ tag: t, area: null, q: '', trash: false })} title={`Show notes tagged #${t}`}>#{t}</button>
          ))}
          {n.journal && (
            <span className="brain-days">
              <IconButton icon="ChevronLeft" label={n.journal.prev ? `Previous entry, ${fmtDay(n.journal.prev.date)}` : 'No earlier entry'} disabled={!n.journal.prev} onClick={() => n.journal?.prev && navigate(`/brain/${n.journal.prev.id}`)} />
              <IconButton icon="ChevronRight" label={n.journal.next ? `Next entry, ${fmtDay(n.journal.next.date)}` : 'No later entry'} disabled={!n.journal.next} onClick={() => n.journal?.next && navigate(`/brain/${n.journal.next.id}`)} />
            </span>
          )}
          <span className="faint num brain-updated">
            {n.date ? dt(`${n.date}T12:00:00`).toFormat('cccc, LLLL d, yyyy') : n.updatedAt !== n.createdAt ? `Edited ${ago(n.updatedAt)}` : n.generated ? '' : `Created ${ago(n.createdAt)}`}
          </span>
          {!deleted && (
            <div className="brain-meta-end">
              <IconButton icon="Pin" label={n.pinned ? 'Pinned. Click to unpin.' : 'Pin to the top'} aria-pressed={n.pinned} onClick={() => void patch({ pinned: !n.pinned })} className={n.pinned ? 'brain-on' : ''} />
              <IconButton icon={n.private ? 'Lock' : 'LockOpen'} label={n.private ? 'Private: hidden from Claude. Click to share.' : 'Claude can read this. Click to hide it.'}
                className={n.private ? 'brain-on' : ''}
                onClick={() => void patch({ private: !n.private }, n.private ? 'Claude can read this note again.' : 'Hidden from Claude.')} />
              <IconButton icon="Trash" label="Delete" onClick={() => void remove()} />
            </div>
          )}
        </div>
      </header>
      {(n.auto || n.wellbeing) && <FromMargin note={n} known={known} />}
      <Body note={n} titles={titles.data ?? []} known={known} startEditing={startEditing && !deleted} focusEditor={!newNote} readOnly={deleted} />
      <Connections note={n} />
    </article>
  );
}

function TitleField({ note, autoFocus }: { note: Note; autoFocus?: boolean }) {
  const locked = note.generated || !!note.date || !!note.deletedAt;
  const [value, setValue] = useState(note.title);
  useEffect(() => setValue(note.title), [note.title]);
  const commit = async () => {
    const v = value.trim();
    if (!v || v === note.title) { setValue(note.title); return; }
    try {
      const out = await api.patch<Note>(`/api/brain/notes/${note.id}`, { title: v });
      setValue(out.title);
      void refresh();
      if (out.title !== v) toast(`Saved as “${out.title}”: titles are unique and can’t contain [ ] | # ^.`);
    } catch (e: any) { toast(e.message); setValue(note.title); }
  };
  return (
    <input className="brain-title" value={value} readOnly={locked} aria-label="Title" autoFocus={autoFocus && !locked}
      onFocus={(e) => { if (autoFocus) e.currentTarget.select(); }}
      title={locked ? (note.date ? 'Journal notes are named by their date.' : 'Named after its source in Margin.') : undefined}
      onChange={(e) => setValue(e.target.value)} onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
          document.querySelector<HTMLTextAreaElement>('.brain-textarea')?.focus();
        }
        if (e.key === 'Escape') { setValue(note.title); (e.target as HTMLInputElement).blur(); }
      }} />
  );
}

function AreaField({ note, disabled }: { note: Note; disabled: boolean }) {
  const areas = useApi<{ area: string; count: number }[]>('/api/brain/areas');
  const [value, setValue] = useState(note.area);
  useEffect(() => setValue(note.area), [note.area]);
  const commit = async () => {
    const v = value.trim();
    if (!v || v === note.area) { setValue(note.area); return; }
    try { await api.patch(`/api/brain/notes/${note.id}`, { area: v }); void refresh(); } catch (e: any) { toast(e.message); setValue(note.area); }
  };
  const options = [...new Set(['Inbox', 'Me', 'Projects', 'People', 'Journal', 'Ideas', 'Reference', ...(areas.data ?? []).map((a) => a.area)])];
  return (
    <label className="brain-area" title="Area. Pick one or type a new name.">
      <Icon name="Folder" size={12} />
      <input className="input bare" list={`brain-areas-${note.id}`} value={value} disabled={disabled} aria-label="Area"
        onChange={(e) => setValue(e.target.value)} onBlur={() => void commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setValue(note.area); (e.target as HTMLInputElement).blur(); } }} />
      <datalist id={`brain-areas-${note.id}`}>{options.map((a) => <option key={a} value={a} />)}</datalist>
    </label>
  );
}

function FromMargin({ note, known }: { note: Note; known?: Set<string> }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="brain-auto" aria-label="From Margin">
      <button className="brain-auto-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} />
        <span>From Margin</span>
        <span className="faint">{note.compiledAt ? `updated ${ago(note.compiledAt)}` : ''}</span>
      </button>
      {open && (
        <div className="brain-auto-body">
          {note.auto && <Markdown text={note.auto} known={known} />}
          {note.wellbeing && (
            <div className="brain-wellbeing">
              <div className="brain-wellbeing-head"><Icon name="Lock" size={11} /> Sleep and mood stay out of Claude unless you turn on sharing in Settings → Claude.</div>
              <Markdown text={note.wellbeing} known={known} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The person's text. Read view by default; click, Edit or ⌘E to write. Saves 600 ms after you stop typing. */
function Body({ note, titles, known, startEditing, focusEditor, readOnly }: { note: Note; titles: TitleRef[]; known?: Set<string>; startEditing: boolean; focusEditor: boolean; readOnly: boolean }) {
  const [text, setText] = useState(note.body);
  // Empty notes open ready to type; so does an empty journal note, even with Margin's part filled in.
  const [editing, setEditing] = useState(!readOnly && (startEditing || (!note.body.trim() && (!note.auto || !!note.date))));
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const saved = useRef(note.body);
  const latest = useRef(note.body);

  // Someone else changed the note (a reviewed Claude suggestion, a rename elsewhere): take it if nothing is pending here.
  useEffect(() => {
    if (latest.current === saved.current && note.body !== saved.current) { saved.current = note.body; latest.current = note.body; setText(note.body); }
  }, [note.body]);

  const save = async () => {
    const v = latest.current;
    if (v === saved.current) return;
    setState('saving');
    try {
      await api.patch(`/api/brain/notes/${note.id}`, { body: v });
      saved.current = v;
      setState(latest.current === v ? 'saved' : 'saving');
      void refresh();
    } catch { setState('error'); }
  };
  useEffect(() => {
    latest.current = text;
    if (text === saved.current) return;
    setState('saving');
    const t = setTimeout(() => void save(), 600);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { // leaving the note: write what's pending
    if (latest.current !== saved.current) {
      void api.patch(`/api/brain/notes/${note.id}`, { body: latest.current }).then(() => refresh())
        .catch((e) => { if (e?.status !== 404) toast('Your last edit didn’t save. Open the note again and retype it.'); }); // 404: the note was just deleted
    }
  }, [note.id]);
  useHotkey('Mod+e', () => { if (!readOnly) setEditing((e) => !e); }, [readOnly]);

  const status = state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : 'Not saved. Retrying on your next edit.';
  return (
    <section className="brain-body" aria-label="Your notes">
      <div className="brain-body-bar">
        {note.auto && <span className="brain-body-label">Your notes</span>}
        <span className="faint tiny" role="status">{text !== note.body || state !== 'saved' ? status : ''}</span>
        {!readOnly && (
          <Button variant="plain" onClick={() => setEditing(!editing)} kbd="⌘E">{editing ? 'Done' : 'Edit'}</Button>
        )}
      </div>
      {editing ? (
        <Editor value={text} onChange={setText} titles={titles} onDone={() => setEditing(false)} autoFocus={focusEditor} />
      ) : text.trim() ? (
        <div className="brain-read" onClick={(e) => { if (!readOnly && !(e.target as HTMLElement).closest('a') && !window.getSelection()?.toString()) setEditing(true); }}>
          <Markdown text={text} known={known} />
        </div>
      ) : !readOnly ? (
        <button className="brain-placeholder" onClick={() => setEditing(true)}>
          {note.auto ? 'Add your own notes. Margin never changes what you write here.' : 'Write something.'}
        </button>
      ) : null}
    </section>
  );
}

function Connections({ note }: { note: Note }) {
  const [, navigate] = useLocation();
  const missing = note.links.filter((l) => !l.id);
  if (!note.backlinks.length && !missing.length) return null;
  return (
    <div className="brain-connections">
      {note.backlinks.length > 0 && (
        <Section title="Linked from" why={`${note.backlinks.length} note${note.backlinks.length === 1 ? '' : 's'}`}>
          <Group>
            {note.backlinks.map((b) => (
              <Item key={b.id} onClick={() => navigate(`/brain/${b.id}`)}>
                <Icon name="CornerDownRight" size={14} className="faint" />
                <div className="title"><div className="ellipsis">{b.title}</div><div className="sub ellipsis">{b.snippet}</div></div>
                <span className="meta">{b.area}</span>
              </Item>
            ))}
          </Group>
        </Section>
      )}
      {missing.length > 0 && (
        <Section title="Not written yet" why="Links to notes that don’t exist yet">
          <Group>
            {missing.map((l) => (
              <Item key={l.title}>
                <Icon name="FilePlus" size={14} className="faint" />
                <div className="title ellipsis">{l.title}</div>
                <Button onClick={() => void openTitle(l.title, navigate)}>Create</Button>
              </Item>
            ))}
          </Group>
        </Section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ import
function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useApi<{ importFolder: string }>(open ? '/api/brain/status' : null);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = folder ?? status.data?.importFolder ?? '';
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ files: number; created: number; updated: number; skipped: number }>('/api/brain/import', { folder: value });
      void refresh();
      toast(`Imported ${r.created} new and ${r.updated} updated note${r.created + r.updated === 1 ? '' : 's'} from ${r.files} file${r.files === 1 ? '' : 's'}.${r.skipped ? ` ${r.skipped} skipped.` : ''}`);
      onClose();
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Import a Markdown Folder"
      subtitle="Brings in .md and .txt files, such as an Obsidian vault. Subfolders become areas. Run it again to pick up changes; notes you edit in Margin are never overwritten."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !value.trim()} onClick={() => void run()}>Import</Button></>}>
      <Field label="Folder" hint="Hidden folders such as .obsidian and files over 1 MB are skipped. Claude can read imported notes; lock any you want to keep from it.">
        <Input value={value} placeholder="~/Documents/Obsidian Vault" onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) void run(); }} />
      </Field>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Today
function TodayNotes() {
  const q = useApi<{ date: string; notes: { id: string; title: string; area: string; reason: string }[] }>('/api/brain/today', { staleTime: 60_000 });
  const [, navigate] = useLocation();
  const notes = q.data?.notes ?? [];
  if (!notes.length) return null;
  return (
    <Section title="From your notes" why="Named in today’s plans">
      <Group>
        {notes.map((n) => (
          <Item key={n.id} onClick={() => navigate(`/brain/${n.id}`)}>
            <Icon name="FileText" size={14} className="faint" />
            <div className="title"><div className="ellipsis">{n.title}</div><div className="sub ellipsis">{n.reason}</div></div>
            <Icon name="ChevronRight" size={14} className="faint" />
          </Item>
        ))}
      </Group>
    </Section>
  );
}

export default defineWebModule({
  id: 'brain',
  routes: [{ path: '/brain', component: BrainPage }, { path: '/brain/:id', component: BrainPage }],
  widgets: { today: TodayNotes },
  commands: [
    { id: 'brain.new', label: 'New Note', group: 'Brain', run: ({ navigate }) => newNote(navigate) },
    { id: 'brain.today', label: 'Today’s Note', group: 'Brain', run: ({ navigate }) => openToday(navigate) },
    { id: 'brain.inbox', label: 'Notes Inbox', group: 'Brain', run: () => { setFilter({ area: 'Inbox', tag: null, q: '', trash: false }); return '/brain'; } },
    { id: 'brain.deleted', label: 'Recently Deleted Notes', group: 'Brain', run: () => { setFilter({ trash: true, area: null, tag: null }); return '/brain'; } },
  ],
});
