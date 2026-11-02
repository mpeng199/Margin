import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { useLocation } from 'wouter';
import { api } from '@web/lib/api';
import { queryClient } from '@web/lib/query';
import { toast } from '@web/ui';
import { cleanTag, titleKey } from '../parse';
import { setFilter } from './store';

const RE = /\[\[([^[\]|#\n]+)(?:#([^[\]|\n]*))?(?:\|([^[\]\n]*))?\]\]|(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

/** Text → text + link nodes for [[wikilinks]] (wiki:) and #tags (tag:). */
function split(value: string): any[] {
  const out: any[] = [];
  let last = 0;
  const text = (to: number) => { if (to > last) out.push({ type: 'text', value: value.slice(last, to) }); };
  for (const m of value.matchAll(RE)) {
    const i = m.index!;
    if (m[1] !== undefined) {
      text(i);
      out.push({ type: 'link', url: `wiki:${encodeURIComponent(m[1].trim())}`, children: [{ type: 'text', value: (m[3] ?? m[1]).trim() || m[1].trim() }] });
    } else {
      const tag = cleanTag(m[5]);
      if (!tag) continue;
      text(i + m[4].length);
      out.push({ type: 'link', url: `tag:${encodeURIComponent(tag)}`, children: [{ type: 'text', value: `#${m[5]}` }] });
    }
    last = i + m[0].length;
  }
  text(value.length);
  return out;
}

/** remark plugin: walks text outside code and links. Adjacent text nodes are merged first (the parser splits on brackets). */
function remarkBrain() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!Array.isArray(node.children) || node.type === 'link' || node.type === 'linkReference') return;
      const merged: any[] = [];
      for (const c of node.children) {
        const prev = merged[merged.length - 1];
        if (c.type === 'text' && prev?.type === 'text') prev.value += c.value;
        else merged.push(c.type === 'text' ? { type: 'text', value: c.value } : c);
      }
      node.children = merged.flatMap((c) => (c.type === 'text' ? split(c.value) : (walk(c), [c])));
    };
    walk(tree);
  };
}

const urlTransform = (url: string, key: string) => (key === 'href' && /^(wiki|tag):/.test(url) ? url : defaultUrlTransform(url));

/** Open a note by title; a link to a note that doesn't exist yet creates it (as in Obsidian). */
export async function openTitle(title: string, navigate: (to: string) => void) {
  try {
    const { id } = await api.get<{ id: string | null }>(`/api/brain/resolve?title=${encodeURIComponent(title)}`);
    if (id) return navigate(`/brain/${id}`);
    const n = await api.post<{ id: string }>('/api/brain/notes', { title });
    void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('/api/brain') });
    navigate(`/brain/${n.id}?edit=1`);
  } catch (e: any) { toast(e.message); }
}

export function Markdown({ text, known }: { text: string; known?: Set<string> }) {
  const [, navigate] = useLocation();
  const components = useMemo(() => ({
    a: ({ href = '', children }: { href?: string; children?: React.ReactNode }) => {
      if (href.startsWith('wiki:')) {
        const title = decodeURIComponent(href.slice(5));
        const missing = known && !known.has(titleKey(title));
        return (
          <a href={`/brain?open=${encodeURIComponent(title)}`} className={`brain-wikilink${missing ? ' missing' : ''}`} title={missing ? `Create “${title}”` : title}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openTitle(title, navigate); }}>{children}</a>
        );
      }
      if (href.startsWith('tag:')) {
        const tag = decodeURIComponent(href.slice(4));
        return <a href={`/brain?tag=${encodeURIComponent(tag)}`} className="brain-tag" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFilter({ tag, area: null, q: '', trash: false }); navigate('/brain'); }}>{children}</a>;
      }
      // Web links open in the browser; mailto goes through the shell's navigation guard to Mail.
      return <a href={href} {...(/^https?:/i.test(href) ? { target: '_blank', rel: 'noreferrer noopener' } : {})} onClick={(e) => e.stopPropagation()}>{children}</a>;
    },
    // Remote images would tell their server when you read the note: show a link instead of loading it.
    img: ({ src, alt }: { src?: string; alt?: string }) => (src ? <a href={String(src)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{alt || 'Image'}</a> : null),
  }), [known, navigate]);
  return (
    <div className="md selectable brain-md">
      <ReactMarkdown remarkPlugins={[remarkBrain]} urlTransform={urlTransform} skipHtml components={components as any}>{text}</ReactMarkdown>
    </div>
  );
}
