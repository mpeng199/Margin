/**
 * rules — the generic actions for the core rules engine, the default if-then rules (SPEC 4.11), the schedule that
 * evaluates them, and the alerts that show on Today. The engine itself lives in src/core/rules.ts; other modules
 * contribute the conditions. A rule fires once when its conditions become true and stays active until they clear.
 */
import { z } from 'zod';
import { defineModule, type Ctx, type RuleAction, type RuleDef } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { kvGet, kvSet } from '../../src/core/kv';
import { now, today } from '../../src/core/time';

/** A banner's look is stored per rule so the Today widget can show it next to the engine's firing. */
interface BannerStyle { tone: 'amber' | 'green'; text: string }
export interface RequiredStep { id: string; label: string; ruleId: string }
export interface QueuedAsk { id: string; prompt: string; ruleId: string; ruleName: string; queuedAt: string }

const BANNERS = 'rules.banners';
const HIDDEN = 'rules.hidden';
const FILL = (text: string, f: { detail: string; subject?: string }) =>
  text.replaceAll('{detail}', f.detail).replaceAll('{subject}', f.subject ?? '').trim();

/** Unresolved firings that carry an action, dismissed or not. Hiding a banner must never lift a lock. */
function holds(ctx: Ctx, action: string): boolean {
  return ctx.db.all<{ actions: string }>('SELECT actions FROM rule_firings WHERE resolved_at IS NULL')
    .some((r) => { try { return (JSON.parse(r.actions) as string[]).includes(action); } catch { return false; } });
}

/** Keep derived flags in step with the firings: the off-day lock follows `offday_non_negotiable`. */
function syncFlags(ctx: Ctx) {
  kvSet(ctx.db, 'offday.locked', holds(ctx, 'offday_non_negotiable'));
}

/** Get help cards come back each day while the rule that opened them is still active. */
function reopenGetHelp(ctx: Ctx) {
  const help = ctx.maybe<{ open(reason: string): unknown }>('gethelp');
  if (!help) return;
  for (const f of ctx.rules.active()) if (f.actions.includes('open_get_help')) help.open(f.ruleName);
}

/** One evaluation at a time, so two events can't both fire the same rule. */
let queue: Promise<unknown> = Promise.resolve();
export function evaluateRules(ctx: Ctx) {
  const run = queue.catch(() => undefined).then(async () => {
    const fired = await ctx.rules.evaluate();
    syncFlags(ctx);
    return fired;
  });
  queue = run;
  return run;
}

export const ruleActions: RuleAction[] = [
  {
    id: 'banner',
    label: 'Show a banner on Today',
    params: z.object({
      tone: z.enum(['amber', 'green']).default('amber').describe('Amber = needs a decision. Green = on track.'),
      text: z.string().max(300).default('').describe('What the banner says. {detail} and {subject} are filled in. Blank = the rule’s detail.'),
    }),
    run(ctx, p, f) {
      const all = kvGet<Record<string, BannerStyle>>(ctx.db, BANNERS, {});
      all[f.ruleId] = { tone: p.tone, text: FILL(p.text || '{detail}', f) };
      kvSet(ctx.db, BANNERS, all);
    },
  },
  {
    id: 'notification',
    label: 'Send a notification',
    params: z.object({
      title: z.string().min(1).max(80),
      body: z.string().max(240).default(''),
      category: z.enum(['wellbeing', 'work']).default('wellbeing').describe('Work notifications are silenced after shutdown and on the off-day.'),
    }),
    run(ctx, p, f) {
      ctx.notify.send({ key: `rule:${f.ruleId}:${now().toMillis()}:${p.title}`, title: p.title, body: FILL(p.body, f), category: p.category, path: '/today' });
    },
  },
  {
    id: 'require_review_step',
    label: 'Require a step in the next weekly review',
    params: z.object({ stepId: z.string().min(1).max(60), label: z.string().min(1).max(120) }),
    run(ctx, p, f) {
      const steps = kvGet<RequiredStep[]>(ctx.db, 'review.requiredSteps', []);
      if (steps.some((s) => s.id === p.stepId)) return;
      kvSet(ctx.db, 'review.requiredSteps', [...steps, { id: p.stepId, label: p.label, ruleId: f.ruleId }]);
    },
  },
  {
    id: 'lock_add_projects',
    label: 'Lock adding new projects',
    params: z.object({}),
    // The lock is the active firing itself: projects ask ctx.rules.isActive('lock_add_projects').
    run: () => undefined,
  },
  {
    id: 'offday_non_negotiable',
    label: 'Make the off-day non-negotiable',
    params: z.object({}),
    run(ctx) { kvSet(ctx.db, 'offday.locked', true); },
  },
  {
    id: 'ask_claude',
    label: 'Ask Claude',
    params: z.object({ prompt: z.string().min(1).max(2000) }),
    // Only the written prompt goes out. The firing's detail may contain sleep or mood data, so it stays local.
    async run(ctx, p, f) {
      const ai = ctx.maybe<{ enabled(): boolean; run(feature: string, input: unknown): Promise<unknown> }>('ai');
      if (ai?.enabled()) {
        try { await ai.run('ask', { prompt: p.prompt, ruleId: f.ruleId }); return; }
        catch (e) { ctx.log.warn('ask_claude failed, queued instead', e instanceof Error ? e.message : String(e)); }
      }
      const q = kvGet<QueuedAsk[]>(ctx.db, 'ai.queue', []);
      kvSet(ctx.db, 'ai.queue', [...q, { id: uid(), prompt: p.prompt, ruleId: f.ruleId, ruleName: f.ruleName, queuedAt: now().toISO()! }]);
    },
  },
  {
    id: 'create_task',
    label: 'Create a Todoist task',
    params: z.object({ content: z.string().min(1).max(300), dueString: z.string().max(80).default('').describe('For example “tomorrow” or “next Sunday”.') }),
    async run(ctx, p, f) {
      const td = ctx.maybe<{ add(i: { content: string; dueString?: string }): Promise<unknown> }>('todoist');
      if (!td) { ctx.log.warn(`create_task: Todoist is off, skipped “${p.content}” from ${f.ruleName}`); return; }
      await td.add({ content: FILL(p.content, f), dueString: p.dueString || undefined });
    },
  },
  {
    id: 'open_get_help',
    label: 'Open Get help',
    params: z.object({}),
    run(ctx, _p, f) { ctx.maybe<{ open(r: string): unknown }>('gethelp')?.open(f.ruleName); },
  },
];

