import { describe, it, expect } from 'vitest';
import { testApp } from '../helpers';
import { TodoistClient, cmd, rescheduleDue } from '../../src/integrations/todoist/client';
import { createMockTodoist } from '../../src/integrations/todoist/mock';
import type { TodoistService } from '../../modules/todoist/manifest';

const boot = () => testApp({ at: '2026-10-26T16:00:00-04:00', only: ['day', 'todoist', 'today'] });

describe('todoist client against the mock API', () => {
  it('full then incremental sync returns only changes', async () => {
    const mock = createMockTodoist();
    const c = new TodoistClient('t', mock.fetch);
    const full = await c.sync('*');
    expect(full.full_sync).toBe(true);
    expect(full.items!.length).toBeGreaterThan(5);
    const inc = await c.sync(full.sync_token);
    expect(inc.items).toHaveLength(0);
    await c.commands([cmd('item_add', { content: 'New thing' })]);
    const inc2 = await c.sync(inc.sync_token);
    expect(inc2.items!.map((i) => i.content)).toEqual(['New thing']);
  });

  it('a wrong update path kills recurrence; the reschedule path keeps it', async () => {
    const mock = createMockTodoist();
    const c = new TodoistClient('t', mock.fetch);
    const rec = mock.state().items.find((i) => i.due?.is_recurring)!;
    // due.string "friday" (what REST due_string does) drops recurrence
    const copy = structuredClone(rec);
    await c.commands([cmd('item_update', { id: rec.id, due: { date: '2026-10-30' } })]);
    expect(mock.state().items.find((i) => i.id === rec.id)!.due!.is_recurring).toBe(false);
    // restore and use the proper path
    await c.commands([cmd('item_update', { id: rec.id, due: copy.due })]);
    await c.commands([cmd('item_update', { id: rec.id, due: rescheduleDue(copy.due, '2026-10-30') })]);
    const after = mock.state().items.find((i) => i.id === rec.id)!;
    expect(after.due!.is_recurring).toBe(true);
    expect(after.due!.date.slice(0, 10)).toBe('2026-10-30');
    expect(after.due!.string).toBe(copy.due!.string);
  });

  it('rescheduleDue keeps time of day and the Z suffix', () => {
    expect(rescheduleDue({ date: '2026-10-26T09:00:00Z', string: 'every day at 9am', is_recurring: true, timezone: 'America/New_York', lang: 'en' }, '2026-10-28'))
      .toEqual({ date: '2026-10-28T09:00:00Z', string: 'every day at 9am', is_recurring: true, timezone: 'America/New_York', lang: 'en' });
    expect(rescheduleDue({ date: '2026-10-26', string: 'Oct 26', is_recurring: false, timezone: null, lang: 'en' }, '2026-10-28')).toEqual({ date: '2026-10-28' });
  });

  it('per-command errors surface even on HTTP 200, and deletes are refused', async () => {
    const c = new TodoistClient('t', createMockTodoist().fetch);
    await expect(c.commands([cmd('item_update', { id: 'nope', content: 'x' })])).rejects.toThrow(/Task not found/);
    await expect(c.commands([cmd('item_delete', { id: 'x' })])).rejects.toThrow();
  });

  it('free plan project cap is enforced', async () => {
    const c = new TodoistClient('t', createMockTodoist().fetch);
    await c.commands([cmd('project_add', { name: 'A' }), cmd('project_add', { name: 'B' })]);
    await expect(c.commands([cmd('project_add', { name: 'C' })])).rejects.toThrow(/Maximum number of projects/);
  });

  it('bad token gives a readable error', async () => {
    const c = new TodoistClient('bad-token', createMockTodoist().fetch);
    await expect(c.sync()).rejects.toThrow(/rejected the API token/);
  });
});

describe('todoist module', () => {
  it('syncs into the mirror, closes and logs completions, drops without deleting', async () => {
    const app = await boot();
    const td = app.ctx.service<TodoistService>('todoist');
    await td.sync();
    const tasks = td.tasks();
    expect(tasks.length).toBeGreaterThan(5);
    const email = tasks.find((t) => t.content.startsWith('Email Dr. Lim'))!;
    expect(email.priority).toBe(1); // API 4 → UI p1
    await td.close(email.id);
    expect(td.tasks().find((t) => t.id === email.id)).toBeUndefined();
    expect(td.completions('2026-10-26', '2026-10-26')).toHaveLength(1);

    const rec = td.tasks().find((t) => t.due?.recurring && t.content.includes('lab notebook'))!;
    await td.close(rec.id); // recurring close advances, stays open
    const recAfter = td.task(rec.id)!;
    expect(recAfter.checked).toBe(false);
    expect(recAfter.due!.date).toBe('2026-10-27');

    const essay = td.tasks().find((t) => t.content.includes('RSI'))!;
    await td.drop(essay.id, 'Not this cycle');
    expect(td.mock()!.notes().some((n) => n.content.includes('Not this cycle'))).toBe(true);
    expect(td.mock()!.state().items.find((i) => i.id === essay.id)!.is_deleted).toBe(false);
  });

  it('reschedule via the service preserves recurrence', async () => {
    const app = await boot();
    const td = app.ctx.service<TodoistService>('todoist');
    await td.sync();
    const rec = td.tasks().find((t) => t.due?.recurring)!;
    await td.reschedule(rec.id, '2026-11-03');
    const after = td.task(rec.id)!;
    expect(after.due).toMatchObject({ date: '2026-11-03', recurring: true });
  });

  it('applies a change set and records per-change status', async () => {
    const app = await boot();
    const td = app.ctx.service<TodoistService>('todoist');
    await td.sync();
    const [a, b] = td.tasks();
    const set = app.ctx.changes.propose({ source: 'review', title: 'Test', changes: [
      { kind: 'todoist.task.reschedule', title: 'move a', payload: { taskId: a.id, date: '2026-10-29' } },
      { kind: 'todoist.task.reschedule', title: 'move b', payload: { taskId: b.id, date: '2026-10-30' } },
      { kind: 'todoist.task.close', title: 'bad', payload: { taskId: 'missing' } },
    ] });
    const out = await app.ctx.changes.apply(set.id, [set.changes[0].id, set.changes[2].id]);
    expect(out.changes.map((c) => c.status)).toEqual(['applied', 'skipped', 'failed']);
    expect(out.status).toBe('partial');
    expect(td.task(a.id)!.due!.date).toBe('2026-10-29');
  });

  it('quick add parses project, label, priority and date', async () => {
    const app = await boot();
    const td = app.ctx.service<TodoistService>('todoist');
    await td.sync();
    await td.quickAdd('Call SHP office tomorrow at 4pm @next p2');
    const t = td.tasks().find((x) => x.content === 'Call SHP office')!;
    expect(t).toBeTruthy();
    expect(t.labels).toContain('next');
    expect(t.priority).toBe(2);
    expect(t.due).toMatchObject({ date: '2026-10-27', time: '16:00' });
  });
});
