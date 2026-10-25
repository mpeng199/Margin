import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '@web/lib/api';
import { useApi } from '@web/lib/query';
import { Group, Section, Segmented, TextArea } from '@web/ui';

/** Markdown notes with autosave: the text is written 800 ms after you stop typing, and once more when you leave. */
export function NotesView({ id }: { id: string }) {
  const q = useApi<{ notes: string }>(`/api/projects/${id}/notes`, { staleTime: 0, gcTime: 0 });
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const saved = useRef('');
  const latest = useRef('');
  useEffect(() => { if (text === null && q.data) { setText(q.data.notes); saved.current = q.data.notes; latest.current = q.data.notes; } }, [q.data, text]);
  const save = async () => {
    const v = latest.current;
    if (v === saved.current) return;
    setState('saving');
    try { await api.put(`/api/projects/${id}/notes`, { notes: v }); saved.current = v; setState(latest.current === v ? 'saved' : 'saving'); }
    catch { setState('error'); }
  };
  useEffect(() => {
    if (text === null) return;
    latest.current = text;
    if (text === saved.current) return;
    setState('saving');
    const t = setTimeout(() => void save(), 800);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (latest.current !== saved.current) void api.put(`/api/projects/${id}/notes`, { notes: latest.current }).catch(() => {}); }, [id]);
  return (
    <Section title="Notes" end={<><span className="small muted" role="status">{state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving' : 'Not saved. Retrying on your next edit.'}</span>
      <Segmented label="Notes mode" value={mode} onChange={setMode} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} /></>}>
      <Group pad>
        {text === null ? null : mode === 'edit'
          ? <TextArea className="pj-notes" rows={18} value={text} onChange={(e) => setText(e.target.value)} placeholder="Notes in Markdown: decisions, links, what you learned." aria-label="Project notes" />
          : text.trim() ? <div className="md selectable"><ReactMarkdown>{text}</ReactMarkdown></div> : <p className="muted">Nothing written yet.</p>}
      </Group>
    </Section>
  );
}
