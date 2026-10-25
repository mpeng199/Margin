/** The background process: API + web app on 127.0.0.1, scheduler, sync, notifications. launchd keeps it alive. */
import path from 'node:path';
import { serve } from '@hono/node-server';
import { boot } from './core/boot';
import { dataDir, PORT, ROOT } from './core/paths';

process.removeAllListeners('warning'); // node:sqlite ExperimentalWarning noise

const dev = process.env.MARGIN_DEV === '1';
const dir = process.env.MARGIN_DATA_DIR ? dataDir() : dev ? path.join(ROOT, '.margin-dev') : dataDir();
process.env.MARGIN_DATA_DIR = dir;

const { app, scheduler, ctx } = await boot({ dataDir: dir, dev });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, (info) => {
  ctx.log.info(`Margin daemon on http://127.0.0.1:${info.port} (data: ${dir}${dev ? ', dev' : ''})`);
});
scheduler.start();

const shutdown = () => {
  scheduler.stop();
  server.close();
  ctx.db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
