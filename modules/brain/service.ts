/**
 * brain service: notes, [[links]], #tags, search, the journal, and the narrow view Claude gets.
 *
 * Notes live in SQLite like the rest of Margin, so the daily backup and export already cover them.
 * A note has two texts: `body` is the person's; `auto` (and `auto_wellbeing`) is compiled from the rest
 * of Margin and replaced on every compile. Compiling never touches `body`.
 *
 * Claude never sees private notes, never sees wellbeing lines, and never sees the journal (daily notes)
 * unless "Share check-in, sleep and mood with Claude" is on, because that is where mood gets written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, at, fmtTime, fromISO, type ISODate } from '../../src/core/time';
import { detectCrisis } from '../../src/integrations/claude';
import { titleKey, cleanTitle, links, tags, renameLinks, snippet } from './parse';

export interface BrainSettings { fromMargin: boolean; journalDays: number; importFolder: string }

export interface Row {
  id: string; title: string; title_key: string; area: string; body: string; auto: string; auto_wellbeing: string;
  date: string | null; source: string | null; source_hash: string | null; pinned: number; private: number;
  created_at: string; updated_at: string; compiled_at: string | null; deleted_at: string | null;
}
export interface NoteSummary {
  id: string; title: string; area: string; date: string | null; pinned: boolean; private: boolean;
  /** Compiled from Margin: the title follows its source. */
  generated: boolean; updatedAt: string; snippet?: string;
}
export interface Note extends NoteSummary {
  body: string; auto: string; wellbeing: string; tags: string[]; source: string | null;
  createdAt: string; compiledAt: string | null; deletedAt: string | null;
  backlinks: { id: string; title: string; area: string; snippet: string }[];
  links: { title: string; id: string | null }[];
  /** The person's text reads like crisis language: the note shows 988 and Get help. Nothing is logged or sent. */
  care: boolean;
  /** Journal notes: the neighbouring days that have a note. */
  journal?: { prev: { id: string; date: string } | null; next: { id: string; date: string } | null };
}
/** What compile produces: one note per source, or one journal entry per date. */
export interface GenNote { source: string; title: string; area: string; auto: string; wellbeing?: string; /** Only when first created. */ pinned?: boolean }
export interface DayNote { date: ISODate; auto: string; wellbeing: string }
export interface Generated { prefix: string; notes: GenNote[] }

export const BODY_MAX = 200_000;
export const AREAS = ['Inbox', 'Me', 'Projects', 'People', 'Journal'];
const TRASH_DAYS = 30;
const IMPORT_MAX_FILES = 2000;
const IMPORT_MAX_BYTES = 1_000_000;

