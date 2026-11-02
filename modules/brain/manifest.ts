/**
 * brain — a second brain: Markdown notes with [[links]], #tags and backlinks, organized in a few areas,
 * plus notes Margin compiles about your routine, recovery plan, projects, people, habits and days.
 * Claude can search and read it (never private notes, never the journal or wellbeing unless sharing is on)
 * and propose notes, which wait in Review changes like every other Claude write.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { today } from '../../src/core/time';
import { stripWellbeing } from '../../src/integrations/claude';
import { BODY_MAX, cleanArea, createBrainService, type BrainService } from './service';
import { compile } from './compile';
import { cleanTitle } from './parse';

const settings = z.object({
  compile: z.boolean().default(true).describe('Keep notes compiled from the rest of Margin: your routine, recovery plan, projects, people, habits, rituals and a daily journal. What you write in those notes is never changed.'),
  journalDays: z.number().int().min(0).max(365).default(60).describe('How many days back the journal is compiled. 0 turns the journal off.'),
  importFolder: z.string().max(1000).default('').describe('A folder of Markdown notes to import, such as an Obsidian vault. Import it from the Brain toolbar. Notes you edit in Margin are never overwritten by a later import.'),
});

const b = (ctx: Ctx) => ctx.service<BrainService>('brain');
const planningDate = (ctx: Ctx) => ctx.maybe<{ planningDate(): string }>('day')?.planningDate() ?? today();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const noteInput = z.object({
  title: z.string().max(500).optional(), body: z.string().max(BODY_MAX).optional(), area: z.string().max(200).optional(),
  pinned: z.boolean().optional(), private: z.boolean().optional(),
});
const proposeInput = z.object({ title: z.string().min(1).max(120), text: z.string().min(1).max(20_000), area: z.string().max(40).optional() });
const createPayload = z.object({ title: z.string().min(1).max(500), area: z.string().max(200).optional(), body: z.string().max(BODY_MAX) });
const appendPayload = z.object({ title: z.string().min(1).max(500), text: z.string().min(1).max(BODY_MAX) });

/** A new note, or text added to an existing one of the same title. Private and journal notes are off limits. */
function proposeNote(ctx: Ctx, input: z.infer<typeof proposeInput>) {
  const title = cleanTitle(input.title);
  const existing = b(ctx).byTitle(title);
  if (existing) {
    if (existing.private || (existing.date && !ctx.settings.get<{ shareWellbeing?: boolean }>('ai').shareWellbeing)) {
      throw Object.assign(new Error(`“${existing.title}” can’t be changed from here. Use a different title.`), { status: 409 });
    }
    return [{ kind: 'brain.note.append', title: `Add to “${existing.title}”`, payload: { title: existing.title, text: input.text.trim() } }];
  }
  return [{ kind: 'brain.note.create', title: `New note “${title}”`, payload: { title, area: cleanArea(input.area ?? 'Inbox'), body: input.text.trim() } }];
}

const COMPILE_ON = [
  'todoist.synced', 'google.synced', 'settings.changed', 'shutdown.completed', 'checkin.submitted', 'checkin.baseline_saved', 'review.completed',
  'project.created', 'project.updated', 'project.status_changed', 'project.notes_changed', 'project.timeline_changed',
  'delegation.function_changed', 'delegation.waiting_changed', 'delegation.checkin_logged', 'delegation.scripts_changed',
  'habit.logged', 'habit.unlogged', 'habit.created', 'habit.updated', 'habit.graduated', 'habit.archived',
  'focus.completed', 'training.logged', 'rituals.changed', 'offday.leisure_added', 'offday.leisure_removed', 'brain.note_created', 'brain.note_deleted',
];
const compileSoon = (_p: unknown, ctx: Ctx) => { const svc = b(ctx); svc.compileSoon(() => compile(ctx, svc)); };

