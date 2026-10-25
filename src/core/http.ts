/**
 * Local HTTP API + static web app, bound to 127.0.0.1 only.
 * Local servers are reachable by any web page through the browser, so:
 *  - Host must be 127.0.0.1/localhost (blocks DNS rebinding),
 *  - mutating requests need the X-Margin header (forces a CORS preflight we never approve),
 *  - a present Origin must be our own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import type { Ctx } from './types';
import { ROOT } from './paths';

type SSEClient = { kind: string; send: (event: string, data: unknown) => void };

export class Hub {
  private clients = new Set<SSEClient>();
  add(c: SSEClient) { this.clients.add(c); return () => this.clients.delete(c); }
  broadcast(event: string, data: unknown, kind?: string) {
    let n = 0;
    for (const c of this.clients) if (!kind || c.kind === kind) { c.send(event, data); n++; }
    return n;
  }
  count(kind?: string) { return [...this.clients].filter((c) => !kind || c.kind === kind).length; }
}

export function createApp(ctx: Ctx, hub: Hub, port: number) {
  const app = new Hono();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);

  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!allowedHosts.has(host) && !ctx.dev && process.env.MARGIN_ALLOW_ANY_HOST !== '1') return c.text('Forbidden host', 403);
    const origin = c.req.header('origin');
    if (origin) {
      try {
        if (!allowedHosts.has(new URL(origin).host)) return c.text('Forbidden origin', 403);
      } catch { return c.text('Bad origin', 403); }
    }
    if (c.req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-margin') !== '1') {
      return c.json({ error: 'Missing X-Margin header' }, 403);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'Invalid input', issues: err.issues }, 400);
    const status = (err as any).status ?? 500;
    if (status >= 500) ctx.log.error(`${c.req.method} ${c.req.path}`, err);
    return c.json({ error: err.message }, status);
  });

  // ---- core endpoints
  app.get('/api/health', (c) => c.json({ ok: true, dev: ctx.dev, shell: hub.count('shell') }));

  app.get('/api/modules', (c) => c.json(ctx.registry.publicInfo(ctx.settings)));
  app.post('/api/modules/:id/enabled', async (c) => {
    const { enabled } = await c.req.json();
    ctx.registry.setEnabled(c.req.param('id'), !!enabled);
    ctx.bus.emit('modules.changed', { id: c.req.param('id'), enabled: !!enabled });
    return c.json({ ok: true });
  });

  app.get('/api/settings', (c) => {
    const out: Record<string, unknown> = {};
    for (const id of ctx.settings.modules()) out[id] = ctx.settings.get(id);
    return c.json(out);
  });
  app.get('/api/settings/:module', (c) => c.json(ctx.settings.get(c.req.param('module'))));
  app.patch('/api/settings/:module', async (c) => c.json(ctx.settings.set(c.req.param('module'), await c.req.json())));

  app.get('/api/changesets', (c) => c.json(ctx.changes.list(c.req.query('status'))));
  app.get('/api/changesets/kinds', (c) => c.json(ctx.changes.kinds()));
  app.get('/api/changesets/:id', (c) => {
    const s = ctx.changes.get(c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'Not found' }, 404);
  });
  app.patch('/api/changesets/:id/changes/:cid', async (c) => c.json(ctx.changes.edit(c.req.param('id'), c.req.param('cid'), await c.req.json())));
  app.post('/api/changesets/:id/apply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await ctx.changes.apply(c.req.param('id'), body.changeIds));
  });
  app.post('/api/changesets/:id/discard', (c) => { ctx.changes.discard(c.req.param('id')); return c.json({ ok: true }); });

  app.get('/api/rules', (c) => c.json(ctx.rules.list()));
  app.get('/api/rules/catalog', (c) => c.json(ctx.rules.catalog()));
  app.get('/api/rules/firings', (c) => c.json(ctx.rules.active()));
  app.get('/api/rules/history', (c) => c.json(ctx.rules.history()));
  app.put('/api/rules/:id', async (c) => c.json({ id: ctx.rules.save({ ...(await c.req.json()), id: c.req.param('id') }) }));
  app.post('/api/rules', async (c) => c.json({ id: ctx.rules.save(await c.req.json()) }));
  app.delete('/api/rules/:id', (c) => { ctx.rules.remove(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/rules/evaluate', async (c) => c.json(await ctx.rules.evaluate()));
  app.post('/api/rules/firings/:id/dismiss', (c) => { ctx.rules.dismiss(c.req.param('id')); return c.json({ ok: true }); });

  app.get('/api/notifications', (c) => c.json(ctx.notify.recent()));
  app.get('/api/events', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const name = c.req.query('name');
    const rows = name
      ? ctx.db.all('SELECT * FROM events WHERE name = ? ORDER BY id DESC LIMIT ?', name, limit)
      : ctx.db.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
    return c.json(rows.map((r) => ({ ...r, payload: JSON.parse(r.payload ?? '{}') })));
  });

  // Live updates: every bus event is forwarded so the UI can refetch. The shell also receives notifications here.
  app.get('/api/stream', (c) => {
    const kind = c.req.query('client') ?? 'web';
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => { void stream.writeSSE({ event, data: JSON.stringify(data) }); };
      const remove = hub.add({ kind, send });
      send('hello', { kind });
      const ping = setInterval(() => send('ping', {}), 20_000);
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      clearInterval(ping);
      remove();
    });
  });

  // ---- module routes at /api/<id>, guarded by the enabled flag
  for (const m of ctx.registry.all) {
    if (!m.routes) continue;
    const r = new Hono();
    r.use('*', async (c, next) => {
      if (!ctx.registry.isEnabled(m.id)) return c.json({ error: `${m.name} is turned off` }, 404);
      await next();
    });
    m.routes(r, ctx);
    app.route(`/api/${m.id}`, r);
  }

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // ---- static web app (built by `npm run build`)
  const dist = path.join(ROOT, 'web', 'dist');
  app.get('*', (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, '');
    const file = path.join(dist, rel);
    if (rel && file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return new Response(fs.readFileSync(file), { headers: { 'content-type': mime(file), 'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' } });
    }
    const index = path.join(dist, 'index.html');
    if (fs.existsSync(index)) return c.html(fs.readFileSync(index, 'utf8'));
    return c.text('Web app not built. Run `npm run build`, or use `npm run dev`.', 503);
  });

  return app;
}

function mime(f: string) {
  const ext = path.extname(f);
  return ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