export class BrainError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const cleanArea = (a?: string | null) =>
  (a ?? '').normalize('NFC').replace(/[\n\r\t/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim() || 'Inbox';
const isGenerated = (r: Row) => !!r.source?.startsWith('margin:');
const likeTerm = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const summary = (r: Row, snip?: string): NoteSummary => ({
  id: r.id, title: r.title, area: r.area, date: r.date, pinned: !!r.pinned, private: !!r.private,
  generated: isGenerated(r), updatedAt: r.updated_at, ...(snip !== undefined ? { snippet: snip } : {}),
});

export function createBrainService(ctx: Ctx) {
  const db = ctx.db;
  const s = () => ctx.settings.get<BrainSettings>('brain');
  const stamp = () => now().toISO()!;
  const row = (id: string) => db.get<Row>('SELECT * FROM brain_notes WHERE id = ?', id);
  const byKey = (key: string) => db.get<Row>('SELECT * FROM brain_notes WHERE title_key = ? AND deleted_at IS NULL', key);
  const live = (id: string) => {
    const r = row(id);
    if (!r || r.deleted_at) throw new BrainError('That note doesn’t exist, or it was deleted.', 404);
    return r;
  };

  /** Links and tags come from both texts, so a compiled project note links to its people. */
  function index(id: string, body: string, auto: string) {
    const text = `${body}\n${auto}`;
    db.run('DELETE FROM brain_links WHERE from_id = ?', id);
    for (const l of links(text)) db.run('INSERT OR IGNORE INTO brain_links (from_id, to_key, to_title) VALUES (?, ?, ?)', id, titleKey(l), l);
    db.run('DELETE FROM brain_tags WHERE note_id = ?', id);
    for (const t of tags(text)) db.run('INSERT OR IGNORE INTO brain_tags (note_id, tag) VALUES (?, ?)', id, t);
  }

  /** Titles are unique among live notes (that is what makes [[links]] unambiguous): “Untitled 2”. */
  function freeTitle(title: string, exceptId?: string): string {
    const base = cleanTitle(title);
    for (let n = 1; ; n++) {
      const t = n === 1 ? base : `${base} ${n}`;
      const r = byKey(titleKey(t));
      if (!r || r.id === exceptId) return t;
    }
  }

  function insert(n: { title: string; area: string; body?: string; auto?: string; wellbeing?: string; date?: string | null; source?: string | null; sourceHash?: string | null; pinned?: boolean; private?: boolean; at?: string; compiled?: boolean }): string {
    const id = uid();
    const t = n.at ?? stamp();
    const title = freeTitle(n.title);
    db.run(`INSERT INTO brain_notes (id, title, title_key, area, body, auto, auto_wellbeing, date, source, source_hash, pinned, private, created_at, updated_at, compiled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, title, titleKey(title), cleanArea(n.area), n.body ?? '', n.auto ?? '', n.wellbeing ?? '', n.date ?? null, n.source ?? null, n.sourceHash ?? null,
    !!n.pinned, !!n.private, t, t, n.compiled ? stamp() : null);
    index(id, n.body ?? '', n.auto ?? '');
    return id;
  }

  /** Rename and rewrite every [[link]] to the old title in the person's text (the auto text is rebuilt on compile). */
  function rename(r: Row, to: string): string {
    const title = freeTitle(to, r.id);
    if (title === r.title) return title;
    db.tx(() => {
      db.run('UPDATE brain_notes SET title = ?, title_key = ? WHERE id = ?', title, titleKey(title), r.id);
      const refs = db.all<Row>('SELECT n.* FROM brain_links l JOIN brain_notes n ON n.id = l.from_id WHERE l.to_key = ?', r.title_key);
      for (const ref of refs) {
        const body = renameLinks(ref.body, r.title, title);
        if (body === ref.body) continue;
        db.run('UPDATE brain_notes SET body = ? WHERE id = ?', body, ref.id);
        index(ref.id, body, ref.auto);
      }
    });
    ctx.bus.emit('brain.note_renamed', { id: r.id });
    return title;
  }

  function backlinks(r: Row, opts: { visible?: (x: Row) => boolean } = {}) {
    return db.all<Row>(`SELECT n.* FROM brain_links l JOIN brain_notes n ON n.id = l.from_id
        WHERE l.to_key = ? AND n.id != ? AND n.deleted_at IS NULL ORDER BY n.updated_at DESC LIMIT 50`, r.title_key, r.id)
      .filter((x) => !opts.visible || opts.visible(x))
      .map((x) => ({ id: x.id, title: x.title, area: x.area, snippet: snippet(`${x.body}\n${x.auto}`, [`[[${r.title}`, r.title], 140) }));
  }
  function outgoing(r: Row) {
    return db.all<{ to_key: string; to_title: string }>('SELECT to_key, to_title FROM brain_links WHERE from_id = ? ORDER BY to_title', r.id)
      .map((l) => { const t = byKey(l.to_key); return { title: t?.title ?? l.to_title, id: t?.id ?? null }; });
  }
  const tagsOf = (id: string) => db.all<{ tag: string }>('SELECT tag FROM brain_tags WHERE note_id = ? ORDER BY tag', id).map((x) => x.tag);

  function full(r: Row): Note {
    return {
      ...summary(r), body: r.body, auto: r.auto, wellbeing: r.auto_wellbeing, tags: tagsOf(r.id), source: r.source,
      createdAt: r.created_at, compiledAt: r.compiled_at, deletedAt: r.deleted_at, backlinks: backlinks(r), links: outgoing(r),
      care: detectCrisis(r.body),
      ...(r.date ? { journal: {
        prev: db.get<{ id: string; date: string }>('SELECT id, date FROM brain_notes WHERE date < ? AND deleted_at IS NULL ORDER BY date DESC LIMIT 1', r.date) ?? null,
        next: db.get<{ id: string; date: string }>('SELECT id, date FROM brain_notes WHERE date > ? AND deleted_at IS NULL ORDER BY date LIMIT 1', r.date) ?? null,
      } } : {}),
    };
  }

  // ---------------------------------------------------------------- search
  const terms = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map((t) => t.slice(0, 60));
  /** ponytail: LIKE scan ranked in JS. Fine to ~10k notes; move to FTS5 (and exclude its shadow tables from export) past that. */
  function searchRows(q: string, opts: { claude?: boolean; limit?: number } = {}): { r: Row; score: number; terms: string[] }[] {
    const ts = terms(q);
    if (!ts.length) return [];
    const cols = opts.claude ? ['title', 'body', 'auto'] : ['title', 'body', 'auto', 'auto_wellbeing'];
    const where = ts.map(() => `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND ');
    const rows = db.all<Row>(`SELECT * FROM brain_notes WHERE deleted_at IS NULL${opts.claude ? claudeWhere() : ''} AND ${where} LIMIT 500`,
      ...ts.flatMap((t) => cols.map(() => likeTerm(t))));
    const key = titleKey(q);
    return rows
      .map((r) => {
        const title = r.title.toLowerCase(), body = r.body.toLowerCase(), auto = r.auto.toLowerCase();
        const score = (r.title_key === key ? 20 : 0) + (r.pinned ? 1 : 0)
          + ts.reduce((n, t) => n + (title.includes(t) ? (r.title_key.startsWith(t) ? 8 : 5) : 0) + (body.includes(t) ? 2 : 0) + (auto.includes(t) ? 1 : 0), 0);
        return { r, score, terms: ts };
      })
      .sort((a, b) => b.score - a.score || b.r.updated_at.localeCompare(a.r.updated_at))
      .slice(0, opts.limit ?? 50);
  }

  // ---------------------------------------------------------------- what Claude may read
  const share = () => !!ctx.settings.get<{ shareWellbeing?: boolean }>('ai').shareWellbeing;
  const claudeWhere = () => ` AND private = 0${share() ? '' : ' AND date IS NULL'}`;
  const visibleToClaude = (r: Row) => !r.private && !r.deleted_at && (share() || !r.date);

  let compileTimer: NodeJS.Timeout | null = null;

  const svc = {
    settings: s,

    list(f: { area?: string; tag?: string; q?: string; pinned?: boolean; limit?: number; offset?: number } = {}): { notes: NoteSummary[]; total: number } {
      const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
      const offset = Math.max(f.offset ?? 0, 0);
      if (f.q?.trim()) {
        const hits = searchRows(f.q, { limit: 500 })
          .filter((h) => (!f.area || h.r.area === f.area) && (!f.pinned || h.r.pinned) && (!f.tag || tagsOf(h.r.id).includes(f.tag.toLowerCase())));
        return { notes: hits.slice(offset, offset + limit).map((h) => summary(h.r, snippet(`${h.r.body}\n${h.r.auto}\n${h.r.auto_wellbeing}`, h.terms))), total: hits.length };
      }
      const where = ['deleted_at IS NULL'];
      const params: unknown[] = [];
      if (f.area) { where.push('area = ?'); params.push(f.area); }
      if (f.pinned) where.push('pinned = 1');
      if (f.tag) { where.push('id IN (SELECT note_id FROM brain_tags WHERE tag = ?)'); params.push(f.tag.toLowerCase()); }
      const w = where.join(' AND ');
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM brain_notes WHERE ${w}`, ...params)!.n;
      const rows = db.all<Row>(`SELECT id, title, title_key, area, substr(body, 1, 400) body, substr(auto, 1, 400) auto, '' auto_wellbeing, date, source, pinned, private, created_at, updated_at
        FROM brain_notes WHERE ${w} ORDER BY pinned DESC, COALESCE(date, substr(updated_at, 1, 10)) DESC, updated_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
      return { notes: rows.map((r) => summary(r, snippet(r.body || r.auto, [], 120))), total };
    },

    get(id: string): Note | null { const r = row(id); return r ? full(r) : null; },
    byTitle(title: string): Note | null { const r = byKey(titleKey(title)); return r ? full(r) : null; },

    /** Every live title, for [[ autocomplete, link resolution and the palette. ponytail: whole list, page it past ~10k notes. */
    titles(): { id: string; title: string; area: string }[] {
      return db.all<{ id: string; title: string; area: string }>('SELECT id, title, area FROM brain_notes WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE');
    },
    areas(): { area: string; count: number }[] {
      const rows = db.all<{ area: string; count: number }>('SELECT area, COUNT(*) count FROM brain_notes WHERE deleted_at IS NULL GROUP BY area');
      const rank = (a: string) => { const i = AREAS.indexOf(a); return i < 0 ? AREAS.length : i; };
      return rows.sort((a, b) => rank(a.area) - rank(b.area) || a.area.localeCompare(b.area));
    },
    tags(): { tag: string; count: number }[] {
      return db.all<{ tag: string; count: number }>(`SELECT t.tag, COUNT(*) count FROM brain_tags t JOIN brain_notes n ON n.id = t.note_id
        WHERE n.deleted_at IS NULL GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT 200`);
    },

    create(input: { title?: string; body?: string; area?: string; pinned?: boolean; private?: boolean } = {}): Note {
      const body = input.body ?? '';
      if (body.length > BODY_MAX) throw new BrainError('That note is too long. Split it into a few notes.');
      const id = db.tx(() => insert({ title: input.title ?? 'Untitled', area: input.area ?? 'Inbox', body, pinned: input.pinned, private: input.private }));
      ctx.bus.emit('brain.note_created', { id });
      return full(row(id)!);
    },

    /** Body edits save quietly (no event) so typing doesn't refetch every screen; structural changes emit. Pinning and privacy aren't edits. */
    update(id: string, patch: { title?: string; body?: string; area?: string; pinned?: boolean; private?: boolean }): Note {
      let r = live(id);
      if (patch.body !== undefined && patch.body.length > BODY_MAX) throw new BrainError('That note is too long. Split it into a few notes.');
      let renamed = false;
      if (patch.title !== undefined && cleanTitle(patch.title) !== r.title) {
        if (isGenerated(r) || r.date) throw new BrainError(r.date ? 'Journal notes are named by their date.' : 'This note is named after its source in Margin. Rename it there.', 409);
        renamed = rename(r, patch.title) !== r.title;
        r = row(id)!;
      }
      const body = patch.body ?? r.body;
      const area = patch.area !== undefined ? cleanArea(patch.area) : r.area;
      const edited = renamed || body !== r.body || area !== r.area;
      db.tx(() => {
        db.run('UPDATE brain_notes SET body = ?, area = ?, pinned = ?, private = ?, updated_at = ? WHERE id = ?',
          body, area, patch.pinned ?? !!r.pinned, patch.private ?? !!r.private, edited ? stamp() : r.updated_at, id);
        if (body !== r.body) index(id, body, r.auto);
      });
      if (patch.area !== undefined || patch.pinned !== undefined || patch.private !== undefined) ctx.bus.emit('brain.note_changed', { id });
      return full(row(id)!);
    },

    append(id: string, text: string): Note {
      const r = live(id);
      const add = text.trim();
      if (!add) return full(r);
      return svc.update(id, { body: r.body.trim() ? `${r.body.replace(/\s+$/, '')}\n\n${add}` : add });
    },

    remove(id: string) {
      live(id);
      db.run('UPDATE brain_notes SET deleted_at = ?, pinned = 0 WHERE id = ?', stamp(), id);
      ctx.bus.emit('brain.note_deleted', { id });
    },
    restore(id: string): Note {
      const r = row(id);
      if (!r || !r.deleted_at) throw new BrainError('That note isn’t in Recently Deleted.', 404);
      const title = freeTitle(r.title, r.id);
      db.run('UPDATE brain_notes SET deleted_at = NULL, title = ?, title_key = ? WHERE id = ?', title, titleKey(title), id);
      ctx.bus.emit('brain.note_restored', { id });
      return full(row(id)!);
    },
    trash(): NoteSummary[] {
      const cutoff = now().minus({ days: TRASH_DAYS }).toISO()!;
      return db.all<Row>('SELECT * FROM brain_notes WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC LIMIT 200', cutoff).map((r) => summary(r));
    },
    /** Hand-written notes go after 30 days. Compiled and journal notes stay as hidden tombstones so compiling never brings back what you deleted. */
    purge(): number {
      const cutoff = now().minus({ days: TRASH_DAYS }).toISO()!;
      return Number(db.run('DELETE FROM brain_notes WHERE deleted_at IS NOT NULL AND deleted_at < ? AND source IS NULL AND date IS NULL', cutoff).changes);
    },

    /** Quick capture: the first line is the title, the rest the body. Lands in the Inbox. */
    capture(text: string): Note {
      const t = text.replace(/\r\n?/g, '\n').trim();
      if (!t) throw new BrainError('Type something to save.');
      const [first, ...rest] = t.split('\n');
      const long = first.length > 80;
      return svc.create({ title: long ? `${first.slice(0, 77).trimEnd()}…` : first, body: long ? t : rest.join('\n').trim(), area: 'Inbox' });
    },

    /** The journal note for a date, created on first open (and brought back if it was deleted). */
    daily(date: ISODate): Note {
      const r = db.get<Row>('SELECT * FROM brain_notes WHERE date = ?', date);
      if (r) return r.deleted_at ? svc.restore(r.id) : full(r);
      const same = byKey(titleKey(date));
      if (same && !same.source && !same.date) {
        db.run('UPDATE brain_notes SET date = ?, area = ? WHERE id = ?', date, 'Journal', same.id);
        return full(row(same.id)!);
      }
      const id = db.tx(() => insert({ title: date, area: 'Journal', date }));
      ctx.bus.emit('brain.note_created', { id });
      return full(row(id)!);
    },

    search(q: string, limit = 30): NoteSummary[] {
      return searchRows(q, { limit }).map((h) => summary(h.r, snippet(`${h.r.body}\n${h.r.auto}\n${h.r.auto_wellbeing}`, h.terms)));
    },

    // ---------------------------------------------------------------- compile (see compile.ts for what is compiled)
    /** Upsert compiled notes. Notes of a source family that disappeared keep the person's text and lose the compiled part. */
    applyCompiled(gens: Generated[], days: DayNote[]): { created: number; updated: number; removed: number } {
      let created = 0, updated = 0, removed = 0;
      const t = stamp();
      const setAuto = (r: Row, auto: string, wellbeing: string) => {
        if (r.auto === auto && r.auto_wellbeing === wellbeing) return false;
        db.run('UPDATE brain_notes SET auto = ?, auto_wellbeing = ?, compiled_at = ? WHERE id = ?', auto, wellbeing, t, r.id);
        if (r.auto !== auto) index(r.id, r.body, auto);
        return true;
      };
      db.tx(() => {
        for (const g of gens) {
          const seen = new Set<string>();
          for (const n of g.notes) {
            seen.add(n.source);
            let r = db.get<Row>('SELECT * FROM brain_notes WHERE source = ?', n.source);
            if (r?.deleted_at) continue; // deleted by the person: stays deleted
            if (r) {
              if (cleanTitle(n.title) !== r.title && rename(r, n.title) !== r.title) { r = row(r.id)!; updated++; }
              if (setAuto(r, n.auto, n.wellbeing ?? '')) updated++;
              continue;
            }
            const same = byKey(titleKey(cleanTitle(n.title)));
            if (same && !same.source && !same.date) { // a hand-written note with that name adopts the source
              db.run('UPDATE brain_notes SET source = ? WHERE id = ?', n.source, same.id);
              setAuto({ ...same, source: n.source }, n.auto, n.wellbeing ?? '');
              updated++;
            } else {
              insert({ title: n.title, area: n.area, auto: n.auto, wellbeing: n.wellbeing, source: n.source, pinned: n.pinned, compiled: true });
              created++;
            }
          }
          for (const r of db.all<Row>('SELECT * FROM brain_notes WHERE substr(source, 1, ?) = ? AND deleted_at IS NULL', g.prefix.length, g.prefix)) {
            if (seen.has(r.source!)) continue;
            if (r.body.trim()) {
              db.run("UPDATE brain_notes SET source = NULL, auto = '', auto_wellbeing = '', compiled_at = ? WHERE id = ?", t, r.id);
              index(r.id, r.body, '');
            } else db.run('DELETE FROM brain_notes WHERE id = ?', r.id);
            removed++;
          }
        }
        for (const d of days) {
          const r = db.get<Row>('SELECT * FROM brain_notes WHERE date = ?', d.date);
          if (r) { if (!r.deleted_at && setAuto(r, d.auto, d.wellbeing)) updated++; continue; }
          if (!d.auto && !d.wellbeing) continue;
          const same = byKey(titleKey(d.date));
          if (same && !same.source && !same.date) {
            db.run("UPDATE brain_notes SET date = ?, area = 'Journal' WHERE id = ?", d.date, same.id);
            setAuto({ ...same, date: d.date }, d.auto, d.wellbeing);
            updated++;
          } else {
            const past = d.date < now().toISODate()!;
            insert({ title: d.date, area: 'Journal', date: d.date, auto: d.auto, wellbeing: d.wellbeing, compiled: true, at: past ? at(d.date, '21:00').toISO()! : undefined });
            created++;
          }
        }
      });
      if (created || updated || removed) ctx.bus.emit('brain.compiled', { created, updated, removed });
      return { created, updated, removed };
    },
    lastCompiledAt: () => db.get<{ t: string | null }>('SELECT MAX(compiled_at) t FROM brain_notes')?.t ?? null,
    /** Debounced compile after the rest of Margin changes. */
    compileSoon(run: () => void, ms = 3000) {
      if (compileTimer) return;
      compileTimer = setTimeout(() => { compileTimer = null; try { run(); } catch (e) { ctx.log.error('brain compile failed', e); } }, ms);
      compileTimer.unref?.();
    },

    // ---------------------------------------------------------------- Today
    /** Notes whose title shows up in today's schedule or tasks, plus the notes of projects on today's calendar. */
    forToday(date: ISODate): { id: string; title: string; area: string; reason: string }[] {
      const texts: { text: string; reason: string; projectId?: string | null; todoistProjectId?: string }[] = [];
      const day = ctx.maybe<any>('day');
      try {
        for (const it of day?.timeline(date) ?? []) {
          if (it.source === 'fixed') continue;
          const when = it.allDay ? 'today' : `at ${fmtTime(fromISO(it.start))}`;
          texts.push({ text: it.title, reason: `${it.title} ${when}`, projectId: it.projectId });
        }
      } catch (e: any) { ctx.log.warn('brain: timeline unavailable', e?.message); }
      try {
        const td = ctx.maybe<any>('todoist');
        const seen = new Set<string>();
        for (const t of [...(ctx.maybe<any>('plan')?.mustDos(date) ?? []), ...(td?.tasks({ dueOn: date }) ?? [])]) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          texts.push({ text: t.content, reason: t.content, projectId: ctx.maybe<any>('projects')?.projectForTask(t)?.id, todoistProjectId: t.projectId });
        }
      } catch (e: any) { ctx.log.warn('brain: tasks unavailable', e?.message); }
      if (!texts.length) return [];

      const out = new Map<string, { id: string; title: string; area: string; reason: string }>();
      const add = (r: Row | undefined, reason: string) => { if (r && !r.deleted_at && !out.has(r.id)) out.set(r.id, { id: r.id, title: r.title, area: r.area, reason }); };
      for (const x of texts) {
        if (x.projectId) add(db.get<Row>('SELECT * FROM brain_notes WHERE source = ?', `margin:project:${x.projectId}`), x.reason);
        else if (x.todoistProjectId) add(db.get<Row>('SELECT * FROM brain_notes WHERE source = ?', `margin:todoist:${x.todoistProjectId}`), x.reason);
      }
      // Substring first, then a word-boundary check: a regex per title cost seconds at a few thousand notes.
      const hay = texts.map((x) => ({ ...x, lower: x.text.toLowerCase().replace(/\s+/g, ' ') }));
      const candidates = db.all<Row>(`SELECT id, title, title_key, area, deleted_at FROM brain_notes WHERE deleted_at IS NULL AND date IS NULL
        AND (source IS NULL OR substr(source, 1, 5) = 'file:' OR area IN ('People', 'Projects')) AND length(title) >= 3`);
      for (const c of candidates) {
        const hit = hay.find((x) => hasWord(x.lower, c.title_key));
        if (hit) add(c, hit.reason);
        if (out.size >= 8) break;
      }
      return [...out.values()].slice(0, 6);
    },

    // ---------------------------------------------------------------- Claude (in-app tools and MCP)
    claude: {
      visible: visibleToClaude,
      search(q: string, limit = 10) {
        return searchRows(q, { claude: true, limit: Math.min(limit, 25) })
          .map((h) => ({ title: h.r.title, area: h.r.area, updated: h.r.updated_at.slice(0, 10), snippet: snippet(`${h.r.body}\n${h.r.auto}`, h.terms) }));
      },
      list(f: { area?: string; tag?: string; limit?: number } = {}) {
        const where = ['deleted_at IS NULL'];
        const params: unknown[] = [];
        if (f.area) { where.push('area = ?'); params.push(f.area); }
        if (f.tag) { where.push('id IN (SELECT note_id FROM brain_tags WHERE tag = ?)'); params.push(f.tag.toLowerCase().replace(/^#/, '')); }
        return db.all<Row>(`SELECT * FROM brain_notes WHERE ${where.join(' AND ')}${claudeWhere()} ORDER BY pinned DESC, updated_at DESC LIMIT ?`, ...params, Math.min(f.limit ?? 50, 200))
          .map((r) => ({ title: r.title, area: r.area, pinned: !!r.pinned, updated: r.updated_at.slice(0, 10) }));
      },
      read(title: string) {
        const r = byKey(titleKey(title));
        if (!r) {
          const near = searchRows(title, { claude: true, limit: 5 }).map((h) => h.r.title);
          return { error: `No note is called “${title}”.${near.length ? ` Close matches: ${near.join(', ')}.` : ''}` };
        }
        if (!visibleToClaude(r)) return { error: r.date ? `“${r.title}” is a journal note. Journal notes are shared with Claude only when check-in sharing is on in Settings → Claude.` : `“${r.title}” is private.` };
        return {
          title: r.title, area: r.area, tags: tagsOf(r.id), updated: r.updated_at.slice(0, 10),
          body: r.body, fromMargin: r.auto, ...(share() && r.auto_wellbeing ? { wellbeing: r.auto_wellbeing } : {}),
          links: outgoing(r).map((l) => l.title), linkedFrom: backlinks(r, { visible: visibleToClaude }).map((b) => b.title),
        };
      },
      context() {
        const visible = db.get<{ n: number }>(`SELECT COUNT(*) n FROM brain_notes WHERE deleted_at IS NULL${claudeWhere()}`)!.n;
        if (!visible) return { notes: 0 };
        return {
          notes: visible,
          areas: db.all<{ area: string; n: number }>(`SELECT area, COUNT(*) n FROM brain_notes WHERE deleted_at IS NULL${claudeWhere()} GROUP BY area ORDER BY n DESC LIMIT 12`).map((a) => `${a.area} (${a.n})`),
          pinned: db.all<{ title: string }>(`SELECT title FROM brain_notes WHERE deleted_at IS NULL AND pinned = 1${claudeWhere()} ORDER BY updated_at DESC LIMIT 8`).map((x) => x.title),
          howTo: 'Use search_notes and read_note for anything about the person’s life, people, projects and plans; propose_note to save something.',
        };
      },
    },

    // ---------------------------------------------------------------- Markdown folder import (an Obsidian vault, notes from another app)
    importFolder(dir: string): { files: number; created: number; updated: number; skipped: number } {
      const raw = dir.trim();
      if (!raw) throw new BrainError('Choose a folder to import first.');
      const root = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
      let st: fs.Stats;
      try { st = fs.statSync(root); } catch { throw new BrainError(`Couldn’t find a folder at ${root}.`, 404); }
      if (!st.isDirectory()) throw new BrainError(`${root} is a file. Choose the folder that holds your notes.`);
      const files: string[] = [];
      const walk = (d: string, depth: number) => {
        if (depth > 8 || files.length >= IMPORT_MAX_FILES) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (files.length >= IMPORT_MAX_FILES) return;
          if (e.name.startsWith('.') || e.name === 'node_modules') continue; // .obsidian, .git, .trash
          const p = path.join(d, e.name);
          // Dirent types don't follow symlinks, so a link can't lead the walk out of the folder.
          if (e.isDirectory()) walk(p, depth + 1);
          else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) files.push(p);
        }
      };
      walk(root, 0);
      let created = 0, updated = 0, skipped = 0;
      db.tx(() => {
        for (const file of files) {
          let text: string;
          try {
            if (fs.statSync(file).size > IMPORT_MAX_BYTES) { skipped++; continue; }
            text = fromMarkdownFile(fs.readFileSync(file, 'utf8'));
          } catch { skipped++; continue; }
          const source = `file:${file}`;
          const hash = sha(text);
          const r = db.get<Row>('SELECT * FROM brain_notes WHERE source = ?', source);
          if (!r) {
            const rel = path.relative(root, file).split(path.sep);
            insert({ title: path.basename(file).replace(/\.(md|markdown|txt)$/i, ''), area: rel.length > 1 ? rel[0] : 'Imported', body: text, source, sourceHash: hash });
            created++;
          } else if (!r.deleted_at && r.source_hash !== hash && sha(r.body) === r.source_hash) {
            // Changed on disk and untouched here: take the new text. Edited in Margin: Margin's copy wins.
            db.run('UPDATE brain_notes SET body = ?, source_hash = ?, updated_at = ? WHERE id = ?', text, hash, stamp(), r.id);
            index(r.id, text, r.auto);
            updated++;
          } else skipped++;
        }
      });
      ctx.settings.set('brain', { importFolder: raw });
      if (created || updated) ctx.bus.emit('brain.imported', { created, updated });
      return { files: files.length, created, updated, skipped };
    },
  };
  return svc;
}
export type BrainService = ReturnType<typeof createBrainService>;

const WORD = /[\p{L}\p{N}]/u;
/** `needle` appears in `hay` as whole words (“Lim Lab” in “lim lab meeting”, not “Elect” in “election”). */
export function hasWord(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1], after = hay[i + needle.length];
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) return true;
  }
  return false;
}

/** Drop a leading YAML block (Obsidian frontmatter) and keep its tags as #tags. */
export function fromMarkdownFile(text: string): string {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return t;
  const body = t.slice(m[0].length);
  const yaml = m[1].split('\n');
  const i = yaml.findIndex((l) => /^tags:/.test(l));
  const found: string[] = [];
  if (i >= 0) {
    const inline = yaml[i].slice(5).trim();
    if (inline) found.push(...inline.replace(/[[\]]/g, '').split(/[,\s]+/));
    else for (let k = i + 1; k < yaml.length && /^\s*-\s+/.test(yaml[k]); k++) found.push(yaml[k].replace(/^\s*-\s+/, ''));
  }
  const tagLine = found.map((x) => x.trim().replace(/^#/, '')).filter((x) => /^[\p{L}\p{N}_/-]+$/u.test(x)).map((x) => `#${x}`).join(' ');
  return tagLine ? `${body.replace(/\s+$/, '')}\n\n${tagLine}\n` : body;
}
