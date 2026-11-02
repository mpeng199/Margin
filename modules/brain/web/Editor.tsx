import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface TitleRef { id: string; title: string; area: string }

/** Pixel position of the caret inside a textarea, measured with a hidden mirror element. */
function caret(el: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(el);
  const div = document.createElement('div');
  for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
    'wordSpacing', 'textIndent', 'tabSize'] as const) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = el.value.slice(pos) || '.';
  div.appendChild(mark);
  document.body.appendChild(div);
  const out = { top: mark.offsetTop + (parseFloat(cs.lineHeight) || 20), left: Math.min(mark.offsetLeft, el.clientWidth - 260) };
  div.remove();
  return out;
}

/**
 * Plain Markdown in an auto-growing textarea. Typing [[ opens a list of note titles;
 * ↑↓ choose, Return or Tab inserts the link, Esc closes the list.
 */
export function Editor({ value, onChange, titles, onDone, autoFocus }: {
  value: string; onChange: (v: string) => void; titles: TitleRef[]; onDone: () => void; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ query: string; start: number; top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  useLayoutEffect(() => { // on mount only: a later prop change must not steal focus from another field
    if (!autoFocus || !ref.current) return;
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const look = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart;
    const m = /\[\[([^[\]|#\n]*)$/.exec(el.value.slice(0, pos));
    if (!m || el.selectionEnd !== pos) { setMenu(null); return; }
    setMenu({ query: m[1], start: pos - m[1].length, ...caret(el, pos) });
    setActive(0);
  };

  const q = menu?.query.trim().toLowerCase() ?? '';
  const matches = menu ? titles.filter((t) => t.title.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q))).slice(0, 8) : [];
  const exact = matches.some((t) => t.title.toLowerCase() === q);
  const options = [...matches.map((t) => ({ title: t.title, hint: t.area })), ...(q && !exact ? [{ title: menu!.query.trim(), hint: 'New note' }] : [])];

  const pick = (title: string) => {
    const el = ref.current;
    if (!el || !menu) return;
    const end = el.selectionStart;
    const after = el.value.slice(end);
    const next = `${el.value.slice(0, menu.start)}${title}]]${after.startsWith(']]') ? after.slice(2) : after}`;
    const pos = menu.start + title.length + 2;
    onChange(next);
    setMenu(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[Math.min(active, options.length - 1)].title); return; }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (menu) setMenu(null); else onDone();
    }
  };

  return (
    <div className="brain-editor">
      <textarea ref={ref} className="brain-textarea" value={value} spellCheck aria-label="Note text, in Markdown"
        aria-autocomplete="list" aria-expanded={!!menu && options.length > 0} aria-controls="brain-suggest"
        aria-activedescendant={menu && options.length ? `brain-suggest-${Math.min(active, options.length - 1)}` : undefined}
        placeholder="Write in Markdown. [[ links a note, # adds a tag."
        onChange={(e) => { onChange(e.target.value); look(e.target); }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => { if (e.key.startsWith('Arrow') && !menu) look(e.currentTarget); }}
        onClick={(e) => look(e.currentTarget)}
        onBlur={() => setTimeout(() => setMenu(null), 120)} />
      {menu && options.length > 0 && (
        <div id="brain-suggest" className="brain-suggest" role="listbox" aria-label="Link to a note" style={{ top: menu.top, left: Math.max(0, menu.left) }}>
          {options.map((o, i) => (
            <div key={`${o.title}-${o.hint}`} id={`brain-suggest-${i}`} role="option" aria-selected={i === active} className="brain-suggest-item"
              onMouseDown={(e) => { e.preventDefault(); pick(o.title); }} onMouseEnter={() => setActive(i)}>
              <span className="ellipsis">{o.title}</span><span className="brain-suggest-hint">{o.hint}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
