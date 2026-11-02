import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testApp, flush } from '../../tests/helpers';
import { titleKey, cleanTitle, links, tags, renameLinks } from './parse';
import { fromMarkdownFile, hasWord, type BrainService } from './service';
import { compile } from './compile';

const AT = '2026-11-02T10:00:00-05:00'; // Monday after the fall-back
const brain = (app: Awaited<ReturnType<typeof testApp>>) => app.ctx.service<BrainService>('brain');

describe('links and tags', () => {
  it('parses [[links]] with headings and aliases, skips code, and keys titles loosely', () => {
    expect(links('See [[Lim Lab]], [[Lim Lab#Poster|the poster]] and [[ Dr. Lim ]]. `[[not a link]]`\n```\n[[nor this]]\n```'))
      .toEqual(['Lim Lab', 'Dr. Lim']);
    expect(titleKey('  Lim   LAB ')).toBe('lim lab');
    expect(cleanTitle('a [b] | c # d')).toBe('a b c d');
    expect(cleanTitle('   ')).toBe('Untitled');
  });

  it('finds #tags but not headings, numbers, URL fragments or code', () => {
    expect(tags('# Heading\n#school and #school/math, issue #42, https://x.y/#frag, `#code` (#paren) #trailing-')).toEqual(['school', 'school/math', 'trailing']);
  });

  it('rewrites links on rename, keeping headings and shown text', () => {
    expect(renameLinks('[[lim lab]] [[Lim Lab#Poster|poster]] [[Other]]', 'Lim Lab', 'Lim Lab (Mount Sinai)'))
      .toBe('[[Lim Lab (Mount Sinai)]] [[Lim Lab (Mount Sinai)#Poster|poster]] [[Other]]');
  });

  it('matches whole words only', () => {
    expect(hasWord('lab meeting with dr. lim', 'dr. lim')).toBe(true);
    expect(hasWord('election day', 'elect')).toBe(false);
    expect(hasWord('pre-election, then elect officers', 'elect')).toBe(true);
    expect(hasWord('lim lab', 'lim lab')).toBe(true);
  });

  it('keeps Obsidian frontmatter tags and drops the YAML block', () => {
    expect(fromMarkdownFile('---\ntags:\n  - school\n  - #ideas\naliases:\n  - x\n---\nBody')).toBe('Body\n\n#school #ideas\n');
    expect(fromMarkdownFile('---\ntags: [a, b]\n---\nHi')).toBe('Hi\n\n#a #b\n');
    expect(fromMarkdownFile('No frontmatter')).toBe('No frontmatter');
  });
});