const src = {
  panagioti: 'Panagioti 2017',
  aasm: 'AASM 2016; Panagioti 2017',
};

/** The default rules. Ids are stable; a rule you edit is never overwritten. Conditions from modules that aren't on show as unavailable. */
export const defaultRules: RuleDef[] = [
  {
    id: 'default.stop_broken',
    name: 'Stop broken twice in a week',
    enabled: true,
    when: [{ condition: 'shutdown.stop_broken_count', params: { count: 2, days: 7 } }],
    then: [
      { action: 'require_review_step', params: { stepId: 'remove-maintain-item', label: 'Remove one Maintain item' } },
      { action: 'banner', params: { tone: 'amber', text: 'The stop broke twice this week. In your next review, remove one Maintain item.' } },
    ],
    why: 'Changing workload beats coping techniques (effect −0.45 vs −0.18), so the fix is carrying less.',
    source: src.panagioti,
  },
  {
    id: 'default.short_sleep',
    name: 'Under 7 hours of sleep, 3 nights running',
    enabled: true,
    when: [{ condition: 'sleep.short_nights', params: { hours: 7, nights: 3 } }],
    then: [
      { action: 'lock_add_projects', params: {} },
      { action: 'offday_non_negotiable', params: {} },
      { action: 'banner', params: { tone: 'amber', text: 'Sleep has been under 7 hours three nights running. Adding projects is locked and the off-day stays an off-day until sleep recovers.' } },
    ],
    why: 'Teens need 8 to 10 hours. When sleep drops, the answer is a lighter load, not pushing through.',
    source: src.aasm,
  },
  {
    id: 'default.dread_high',
    name: 'Dread at 7 or higher, two weeks running',
    enabled: true,
    when: [{ condition: 'review.dread_high', params: { score: 7, weeks: 2 } }],
    then: [
      { action: 'banner', params: { tone: 'amber', text: 'Dread has been 7 or higher for two weeks. Pick the function that weighs most and hand it over completely.' } },
    ],
    why: 'Dread and cynicism ease when the work itself changes. Delegating a whole function does that.',
    source: src.panagioti,
  },
  {
    id: 'default.past_stop_on_project',
    name: 'Working past the stop on one project',
    enabled: true,
    when: [{ condition: 'shutdown.past_stop_on_project', params: {} }],
    then: [
      { action: 'banner', params: { tone: 'amber', text: '{detail} Pick the part of it you can hand over completely.' } },
    ],
    why: 'A project that keeps spilling past the stop is bigger than its slot. Delegating the function frees the slot.',
    source: src.panagioti,
  },
  {
    id: 'default.on_track',
    name: 'On track',
    enabled: true,
    when: [
      { condition: 'checkin.energy_trend', params: { direction: 'up', weeks: 2 } },
      { condition: 'shutdown.stop_held_days', params: { min: 6, days: 7 } },
    ],
    then: [
      { action: 'banner', params: { tone: 'green', text: 'On track. Energy is trending up and the stop held on at least 6 of the last 7 days. No change needed.' } },
    ],
    why: 'When the plan is working, the right move is to leave it alone.',
    source: src.panagioti,
  },
  {
    id: 'default.energy_flat',
    name: 'Energy flat after 3 weeks',
    enabled: true,
    when: [{ condition: 'checkin.energy_trend', params: { direction: 'flat', weeks: 3, below: 7 } }],
    then: [
      { action: 'require_review_step', params: { stepId: 'cut-one-more', label: 'Cut one more commitment' } },
      { action: 'banner', params: { tone: 'amber', text: 'Energy hasn’t moved in three weeks. In your next review, choose one more commitment to cut.' } },
    ],
    why: 'If a lighter load hasn’t helped yet, the load is probably still too high.',
    source: src.panagioti,
  },
  {
    id: 'default.energy_worse',
    name: 'Energy lower after 3 weeks',
    enabled: true,
    when: [{ condition: 'checkin.energy_trend', params: { direction: 'down', weeks: 3 } }],
    then: [{ action: 'open_get_help', params: {} }],
    why: 'No improvement, or a decline, after a few weeks of a lighter plan is a reason to talk to someone, not to try harder.',
    source: 'Bianchi 2021',
  },
  {
    id: 'default.low_sleep_red_flag',
    name: 'Under 6 hours of sleep on most nights',
    enabled: true,
    when: [{ condition: 'checkin.low_sleep_most_nights', params: { hours: 6 } }],
    then: [{ action: 'open_get_help', params: {} }],
    why: 'Sleeping under about 6 hours most nights, with the chance to sleep, is worth talking through with a doctor or counselor.',
    source: 'AASM 2016',
  },
];