export default defineModule({
  id: 'brain',
  name: 'Second brain',
  description: 'Notes with [[links]], #tags and backlinks, kept in a few areas, plus notes Margin compiles about your routine, projects, people, habits and days. Claude can search it and suggest notes for your review.',
  defaultEnabled: true,
  settings,
  migrations: [
    `CREATE TABLE brain_notes (
       id TEXT PRIMARY KEY, title TEXT NOT NULL, title_key TEXT NOT NULL, area TEXT NOT NULL DEFAULT 'Inbox',
       body TEXT NOT NULL DEFAULT '', auto TEXT NOT NULL DEFAULT '', auto_wellbeing TEXT NOT NULL DEFAULT '',
       date TEXT, source TEXT UNIQUE, source_hash TEXT, pinned INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL, compiled_at TEXT, deleted_at TEXT);
     CREATE UNIQUE INDEX brain_notes_title ON brain_notes(title_key) WHERE deleted_at IS NULL;
     CREATE UNIQUE INDEX brain_notes_date ON brain_notes(date) WHERE date IS NOT NULL;
     CREATE INDEX brain_notes_area ON brain_notes(area, updated_at);
     CREATE TABLE brain_links (from_id TEXT NOT NULL REFERENCES brain_notes(id) ON DELETE CASCADE, to_key TEXT NOT NULL, to_title TEXT NOT NULL, PRIMARY KEY (from_id, to_key));
     CREATE INDEX brain_links_to ON brain_links(to_key);
     CREATE TABLE brain_tags (note_id TEXT NOT NULL REFERENCES brain_notes(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (note_id, tag));
     CREATE INDEX brain_tags_tag ON brain_tags(tag);`,
  ],
  service: createBrainService,
  emits: ['brain.note_created', 'brain.note_changed', 'brain.note_renamed', 'brain.note_deleted', 'brain.note_restored', 'brain.compiled', 'brain.imported'],
  on: Object.fromEntries(COMPILE_ON.map((e) => [e, compileSoon])),
  jobs: [
    { id: 'compile', every: 15, run: (ctx) => { compile(ctx, b(ctx)); } },
    { id: 'purge', at: () => ['03:40'], run: (ctx) => { b(ctx).purge(); } },
  ],
  nav: [{ id: 'brain', label: 'Brain', icon: 'Brain', path: '/brain', section: 'main', order: 25, shortcut: 'Mod+9' }],
  widgets: [{ id: 'today', slot: 'today.side', order: 25 }],

  init(ctx) {
    ctx.changes.register('brain.note.create', {
      label: 'New note in your second brain', editable: ['title', 'area'],
      apply: (c, p) => { const v = createPayload.parse(p); return { id: b(c).create({ title: v.title, area: v.area, body: v.body }).id }; },
    });
    ctx.changes.register('brain.note.append', {
      label: 'Add to a note in your second brain',
      apply: (c, p) => {
        const v = appendPayload.parse(p);
        const n = b(c).byTitle(v.title);
        if (!n) throw new Error(`There’s no note called “${v.title}” anymore.`);
        return { id: b(c).append(n.id, v.text).id };
      },
    });
  },

  routes(r, ctx) {
    const svc = () => b(ctx);
    const share = () => !!ctx.settings.get<{ shareWellbeing?: boolean }>('ai').shareWellbeing;
    const forClaude = (c: any, v: unknown) => c.json(share() ? v : stripWellbeing(v));

    r.get('/notes', (c) => {
      const q = c.req.query();
      return c.json(svc().list({ area: q.area || undefined, tag: q.tag || undefined, q: q.q || undefined, pinned: q.pinned === '1', limit: num(q.limit), offset: num(q.offset) }));
    });
    r.get('/notes/:id', (c) => { const n = svc().get(c.req.param('id')); return n ? c.json(n) : c.json({ error: 'That note doesn’t exist.' }, 404); });
    r.post('/notes', async (c) => c.json(svc().create(noteInput.parse(await c.req.json()))));
    r.patch('/notes/:id', async (c) => c.json(svc().update(c.req.param('id'), noteInput.parse(await c.req.json()))));
    r.delete('/notes/:id', (c) => { svc().remove(c.req.param('id')); return c.json({ ok: true }); });
    r.post('/notes/:id/restore', (c) => c.json(svc().restore(c.req.param('id'))));
    r.get('/trash', (c) => c.json(svc().trash()));
    r.get('/titles', (c) => c.json(svc().titles()));
    r.get('/areas', (c) => c.json(svc().areas()));
    r.get('/tags', (c) => c.json(svc().tags()));
    r.get('/resolve', (c) => { const n = svc().byTitle(c.req.query('title') ?? ''); return c.json({ id: n?.id ?? null }); });
    r.post('/capture', async (c) => c.json(svc().capture(z.object({ text: z.string().max(BODY_MAX) }).parse(await c.req.json()).text)));
    r.post('/daily', async (c) => {
      const { date } = z.object({ date: iso.optional() }).parse(await c.req.json().catch(() => ({})));
      return c.json(svc().daily(date ?? planningDate(ctx)));
    });
    r.get('/today', (c) => {
      const date = iso.safeParse(c.req.query('date')).data ?? planningDate(ctx);
      return c.json({ date, notes: svc().forToday(date) });
    });
    r.post('/compile', (c) => c.json(compile(ctx, svc())));
    r.get('/status', (c) => c.json({ compiledAt: svc().lastCompiledAt(), compile: svc().settings().compile, importFolder: svc().settings().importFolder }));
    r.post('/import', async (c) => c.json(svc().importFolder(z.object({ folder: z.string().max(1000) }).parse(await c.req.json()).folder)));

    // For the MCP server: the same narrow view the in-app Claude tools get.
    r.get('/claude/search', (c) => forClaude(c, svc().claude.search(c.req.query('q') ?? '', num(c.req.query('limit')))));
    r.get('/claude/notes', (c) => forClaude(c, svc().claude.list({ area: c.req.query('area') || undefined, tag: c.req.query('tag') || undefined, limit: num(c.req.query('limit')) })));
    r.get('/claude/note', (c) => {
      const out = svc().claude.read(c.req.query('title') ?? '');
      return 'error' in out ? c.json(out, 404) : forClaude(c, out);
    });
    r.post('/claude/propose', async (c) => {
      const changes = proposeNote(ctx, proposeInput.parse(await c.req.json()));
      const set = ctx.changes.propose({ source: 'mcp', title: changes[0].title, summary: 'Suggested from Claude through Margin’s MCP server.', changes });
      return c.json({ id: set.id, url: `/changes/${set.id}`, title: changes[0].title });
    });
  },

  claude: {
    tools: [
      {
        name: 'search_notes', kind: 'read',
        description: 'Search the person’s second brain in Margin: notes on people, projects, plans, ideas and reference, plus notes Margin compiles (routine, recovery plan, habits, projects, people). Returns titles with a snippet; read one with read_note. Private notes are never included.',
        input: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(25).optional() }),
        run: (ctx, i) => b(ctx).claude.search(i.query, i.limit),
      },
      {
        name: 'read_note', kind: 'read',
        description: 'Read one note from the second brain by title (from search_notes or list_notes): the person’s own text, the part Margin compiles (fromMargin), tags, links and what links to it.',
        input: z.object({ title: z.string().min(1).max(200) }),
        run: (ctx, i) => b(ctx).claude.read(i.title),
      },
      {
        name: 'list_notes', kind: 'read',
        description: 'List notes in the second brain, pinned and recently edited first. Optionally one area (Inbox, Me, Projects, People, Journal, or one the person made) or one tag.',
        input: z.object({ area: z.string().max(60).optional(), tag: z.string().max(60).optional(), limit: z.number().int().min(1).max(200).optional() }),
        run: (ctx, i) => b(ctx).claude.list(i),
      },
      {
        name: 'propose_note', kind: 'propose',
        description: 'Propose saving something to the second brain: a new note, or text added to the end of the existing note with that title. Use [[Title]] to link notes and #tags to group them. Queued for review; nothing is saved until the person applies it.',
        input: proposeInput,
        run: (ctx, i) => proposeNote(ctx, i),
      },
    ],
    context: (ctx) => b(ctx).claude.context(),
  },
});