describe('notes', () => {
  it('creates, links, renames with link rewrites, and keeps titles unique', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const lab = (await app.req('POST', '/api/brain/notes', { title: 'Lim Lab', area: 'Projects' })).json;
    const idea = (await app.req('POST', '/api/brain/notes', { title: 'Poster idea', body: 'For [[lim lab]], ask about #poster sizes.' })).json;
    expect(idea.area).toBe('Inbox');
    expect(idea.tags).toEqual(['poster']);
    expect(idea.links).toEqual([{ title: 'Lim Lab', id: lab.id }]);
    expect((await app.req('GET', `/api/brain/notes/${lab.id}`)).json.backlinks.map((b: any) => b.title)).toEqual(['Poster idea']);

    const renamed = (await app.req('PATCH', `/api/brain/notes/${lab.id}`, { title: 'Lim Lab (Mount Sinai)' })).json;
    expect(renamed.title).toBe('Lim Lab (Mount Sinai)');
    expect((await app.req('GET', `/api/brain/notes/${idea.id}`)).json.body).toBe('For [[Lim Lab (Mount Sinai)]], ask about #poster sizes.');

    const dup = (await app.req('POST', '/api/brain/notes', { title: 'poster IDEA' })).json;
    expect(dup.title).toBe('poster IDEA 2');
    expect((await app.req('PATCH', `/api/brain/notes/${dup.id}`, { title: 'Poster idea' })).json.title).toBe('Poster idea 2');
  });

  it('treats pinning and hiding from Claude as settings, not edits', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const svc = brain(app);
    const n = svc.create({ title: 'Plan', body: 'x' });
    app.setNow('2026-11-02T12:00:00-05:00');
    expect(svc.update(n.id, { pinned: true, private: true }).updatedAt).toBe(n.updatedAt);
    expect(svc.update(n.id, { body: 'y' }).updatedAt).not.toBe(n.updatedAt);
  });

  it('searches with LIKE wildcards taken literally, title matches first', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const svc = brain(app);
    svc.create({ title: 'Budget', body: 'Spent 50% on books' });
    svc.create({ title: 'Reading list', body: 'The budget book' });
    svc.create({ title: 'Plain', body: 'Spent 50 on books' });
    expect(svc.search('budget').map((n) => n.title)).toEqual(['Budget', 'Reading list']);
    expect(svc.search('50%').map((n) => n.title)).toEqual(['Budget']);
    expect(svc.search('spent books').length).toBe(2);
    expect(svc.search('a_b')).toEqual([]);
    expect((await app.req('GET', '/api/brain/notes?q=budget')).json.notes[0].snippet).toContain('50%');
  });

  it('moves notes to Recently Deleted, restores them, and purges hand-written ones after 30 days', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const svc = brain(app);
    const a = svc.create({ title: 'Scratch' });
    svc.remove(a.id);
    expect(svc.list().notes.find((n) => n.id === a.id)).toBeUndefined();
    expect(svc.trash().map((n) => n.id)).toEqual([a.id]);
    svc.create({ title: 'Scratch' });
    expect(svc.restore(a.id).title).toBe('Scratch 2');
    expect((await app.req('PATCH', `/api/brain/notes/${a.id}`, {})).status).toBe(200);

    svc.remove(a.id);
    const day = svc.daily('2026-11-01');
    svc.remove(day.id);
    app.setNow('2026-12-05T10:00:00-05:00');
    expect(svc.purge()).toBe(1);
    expect(svc.get(a.id)).toBeNull();
    expect(svc.get(day.id)?.deletedAt).toBeTruthy(); // journal tombstone stays, so compiling never brings it back
    expect((await app.req('PATCH', `/api/brain/notes/${day.id}`, { body: 'x' })).status).toBe(404);
  });

  it('captures a line into the Inbox and opens the journal note for the planning date', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'day'] });
    const one = (await app.req('POST', '/api/brain/capture', { text: 'Ask Dr. Lim about poster size\nA0 or A1?' })).json;
    expect(one).toMatchObject({ title: 'Ask Dr. Lim about poster size', body: 'A0 or A1?', area: 'Inbox' });
    const long = (await app.req('POST', '/api/brain/capture', { text: 'x'.repeat(100) })).json;
    expect(long.title.length).toBeLessThanOrEqual(78);
    expect(long.body).toBe('x'.repeat(100));
    expect((await app.req('POST', '/api/brain/capture', { text: '   ' })).status).toBe(400);

    const d1 = (await app.req('POST', '/api/brain/daily', {})).json;
    const d2 = (await app.req('POST', '/api/brain/daily', {})).json;
    expect(d1.id).toBe(d2.id);
    expect(d1).toMatchObject({ title: '2026-11-02', area: 'Journal', date: '2026-11-02' });
    expect((await app.req('PATCH', `/api/brain/notes/${d1.id}`, { title: 'Renamed' })).status).toBe(409);
  });

  it('flags crisis language in your own text, and only there', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const svc = brain(app);
    expect(svc.create({ title: 'Tonight', body: 'I don’t want to be here anymore' }).care).toBe(true);
    expect(svc.create({ title: 'Plan', body: 'Poster draft by Friday' }).care).toBe(false);
  });

  it('refuses writes without the X-Margin header', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const r = await app.app.request('/api/brain/capture', { method: 'POST', headers: { host: '127.0.0.1:7317', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    expect(r.status).toBe(403);
  });
});

