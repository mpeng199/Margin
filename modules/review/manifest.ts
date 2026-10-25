/**
 * review — the weekly review (SPEC 4.9): nine guided steps, an autosaved draft, and one change set
 * for everything that has to reach Todoist or Google Calendar. Sunday afternoon, about 45 minutes.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { kvGet, kvSet } from '../../src/core/kv';
import { addDays, at, today, weekday, weekStartOf, type ISODate } from '../../src/core/time';
import { buildChanges, firstWorkDay } from './changes';
import {
  autoStats, checkinsDue, deadlineItems, offdayPanel, priorityOptions, projectsPanel, requiredSteps, triageList,
} from './context';
import { createReviewService, type ReviewService } from './service';
import { safe, settingsSchema } from './types';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slot = z.object({ start: z.string(), end: z.string() });
const priority = z.object({
  text: z.string().max(200),
  ref: z.object({ type: z.enum(['project', 'task']), id: z.string() }).nullable().default(null),
  block: z.boolean().default(false),
  slot: slot.nullable().default(null),
});
const triage = z.object({
  decision: z.enum(['move', 'first', 'delegate', 'drop']),
  date: iso.optional(), owner: z.string().max(80).optional(), reason: z.string().max(200).optional(),
});
/** The parts of a draft the page may write directly. The rest (required, proposed, check-ins) goes through the routes below. */
const patchSchema = z.object({
  step: z.number().int().optional(),
  done: z.record(z.string(), z.boolean()).optional(),
  scores: z.object({ energy: z.number().nullable(), dread: z.number().nullable(), effective: z.number().nullable() }).partial().optional(),
  priorities: z.array(priority).max(3).optional(),
  notes: z.string().max(4000).optional(),
  summary: z.string().max(8000).optional(),
  decisions: z.object({
    triage: z.record(z.string(), triage),
    deadlines: z.record(z.string(), z.string().max(300)),
    offday: z.object({ date: iso.nullable(), confirmed: z.boolean(), moves: z.record(z.string(), iso) }),
  }).partial().optional(),
});
const statusBody = z.object({
  projectId: z.string(), status: z.enum(['core', 'maintain', 'pause', 'drop']), restartDate: iso.optional(),
  maintenance: z.object({ action: z.string(), capMin: z.number(), told: z.string() }).optional(),
});

const ai = (ctx: Ctx) => ctx.maybe<any>('ai');
const aiOn = (ctx: Ctx) => !!safe(() => ai(ctx)?.enabled?.(), false);

/** Run projects.setStatus and remember the change in the draft. Errors from its validation reach the page as-is. */
async function setProjectStatus(ctx: Ctx, svc: ReviewService, b: z.infer<typeof statusBody>) {
  const projects = ctx.maybe<any>('projects');
  if (!projects) throw Object.assign(new Error('Projects are turned off.'), { status: 409 });
  const before = projects.get(b.projectId);
  if (!before) throw Object.assign(new Error('Project not found.'), { status: 404 });
  try {
    const opts: Record<string, unknown> = {};
    if (b.restartDate) opts.restartDate = b.restartDate;
    if (b.maintenance) opts.maintenance = b.maintenance;
    await projects.setStatus(b.projectId, b.status, opts);
  } catch (e: any) { throw Object.assign(new Error(e?.message ?? 'That status change was refused.'), { status: 409 }); }
  const d = svc.getDraft(svc.week().weekStart);
  svc.patch({ decisions: { ...d.decisions, projectChanges: [...d.decisions.projectChanges, { projectId: b.projectId, name: before.name, from: before.status, to: b.status, at: new Date().toISOString() }] } as any });
  return projects.get(b.projectId);
}