export default defineModule({
  id: 'rules',
  name: 'Rules',
  description: 'If-then rules stored as data: the actions they can take, the defaults, when they run, and the alerts on Today.',
  nav: [{ id: 'rules', label: 'Rules', icon: 'Workflow', path: '/rules', section: 'secondary', order: 70, work: false }],
  widgets: [{ id: 'alerts', slot: 'today.banner', order: 10 }],
  rules: { actions: ruleActions, defaults: defaultRules },
  jobs: [{
    id: 'evaluate-morning',
    at: () => ['07:00'],
    async run(ctx) { await evaluateRules(ctx); reopenGetHelp(ctx); },
  }],
  on: {
    'shutdown.completed': async (_p, ctx) => { await evaluateRules(ctx); },
    'checkin.submitted': async (_p, ctx) => { await evaluateRules(ctx); },
    'review.completed': async (_p, ctx) => { await evaluateRules(ctx); },
    // At wake: rules that need Get help come back each day they still hold.
    'day.started': async (_p, ctx) => { await evaluateRules(ctx); reopenGetHelp(ctx); },
    'rule.resolved': (_p, ctx) => syncFlags(ctx),
  },
  routes(r, ctx) {
    /** Active firings for the Today widget, minus Get help ones, with each rule's banner look. Hiding is per day and never touches the lock state. */
    r.get('/alerts', (c) => {
      const t = today();
      const banners = kvGet<Record<string, BannerStyle>>(ctx.db, BANNERS, {});
      const hidden = kvGet<Record<string, string>>(ctx.db, HIDDEN, {});
      return c.json(ctx.rules.active()
        .filter((f) => !f.actions.includes('open_get_help') && hidden[f.id] !== t)
        .map((f) => ({
          id: f.id, ruleId: f.ruleId, ruleName: f.ruleName, detail: f.detail, subject: f.subject ?? null,
          why: f.why ?? null, source: f.source ?? null, firedAt: f.firedAt,
          tone: banners[f.ruleId]?.tone ?? 'amber', text: banners[f.ruleId]?.text || null,
        })));
    });
    r.post('/alerts/:id/hide', (c) => {
      const t = today();
      const hidden = kvGet<Record<string, string>>(ctx.db, HIDDEN, {});
      const next = Object.fromEntries(Object.entries(hidden).filter(([, d]) => d === t));
      next[c.req.param('id')] = t;
      kvSet(ctx.db, HIDDEN, next);
      return c.json({ ok: true });
    });
  },
});
