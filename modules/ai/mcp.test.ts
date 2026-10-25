import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { testApp } from '../../tests/helpers';
import { createServer } from '../../src/mcp/server';
import { DOWN, type Fetcher } from '../../src/mcp/tools';

/** A fetch that talks to the in-process app, with the Host header a real request to 127.0.0.1:7317 carries. */
const viaApp = (app: Awaited<ReturnType<typeof testApp>>): Fetcher => async (path, init) => {
  const r = await app.app.request(path, { ...init, headers: { host: '127.0.0.1:7317', ...init?.headers } });
  return { status: r.status, text: await r.text() };
};

async function connect(fetcher: Fetcher) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(fetcher).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content[0].text as string, json: () => JSON.parse(r.content[0].text) };
  };
  return { client, call };
}

describe('MCP server over the daemon API', () => {
  it('lists the tools and reads today, projects, tasks and metrics', async () => {
    const app = await testApp({ at: '2026-10-26T16:00:00-04:00' });
    await app.ctx.service<any>('todoist').sync();
    const { client, call } = await connect(viaApp(app));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_metrics', 'get_project', 'get_today', 'list_change_kinds', 'list_projects', 'list_tasks', 'propose_changes']);

    const today = await call('get_today');
    expect(today.isError).toBe(false);
    expect(today.json()).toMatchObject({ date: '2026-10-26', capacity: expect.anything(), timeline: expect.any(Array) });

    expect((await call('list_projects')).isError).toBe(false);
    const tasks = (await call('list_tasks')).json();
    expect(Array.isArray(tasks)).toBe(true);
    expect((await call('get_metrics', { weeks: 2 })).json()).toMatchObject({ weeks: 2 });

    const missing = await call('get_project', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No project with id "nope"/);
  });

  it('keeps wellbeing data out unless sharing is on', async () => {
    const app = await testApp({ at: '2026-10-26T16:00:00-04:00' });
    const { call } = await connect(viaApp(app));
    const withheld = (await call('get_metrics')).text;
    expect(withheld).not.toMatch(/"(sleep|energy|dread)/i);
  });

  it('propose_changes queues a pending change set (source mcp) and applies nothing', async () => {
    const app = await testApp({ at: '2026-10-26T16:00:00-04:00' });
    const td = app.ctx.service<any>('todoist');
    await td.sync();
    const task = td.tasks({})[0];
    const { call } = await connect(viaApp(app));

    const bad = await call('propose_changes', { title: 'x', changes: [{ kind: 'nope.kind', title: 'x', payload: {} }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Unknown change kind/);

    const ok = await call('propose_changes', {
      title: 'Plan for Tue', summary: 'One must-do.',
      changes: [{ kind: 'task.meta', title: `Must-do: ${task.content}`, payload: { taskId: task.id, patch: { mustDoDate: '2026-10-27', optional: false } } }],
    });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/Nothing has been applied/);
    expect(ok.text).toMatch(/Review changes/);

    const pending = await app.req('GET', '/api/changesets?status=pending');
    expect(pending.json).toHaveLength(1);
    expect(pending.json[0]).toMatchObject({ source: 'mcp', title: 'Plan for Tue', status: 'pending' });
    expect(td.task(task.id).meta.mustDoDate ?? null).toBeNull();
  });

  it('sends x-margin on writes, so the daemon accepts them', async () => {
    const app = await testApp();
    const seen: string[] = [];
    const spy: Fetcher = async (path, init) => { seen.push(`${init?.method} ${path} ${init?.headers?.['x-margin'] ?? '-'}`); return viaApp(app)(path, init); };
    const { call } = await connect(spy);
    await call('propose_changes', { title: 'x', changes: [{ kind: 'nope', title: 'x', payload: {} }] });
    await call('list_projects');
    expect(seen).toEqual(['POST /api/ai/propose 1', 'GET /api/ai/read/projects -']);
  });

  it('says plainly when Margin is not running', async () => {
    const { call } = await connect(async () => { throw new TypeError('fetch failed'); });
    const r = await call('get_today');
    expect(r).toMatchObject({ isError: true, text: DOWN });
  });
});