export default defineModule({
  id: 'review',
  name: 'Weekly review',
  description: 'A guided 45-minute review each Sunday: scores, carry-overs, three priorities, project statuses, deadlines. One change set at the end.',
  defaultEnabled: true,
  requires: ['day', 'todoist'],
  settings: settingsSchema,
  migrations: [
    `CREATE TABLE reviews (
       week_start TEXT PRIMARY KEY,
       scores TEXT NOT NULL DEFAULT '{}',
       priorities TEXT NOT NULL DEFAULT '[]',
       state TEXT NOT NULL DEFAULT '{}',
       notes TEXT NOT NULL DEFAULT '',
       summary TEXT NOT NULL DEFAULT '',
       change_set_id TEXT,
       started_at TEXT,
       updated_at TEXT,
       completed_at TEXT,
       sleep_avg_min INTEGER,
       stop_breaks INTEGER
     );
     CREATE INDEX reviews_done ON reviews(completed_at);`,
  ],
  service: createReviewService,
  nav: [{ id: 'review', label: 'Review', icon: 'ClipboardCheck', path: '/review', section: 'main', order: 30, work: true }],
  widgets: [{ id: 'due', slot: 'today.banner', order: 20 }],
  emits: ['review.completed'],
  init(ctx) {
    // review.missed only counts review days after the app started tracking.
    if (kvGet<string | null>(ctx.db, 'review.since', null) === null) kvSet(ctx.db, 'review.since', today());
  },
  notifications(ctx, date) {
    const svc = ctx.service<ReviewService>('review');
    const s = svc.settings();
    if (weekday(date) !== s.reviewDay) return [];
    const weekStart = weekStartOf(date, ctx.service<any>('day').settings().weekStart);
    if (svc.isCompleted(weekStart)) return [];
    return [{
      key: `review.due:${weekStart}`, at: at(date, s.reviewTime), category: 'work', path: '/review',
      title: 'Weekly review', body: `About ${s.durationMin} minutes: scores, carry-overs, three priorities.`,
    }];
  },

  routes(r, ctx) {
    const review = () => ctx.service<ReviewService>('review');
    r.get('/current', (c) => c.json(review().current()));
    r.get('/history', (c) => c.json(review().history()));
    r.get('/scores', (c) => c.json(review().scores(Math.min(52, Math.max(1, Number(c.req.query('weeks') ?? 8))))));
    r.get('/slots', (c) => c.json(review().slots(c.req.query('minutes') ? Number(c.req.query('minutes')) : undefined)));

    /** Everything the panels show, read from local caches. */
    r.get('/context', (c) => {
      const svc = review();
      const w = svc.week();
      const t = today();
      return c.json({
        ...w, today: t,
        stats: autoStats(ctx, w.lookback.from, w.lookback.to),
        previous: svc.previous(w.weekStart),
        triage: triageList(ctx, w.lookback.from),
        options: priorityOptions(ctx),
        slots: svc.slots(),
        firstDay: firstWorkDay(ctx, w.ahead.from),
        projects: projectsPanel(ctx),
        checkins: checkinsDue(ctx),
        deadlines: deadlineItems(ctx, t, addDays(t, 21)),
        required: requiredSteps(ctx),
        rules: ctx.rules.active(),
        offday: offdayPanel(ctx),
        ai: aiOn(ctx),
        available: Object.fromEntries(['plan', 'projects', 'delegation', 'checkin', 'shutdown', 'offday', 'rituals', 'phases'].map((id) => [id, !!ctx.maybe(id)])),
      });
    });

    r.put('/draft', async (c) => c.json(review().patch(patchSchema.parse(await c.req.json()))));

    r.post('/finish', async (c) => c.json(await review().finish()));

    r.post('/summary', async (c) => {
      const svc = review();
      const d = svc.getDraft(svc.week().weekStart);
      let text = '', changeSetId: string | null = null, source: 'claude' | 'margin' = 'margin', aiError: string | null = null;
      if (aiOn(ctx)) {
        try {
          const out = await ai(ctx).run('weekly_summary', { weekStart: d.weekStart });
          text = String(out?.text ?? '').trim();
          if (!text) throw new Error('Claude returned no text.');
          changeSetId = out.changeSetId ?? null;
          source = 'claude';
        } catch (e: any) { aiError = e?.message ?? 'Claude could not be reached.'; text = ''; }
      }
      if (!text) text = svc.plainSummary(d);
      svc.patch({ summary: text, summarySource: source, aiChangeSetId: changeSetId });
      return c.json({ text, changeSetId, source, aiError });
    });

    /** Inline project status change (step 4). projects.setStatus validates; its message is shown as-is. */
    r.post('/project-status', async (c) => c.json(await setProjectStatus(ctx, review(), statusBody.parse(await c.req.json()))));

    /** Log an owner check-in note through delegation (step 5). Saved immediately. */
    r.post('/checkin', async (c) => {
      const { functionId, note } = z.object({ functionId: z.string(), note: z.string().min(1).max(2000) }).parse(await c.req.json());
      const delegation = ctx.maybe<any>('delegation');
      if (!delegation) return c.json({ error: 'Delegation is turned off.' }, 409);
      await delegation.logCheckin(functionId, note.trim());
      const svc = review();
      const d = svc.getDraft(svc.week().weekStart);
      svc.patch({ decisions: { ...d.decisions, checkins: { ...d.decisions.checkins, [functionId]: note.trim() } } as any });
      return c.json({ ok: true });
    });

    /** Resolve a required step from a rule (step 7). `remove_maintain` pauses or drops one Maintain project. */
    r.post('/required/:id', async (c) => {
      const id = c.req.param('id');
      const step = requiredSteps(ctx).find((s) => s.id === id);
      if (!step) return c.json({ error: 'That step is not required right now.' }, 404);
      const svc = review();
      const b = z.object({ how: z.string().max(300).optional(), projectId: z.string().optional(), status: z.enum(['pause', 'drop']).optional(), restartDate: iso.optional() }).parse(await c.req.json());
      let how = (b.how ?? '').trim();
      if (id === 'remove_maintain') {
        const projects = ctx.maybe<any>('projects');
        const maintain: any[] = safe(() => (projects?.list() as any[]).filter((p) => p.status === 'maintain' && !p.archived), []) ?? [];
        if (maintain.length) {
          if (!b.projectId || !b.status) return c.json({ error: 'Pick the Maintain project to pause or drop.' }, 409);
          const target = maintain.find((p) => p.id === b.projectId);
          if (!target) return c.json({ error: 'Pick a project that is in Maintain.' }, 409);
          await setProjectStatus(ctx, svc, { projectId: b.projectId, status: b.status, restartDate: b.restartDate });
          how = `${b.status === 'pause' ? 'Paused' : 'Dropped'} ${target.name} (was Maintain)`;
        } else how ||= 'No Maintain item left to remove';
      } else if (!how) return c.json({ error: 'Say what you did.' }, 400);
      const d = svc.getDraft(svc.week().weekStart);
      svc.patch({ decisions: { ...d.decisions, required: { ...d.decisions.required, [id]: { how, projectId: b.projectId, at: new Date().toISOString() } } } as any });
      return c.json({ ok: true, how });
    });

    /**
     * Decide on a Proposed commitment (step 8). Activating needs something of equal size to pause or drop.
     * Uses projects.activate(id, tradeOffId, opts) when it exists; otherwise a setStatus pair.
     */
    r.post('/proposed/:id', async (c) => {
      const id = c.req.param('id');
      const b = z.object({
        action: z.enum(['activate', 'later']), tradeOffId: z.string().optional(),
        tradeOffStatus: z.enum(['pause', 'drop']).default('pause'), restartDate: iso.optional(),
      }).parse(await c.req.json());
      const svc = review();
      const projects = ctx.maybe<any>('projects');
      if (!projects) return c.json({ error: 'Projects are turned off.' }, 409);
      const p = projects.get(id);
      if (!p || p.status !== 'proposed') return c.json({ error: 'That commitment is not waiting for a decision.' }, 404);
      if (b.action === 'activate') {
        if (!b.tradeOffId) return c.json({ error: 'Pick something of equal size to pause or drop first.' }, 409);
        const phase = safe(() => ctx.maybe<any>('phases')?.canAddCommitment?.() as { allowed: boolean; reason?: string } | undefined, undefined);
        if (phase && !phase.allowed) return c.json({ error: phase.reason ?? 'Nothing gets added back yet.' }, 409);
        const give = projects.get(b.tradeOffId);
        if (!give || give.status === 'proposed' || give.archived) return c.json({ error: 'Pick an active project to trade off.' }, 409);
        try {
          if (typeof projects.activate === 'function') await projects.activate(id, b.tradeOffId, { tradeOffStatus: b.tradeOffStatus, restartDate: b.restartDate });
          else {
            await projects.setStatus(b.tradeOffId, b.tradeOffStatus, b.restartDate ? { restartDate: b.restartDate } : {});
            try { await projects.setStatus(id, give.status === 'maintain' ? 'maintain' : 'core', {}); }
            catch (e) { await projects.setStatus(b.tradeOffId, give.status, {}).catch(() => {}); throw e; }
          }
        } catch (e: any) { return c.json({ error: e?.message ?? 'That change was refused.' }, 409); }
        const now = new Date().toISOString();
        const d = svc.getDraft(svc.week().weekStart);
        svc.patch({ decisions: { ...d.decisions,
          projectChanges: [...d.decisions.projectChanges, { projectId: b.tradeOffId, name: give.name, from: give.status, to: b.tradeOffStatus, at: now }, { projectId: id, name: p.name, from: 'proposed', to: 'active', at: now }],
          proposed: { ...d.decisions.proposed, [id]: { action: 'activate', tradeOffId: b.tradeOffId, at: now } } } as any });
      } else {
        const d = svc.getDraft(svc.week().weekStart);
        svc.patch({ decisions: { ...d.decisions, proposed: { ...d.decisions.proposed, [id]: { action: 'later', at: new Date().toISOString() } } } as any });
      }
      return c.json({ ok: true });
    });
  },

  rules: {
    conditions: [
      {
        id: 'review.dread_high',
        label: 'Dread stays high',
        description: 'Dread or cynicism scored at or above a level in each of the last N weekly reviews.',
        params: z.object({ score: z.number().min(0).max(10).default(7), weeks: z.number().int().min(1).max(8).default(2) }),
        evaluate(ctx, p) {
          const rows = ctx.service<ReviewService>('review').recent(p.weeks);
          const met = rows.length >= p.weeks && rows.every((x) => x.dread >= p.score);
          return { met, detail: met ? `Dread was ${rows.map((x) => x.dread).join(' and ')} in the last ${p.weeks} weekly review${p.weeks === 1 ? '' : 's'}.` : undefined };
        },
      },
      {
        id: 'review.energy_trend',
        label: 'Energy trend',
        description: 'Energy rose, stayed flat (within 1 point) or fell across the last N weekly reviews.',
        params: z.object({ direction: z.enum(['up', 'flat', 'down']).default('up'), weeks: z.number().int().min(2).max(8).default(3) }),
        evaluate(ctx, p) {
          const e = ctx.service<ReviewService>('review').recent(p.weeks).map((x) => x.energy);
          if (e.length < p.weeks) return { met: false };
          const diffs = e.slice(1).map((v, i) => v - e[i]);
          const net = e[e.length - 1] - e[0];
          const met = p.direction === 'up' ? net > 0 && diffs.every((d) => d >= 0)
            : p.direction === 'down' ? net < 0 && diffs.every((d) => d <= 0)
            : Math.max(...e) - Math.min(...e) <= 1;
          return { met, detail: met ? `Energy over the last ${p.weeks} reviews: ${e.join(', ')}.` : undefined };
        },
      },
      {
        id: 'review.stable_weeks',
        label: 'Stable weekly scores',
        description: 'The last N reviews have dread under 7 and no week worse than the one before by 2 points or more.',
        params: z.object({ n: z.number().int().min(2).max(12).default(3) }),
        evaluate(ctx, p) {
          const met = ctx.service<ReviewService>('review').stableWeeks(p.n);
          return { met, detail: met ? `The last ${p.n} weekly scores are stable.` : undefined };
        },
      },
      {
        id: 'review.missed',
        label: 'Weekly review missed',
        description: 'The most recent review day passed without that week’s review being finished.',
        params: z.object({}),
        evaluate(ctx) {
          const m = ctx.service<ReviewService>('review').missed();
          return { met: m.met, detail: m.met ? `The weekly review for the week of ${m.weekStart} was not done.` : undefined };
        },
      },
    ],
  },

  claude: {
    context(ctx) {
      const svc = ctx.service<ReviewService>('review');
      const w = svc.week();
      return { weekStart: w.weekStart, reviewDue: svc.isDue(), lastReviewed: svc.history()[0]?.weekStart ?? null };
    },
    tools: [
      {
        name: 'get_week_summary',
        description: 'The weekly review for a week: stop breaks, carry-overs, decisions, priorities and project changes. Sleep and the energy/dread/effective scores are included only if the person shares wellbeing data with Claude.',
        kind: 'read',
        input: z.object({ date: z.string().optional().describe('Any date in the week; defaults to the current week.') }),
        run(ctx, i) {
          const svc = ctx.service<ReviewService>('review');
          const w = svc.week(i.date);
          const d = svc.getDraft(w.weekStart);
          const stats = autoStats(ctx, w.lookback.from, w.lookback.to);
          const t = Object.values(d.decisions.triage);
          const n = (k: string) => t.filter((x) => x.decision === k).length;
          const share = !!ctx.settings.get<any>('ai')?.shareWellbeing;
          return {
            weekStart: w.weekStart, lookback: w.lookback, finished: !!d.completedAt,
            stopBreaks: stats.stopBreaks, stopBreakDays: stats.breakDays, shutdownDays: stats.shutdownDays,
            carryOvers: triageList(ctx, w.lookback.from).slice(0, 20).map((x) => ({ task: x.content, project: x.projectName, carryCount: x.carryCount })),
            decisions: { moved: n('move'), madeFirst: n('first'), delegated: n('delegate'), dropped: n('drop') },
            priorities: d.priorities.map((p) => p.text).filter(Boolean),
            projectChanges: d.decisions.projectChanges.map((c) => `${c.name}: ${c.from} to ${c.to}`),
            ...(share
              ? { scores: d.scores, previousScores: svc.previous(w.weekStart), sleepAvgMin: stats.sleepAvgMin, sleepNights: stats.sleepNights, sleepTargetMin: stats.sleepTargetMin }
              : { wellbeingShared: false }),
          };
        },
      },
      {
        name: 'propose_review_changes',
        description: 'Propose the external changes of a weekly review for approval: move a task, make it the first thing next week, delegate it, drop it (never deletes), move a task off the off-day, or add a deep-work block. Blocks must end before the hard stop.',
        kind: 'propose',
        input: z.object({
          changes: z.array(z.object({
            action: z.enum(['move', 'first', 'delegate', 'drop', 'offday_move', 'block']),
            taskId: z.string().optional(), date: z.string().optional(), owner: z.string().optional(), reason: z.string().optional(),
            title: z.string().optional(), start: z.string().optional(), end: z.string().optional(),
          })),
        }),
        run(ctx, i) {
          const svc = ctx.service<ReviewService>('review');
          const w = svc.week();
          const task = (c: any) => { if (!c.taskId) throw new Error(`"${c.action}" needs a taskId.`); return c.taskId as string; };
          return buildChanges(ctx, {
            weekStart: w.weekStart, firstDay: firstWorkDay(ctx, w.ahead.from),
            triage: i.changes.filter((c: any) => ['move', 'first', 'delegate', 'drop'].includes(c.action))
              .map((c: any) => ({ taskId: task(c), decision: c.action, date: c.date, owner: c.owner, reason: c.reason })),
            offdayMoves: i.changes.filter((c: any) => c.action === 'offday_move').map((c: any) => ({ taskId: task(c), date: c.date as ISODate })),
            blocks: i.changes.filter((c: any) => c.action === 'block').map((c: any) => {
              if (!c.title || !c.start || !c.end) throw new Error('A block needs title, start and end.');
              return { title: c.title, start: c.start, end: c.end, ref: c.taskId, description: 'Proposed for the weekly review.' };
            }),
          });
        },
      },
    ],
  },
});
