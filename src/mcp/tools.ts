/**
 * MCP tool handlers for Claude Code / Claude desktop. Each one is a thin call to the Margin daemon through an
 * injected fetch, so tests can point it at an in-process app and the server can point it at 127.0.0.1.
 *
 * Reads go to /api/ai/read/*: the same aggregates the in-app Claude uses, with sleep, energy and mood removed
 * unless "Share check-in, sleep and mood with Claude" is on in Settings → Claude. The one write queues a
 * pending change set; nothing is applied until the person reviews it in Margin.
 */
import { z } from 'zod';

export interface FetchInit { method?: string; headers?: Record<string, string>; body?: string }
export type Fetcher = (path: string, init?: FetchInit) => Promise<{ status: number; text: string }>;
export interface ToolResult { text: string; isError?: boolean }

type Reply = { error: string } | { data: any };
type Call = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Reply>;

export interface McpTool {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  /** False for tools that only read. */
  write?: boolean;
  run(call: Call, args: any): Promise<ToolResult>;
}

export const DOWN = 'Margin isn’t running. Open Margin (or run ./start.sh in the Margin folder), then try again.';

export function makeCall(fetcher: Fetcher): Call {
  return async (method, path, body) => {
    let res: { status: number; text: string };
    try {
      res = await fetcher(path, {
        method,
        headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-margin': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { error: DOWN };
    }
    let json: any = null;
    try { json = JSON.parse(res.text); } catch { /* plain text */ }
    if (res.status >= 400) {
      const issues = Array.isArray(json?.issues) ? `: ${json.issues.map((i: any) => `${(i.path ?? []).join('.') || 'input'} ${i.message}`).join('; ')}` : '';
      return { error: `${json?.error ?? (res.text.slice(0, 200) || `Margin returned ${res.status}`)}${issues}` };
    }
    return { data: json ?? res.text };
  };
}

const out = (r: Reply): ToolResult => ('error' in r ? { text: r.error, isError: true } : { text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) });
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const TOOLS: McpTool[] = [
  {
    name: 'get_today',
    description: 'Margin’s picture of a day: mode and hard stop, capacity (free minutes vs planned load), the schedule, and the plan (must-dos, homework, carry-overs, triage queue). Start here before suggesting anything. Defaults to the planning date.',
    input: { date: iso.optional().describe('YYYY-MM-DD; omit for today') },
    run: async (call, a) => out(await call('GET', `/api/ai/read/today${qs({ date: a.date })}`)),
  },
  {
    name: 'list_projects',
    description: 'Active projects with status, purpose, goal, weekly time budget and the separation rule that keeps school and non-school apart.',
    input: {},
    run: async (call) => out(await call('GET', '/api/ai/read/projects')),
  },
  {
    name: 'get_project',
    description: 'One project in detail: settings, its tasks, upcoming deadlines, delegated functions and what it is waiting on. Use an id from list_projects.',
    input: { id: z.string().min(1).describe('Project id from list_projects') },
    run: async (call, a) => out(await call('GET', `/api/ai/read/projects/${encodeURIComponent(a.id)}`)),
  },
  {
    name: 'get_metrics',
    description: 'Recent numbers over 1–12 weeks (default 4): stop breaks, task completions, focus minutes per project, habit consistency, weekly scores. Sleep, energy and mood are left out unless the person turned on sharing in Margin.',
    input: { weeks: z.number().int().min(1).max(12).optional() },
    run: async (call, a) => out(await call('GET', `/api/ai/read/metrics${qs({ weeks: a.weeks ?? 4 })}`)),
  },
  {
    name: 'list_tasks',
    description: 'Todoist tasks (up to 150) with project, due date, estimate, must-do date and carry count. Filter by project id, label, an exact due date, or everything due on or before a date. Use these ids in propose_changes.',
    input: {
      projectId: z.string().optional(), label: z.string().optional(),
      dueOn: iso.optional(), dueOnOrBefore: iso.optional(),
    },
    run: async (call, a) => out(await call('GET', `/api/ai/read/tasks${qs({ projectId: a.projectId, label: a.label, dueOn: a.dueOn, dueOnOrBefore: a.dueOnOrBefore })}`)),
  },
  {
    name: 'list_change_kinds',
    description: 'The kinds of change Margin can apply (for propose_changes), with the fields the person can edit before applying.',
    input: {},
    run: async (call) => out(await call('GET', '/api/changesets/kinds')),
  },
  {
    name: 'propose_changes',
    description: 'Queue changes for the person to review. Nothing is applied: they open Margin → Review changes and apply, edit or discard each one. Each change needs a kind from list_change_kinds, a short title, and a payload. Use task and project ids from list_tasks / list_projects. Put everything for one request in one call. Respect the plan rules: nothing past the hard stop, at most 3 must-dos a day.',
    write: true,
    input: {
      title: z.string().min(1).max(200).describe('Short title for the whole set, e.g. "Plan for Tue Oct 27"'),
      summary: z.string().max(4000).optional().describe('One paragraph on why, shown at the top of the review'),
      changes: z.array(z.object({
        kind: z.string().min(1), title: z.string().min(1).max(300),
        payload: z.record(z.string(), z.any()), before: z.record(z.string(), z.any()).nullish(),
      })).min(1).max(100),
    },
    run: async (call, a) => {
      const r = await call('POST', '/api/ai/propose', { title: a.title, summary: a.summary, changes: a.changes });
      if ('error' in r) return out(r);
      const d = r.data;
      const rejected = Array.isArray(d.rejected) && d.rejected.length ? ` Rejected: ${d.rejected.join(' ')}` : '';
      return { text: `Queued “${a.title}” as ${d.count} change${d.count === 1 ? '' : 's'} (id ${d.id}). Nothing has been applied. Tell the person to review it in Margin → Review changes (${d.url}).${rejected}` };
    },
  },
];