describe('compiled from Margin', () => {
  it('builds notes from the rest of Margin, keeps what you write, and is idempotent', async () => {
    const app = await testApp({ at: AT });
    await app.ctx.service<any>('todoist').sync();
    await app.ctx.service<any>('google').sync();
    const pr = app.ctx.service<any>('projects');
    const del = app.ctx.service<any>('delegation');
    const p = pr.create({ name: 'Delphic Medicine', status: 'maintain', maintenance: { action: 'Owner check-in', capMin: 50, told: 'the editors' } }, { onboarding: true });
    del.addFunction({ projectId: p.id, name: 'Manuscript intake', owner: 'Priya' });
    del.addWaiting({ projectId: p.id, what: 'Reviewer list', who: 'Priya' });
    const svc = brain(app);

    const first = compile(app.ctx, svc);
    expect(first.created).toBeGreaterThan(5);
    const titles = svc.titles().map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining(['About me', 'Routine', 'Recovery plan', 'Habits', 'Rituals', 'Saying no', 'Delphic Medicine', 'Priya', 'Todoist inbox']));
    const project = svc.byTitle('Delphic Medicine')!;
    expect(project.area).toBe('Projects');
    expect(project.auto).toContain('Maintenance line');
    expect(project.links.map((l) => l.title)).toContain('Priya');
    expect(svc.byTitle('Priya')!.backlinks.map((b) => b.title)).toContain('Delphic Medicine');
    expect(svc.byTitle('Routine')!.auto).toContain('Hard stop');

    // What you write survives every compile; an unchanged world compiles to nothing.
    svc.update(project.id, { body: 'Hand this to the new editor by June.' });
    expect(compile(app.ctx, svc)).toEqual({ created: 0, updated: 0, removed: 0 });
    expect(svc.get(project.id)!.body).toBe('Hand this to the new editor by June.');

    // Generated titles follow their source, and are locked here.
    expect((await app.req('PATCH', `/api/brain/notes/${project.id}`, { title: 'Other' })).status).toBe(409);
    pr.update(p.id, { name: 'Delphic' });
    const idea = svc.create({ title: 'Idea', body: 'Pitch [[Delphic Medicine]] a newsletter.' });
    compile(app.ctx, svc);
    expect(svc.get(project.id)!.title).toBe('Delphic');
    expect(svc.get(idea.id)!.body).toBe('Pitch [[Delphic]] a newsletter.');

    // Deleted stays deleted; a vanished source keeps your text and drops the compiled part.
    svc.remove(svc.byTitle('Rituals')!.id);
    compile(app.ctx, svc);
    expect(svc.byTitle('Rituals')).toBeNull();
    const priya = svc.byTitle('Priya')!;
    svc.update(priya.id, { body: 'Prefers texts.' });
    for (const f of del.functions(p.id)) del.removeFunction(f.id);
    for (const w of del.waiting(p.id)) del.removeWaiting(w.id);
    compile(app.ctx, svc);
    expect(svc.get(priya.id)).toMatchObject({ body: 'Prefers texts.', auto: '', generated: false });
  });

  it('compiles nothing when From Margin is turned off', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'day'] });
    app.ctx.settings.set('brain', { fromMargin: false });
    expect(compile(app.ctx, brain(app))).toEqual({ created: 0, updated: 0, removed: 0 });
    expect(brain(app).titles()).toEqual([]);
  });

  it('adopts a hand-written note with the same name instead of duplicating it', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'day'] });
    const svc = brain(app);
    const mine = svc.create({ title: 'routine', body: 'Mine.' });
    compile(app.ctx, svc);
    const r = svc.get(mine.id)!;
    expect(r).toMatchObject({ body: 'Mine.', generated: true });
    expect(r.auto).toContain('Wake');
    expect(svc.titles().filter((t) => titleKey(t.title) === 'routine')).toHaveLength(1);
  });

  it('puts the shutdown brain dump into that night’s journal', async () => {
    const app = await testApp({ at: '2026-10-30T21:05:00-04:00' });
    await app.ctx.service<any>('todoist').sync();
    const check = (await app.req('POST', '/api/shutdown/check', { items: [], phoneOut: true })).json;
    const decisions = (check.deadlines ?? check.uncovered ?? []).map((d: any) => ({ key: d.key, status: 'risk', reason: 'Later' }));
    const fin = await app.req('POST', '/api/shutdown/finish', {
      items: [{ text: 'Ask Dr. Lim about the poster', nextAction: 'Email one question', when: 'tomorrow' }], carry: [], mustDos: [], decisions, phoneOut: true,
    });
    expect(fin.status).toBe(200);
    compile(app.ctx, brain(app));
    const night = brain(app).byTitle('2026-10-30')!;
    expect(night.auto).toContain('## Shutdown');
    expect(night.auto).toContain('- Ask Dr. Lim about the poster: Email one question');
  });

  it('keeps a journal across the Nov 1 fall-back, with wellbeing apart', async () => {
    const app = await testApp({ at: '2026-11-01T01:30:00-04:00', only: ['brain', 'day', 'checkin'] });
    const svc = brain(app);
    svc.create({ title: 'First 1:30' });
    app.setNow('2026-11-01T01:30:00-05:00'); // the repeated hour
    svc.create({ title: 'Second 1:30' });
    app.setNow('2026-11-02T07:00:00-05:00');
    await app.req('POST', '/api/checkin/submit', { bedtime: '22:00', wakeTime: '06:30', energy: 6 });
    compile(app.ctx, svc);
    const sun = svc.byTitle('2026-11-01')!;
    expect(sun.date).toBe('2026-11-01');
    expect(sun.auto).toContain('[[First 1:30]]');
    expect(sun.auto).toContain('[[Second 1:30]]');
    const mon = svc.byTitle('2026-11-02')!;
    expect(mon.auto).not.toMatch(/slept|energy/i);
    expect(mon.wellbeing).toMatch(/Slept 8h 30m/);
    expect(svc.byTitle('2026-10-30')).toBeNull(); // nothing happened that day
  });
});

