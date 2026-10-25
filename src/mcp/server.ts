/**
 * Margin MCP server (stdio) for Claude Code and Claude desktop. It is a thin client of the running daemon:
 * start Margin first. stdout is the protocol, so anything human-readable goes to stderr.
 *
 *   claude mcp add margin -- node --no-warnings --import tsx /Users/michaelpeng/minimike/src/mcp/server.ts
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeCall, TOOLS, type Fetcher } from './tools';

const INSTRUCTIONS =
  'Margin is a private planner for one high school student recovering from burnout. Read first (get_today, list_tasks, list_projects, get_metrics), ' +
  'then use propose_changes. Nothing you propose is applied: the person reviews it in Margin → Review changes. ' +
  'Never plan past the hard stop, never trade sleep for work, at most 3 must-dos per day. Be direct and specific; no cheerleading, no guilt.';

export function daemonFetcher(port = process.env.MARGIN_PORT || 7317): Fetcher {
  const base = `http://127.0.0.1:${port}`;
  return async (path, init) => {
    const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(30_000) });
    return { status: r.status, text: await r.text() };
  };
}

export function createServer(fetcher: Fetcher = daemonFetcher()) {
  const call = makeCall(fetcher);
  const server = new McpServer({ name: 'margin', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.input as any, annotations: { readOnlyHint: !t.write, destructiveHint: false, openWorldHint: false } },
      (async (args: unknown) => {
        const r = await t.run(call, args ?? {});
        return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
      }) as any,
    );
  }
  return server;
}

const direct = !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (direct) {
  createServer().connect(new StdioServerTransport()).then(
    () => process.stderr.write(`margin MCP ready (daemon on port ${process.env.MARGIN_PORT || 7317})\n`),
    (e) => { process.stderr.write(`margin MCP failed to start: ${e?.message ?? e}\n`); process.exit(1); },
  );
}