describe('what Claude sees', () => {
  it('hides private notes, the journal and wellbeing unless sharing is on', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'day', 'checkin', 'ai'] });
    const svc = brain(app);
    svc.create({ title: 'Open plan', body: 'Summer research plan' });
    svc.create({ title: 'Secret plan', body: 'Summer research plan', private: true });
    const day = svc.daily('2026-11-02');
    svc.update(day.id, { body: 'Summer research plan, felt awful today' });
    await app.req('POST', '/api/checkin/submit', { bedtime: '23:00', wakeTime: '06:30', energy: 3 });
    compile(app.ctx, svc);

    expect(svc.claude.search('summer research').map((n) => n.title)).toEqual(['Open plan']);
    expect(svc.claude.list().map((n) => n.title)).not.toContain('Secret plan');
    expect(svc.claude.read('Secret plan')).toEqual({ error: '“Secret plan” is private.' });
    expect(svc.claude.read('2026-11-02')).toHaveProperty('error');
    expect(JSON.stringify(svc.claude.read('Sleep and energy'))).not.toMatch(/7h 30m|energy 3/i);
    expect(svc.claude.search('slept')).toEqual([]);
    const mcp = await app.req('GET', '/api/brain/claude/search?q=summer');
    expect(mcp.json.map((n: any) => n.title)).toEqual(['Open plan']);

    app.ctx.settings.set('ai', { shareWellbeing: true });
    expect(svc.claude.search('summer research').map((n) => n.title).sort()).toEqual(['2026-11-02', 'Open plan']);
    expect((svc.claude.read('2026-11-02') as any).wellbeing).toMatch(/Slept 7h 30m/);
    expect(svc.claude.read('Secret plan')).toEqual({ error: '“Secret plan” is private.' });
  });

  it('gives the in-app Claude the brain tools, even with wellbeing sharing off', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'ai'] });
    const names = app.ctx.service<any>('ai').tools().map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search_notes', 'read_note', 'list_notes', 'propose_note']));
    brain(app).create({ title: 'Pinned plan', pinned: true });
    expect(app.ctx.registry.get('brain')!.claude!.context!(app.ctx)).toMatchObject({ notes: 1, pinned: ['Pinned plan'] });
  });

  it('turns propose_note into a change set that creates or appends only after review', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'ai'] });
    const svc = brain(app);
    svc.create({ title: 'Reading list', body: '- Dune' });
    svc.create({ title: 'Diary', private: true });
    const tool = app.ctx.registry.get('brain')!.claude!.tools!.find((t) => t.name === 'propose_note')!;
    const create = await tool.run(app.ctx, { title: 'Gift ideas', text: 'Mom: [[Reading list]] book', area: 'Me' }) as any[];
    const append = await tool.run(app.ctx, { title: 'reading list', text: '- Piranesi' }) as any[];
    expect(create[0].kind).toBe('brain.note.create');
    expect(append[0]).toMatchObject({ kind: 'brain.note.append', payload: { title: 'Reading list', text: '- Piranesi' } });
    expect(() => tool.run(app.ctx, { title: 'Diary', text: 'x' })).toThrow(/can’t be changed/);
    expect(svc.byTitle('Gift ideas')).toBeNull();

    const set = app.ctx.changes.propose({ source: 'claude', title: 'Notes', changes: [...create, ...append] });
    const applied = await app.ctx.changes.apply(set.id);
    expect(applied.status).toBe('applied');
    expect(svc.byTitle('Gift ideas')).toMatchObject({ area: 'Me', body: 'Mom: [[Reading list]] book' });
    expect(svc.byTitle('Reading list')!.body).toBe('- Dune\n\n- Piranesi');

    const mcp = await app.req('POST', '/api/brain/claude/propose', { title: 'From MCP', text: 'Hello' });
    expect(app.ctx.changes.get(mcp.json.id)).toMatchObject({ source: 'mcp', status: 'pending' });
  });
});

describe('Markdown folder import', () => {
  it('imports .md files, skips hidden folders, symlinks and huge files, and never overwrites edits made here', async () => {
    const app = await testApp({ at: AT, only: ['brain'] });
    const svc = brain(app);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-vault-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-outside-'));
    fs.mkdirSync(path.join(dir, 'School'));
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.writeFileSync(path.join(dir, 'Ideas.md'), '---\ntags: [ideas]\n---\nLink to [[Chemistry]].');
    fs.writeFileSync(path.join(dir, 'School', 'Chemistry.md'), 'Titration notes');
    fs.writeFileSync(path.join(dir, '.obsidian', 'workspace.md'), 'skip');
    fs.writeFileSync(path.join(dir, 'Huge.md'), 'x'.repeat(1_100_000));
    fs.writeFileSync(path.join(outside, 'Secret.md'), 'outside');
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    fs.writeFileSync(path.join(dir, 'image.png'), 'not text');

    const first = (await app.req('POST', '/api/brain/import', { folder: dir })).json;
    expect(first).toEqual({ files: 3, created: 2, updated: 0, skipped: 1 });
    expect(svc.byTitle('Chemistry')).toMatchObject({ area: 'School', body: 'Titration notes' });
    expect(svc.byTitle('Ideas')!.tags).toEqual(['ideas']);
    expect(svc.byTitle('Ideas')!.links).toEqual([{ title: 'Chemistry', id: svc.byTitle('Chemistry')!.id }]);
    expect(svc.byTitle('Secret')).toBeNull();
    expect(svc.byTitle('workspace')).toBeNull();

    svc.update(svc.byTitle('Ideas')!.id, { body: 'Edited in Margin' });
    fs.writeFileSync(path.join(dir, 'Ideas.md'), 'Changed on disk');
    fs.writeFileSync(path.join(dir, 'School', 'Chemistry.md'), 'Titration notes, v2');
    const second = (await app.req('POST', '/api/brain/import', { folder: dir })).json;
    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect(svc.byTitle('Ideas')!.body).toBe('Edited in Margin');
    expect(svc.byTitle('Chemistry')!.body).toBe('Titration notes, v2');
    expect(app.ctx.settings.get<any>('brain').importFolder).toBe(dir);

    expect((await app.req('POST', '/api/brain/import', { folder: path.join(dir, 'nope') })).status).toBe(404);
    expect((await app.req('POST', '/api/brain/import', { folder: path.join(dir, 'Ideas.md') })).status).toBe(400);
  });
});

describe('Today', () => {
  it('surfaces notes named in today’s schedule and the notes of projects on the calendar', async () => {
    const app = await testApp({ at: AT, only: ['brain', 'day', 'google'] });
    await app.ctx.service<any>('google').sync();
    const svc = brain(app);
    const n = svc.create({ title: 'Election', area: 'People' }); // the mock calendar has “Election Day” on Nov 3
    svc.create({ title: 'Unrelated zebra' });
    svc.create({ title: 'Elect' }); // a word inside another word doesn't count
    const out = (await app.req('GET', '/api/brain/today?date=2026-11-03')).json;
    expect(out.date).toBe('2026-11-03');
    expect(out.notes).toEqual([{ id: n.id, title: 'Election', area: 'People', reason: 'Election Day today' }]);
    expect((await app.req('GET', '/api/brain/today?date=2026-11-04')).json.notes).toEqual([]);
    await flush();
  });
});
