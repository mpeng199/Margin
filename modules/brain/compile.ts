/**
 * What the brain knows from the rest of Margin. Each generator reads one module through its service and
 * returns Markdown for the read-only “From Margin” part of a note. A module that is off returns null,
 * which leaves its notes as they were. Sleep, energy, ratings and the weekly summary (which quotes them)
 * go in the separate wellbeing text that Claude only sees when sharing is on.
 */
import type { Ctx } from '../../src/core/types';
import { kvGet } from '../../src/core/kv';
import { today, addDays, fromISO, dateOf, fmtTime, fmtDuration, type ISODate } from '../../src/core/time';
import { cleanTitle, titleKey } from './parse';
import type { BrainService, DayNote, GenNote, Generated } from './service';

const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS: Record<string, string> = { core: 'Core', maintain: 'Maintain', pause: 'Paused', drop: 'Dropped', proposed: 'Proposed' };

/** '18:45' → '6:45 PM' (plain formatting: no date, so no DST question). */
export const hm = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export const dayList = (days: number[]) => {
  const d = [...new Set(days)].sort((a, b) => a - b).join();
  if (d === '1,2,3,4,5,6,7') return 'every day';
  if (d === '1,2,3,4,5') return 'weekdays';
  if (d === '6,7') return 'weekends';
  return d.split(',').filter(Boolean).map((x) => SHORT[Number(x)]).join(', ');
};
/** 'Mon, Nov 2', with the year when it isn't this year. */
const md = (date: ISODate) => fromISO(`${date}T12:00:00`).toFormat(date.slice(0, 4) === today().slice(0, 4) ? 'EEE, MMM d' : 'EEE, MMM d, yyyy');
const link = (title: string) => `[[${cleanTitle(title)}]]`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const blocks = (...parts: (string | string[] | false | null | undefined)[]) =>
  parts.filter((p) => p && (!Array.isArray(p) || p.length)).map((p) => (Array.isArray(p) ? p.join('\n') : p)).join('\n\n');
const one = (source: string, title: string, auto: string, wellbeing?: string, pinned?: boolean): Generated =>
  ({ prefix: source, notes: [{ source, title, area: 'Me', auto, ...(wellbeing !== undefined ? { wellbeing } : {}), ...(pinned ? { pinned } : {}) }] });

function taskLines(tasks: any[], max = 15): string[] {
  const open = tasks.filter((t) => !t.checked)
    .sort((a, b) => (a.due?.date ?? '9999').localeCompare(b.due?.date ?? '9999') || a.priority - b.priority);
  const lines = open.slice(0, max).map((t) => `- ${t.content}${t.due ? ` (due ${md(t.due.date)})` : ''}${t.meta?.mustDoDate ? ', must-do' : ''}`);
  if (open.length > max) lines.push(`- …and ${open.length - max} more in Todoist`);
  return lines;
}

// ---------------------------------------------------------------- Me
function routine(ctx: Ctx): Generated | null {
  const day = ctx.maybe<any>('day');
  if (!day) return null;
  const st = day.settings();
  const a = day.anchors(today());
  const review = ctx.maybe('review') ? ctx.settings.get<{ reviewDay: number; reviewTime: string }>('review') : null;
  const fixed: any[] = st.fixedBlocks ?? [];
  return one('margin:routine', 'Routine', blocks(
    ['## Anchors', `- Wake: ${fmtTime(a.wake)}`,
      `- Lights-out: ${fmtTime(a.lightsOut)} (${fmtDuration(st.sleepNeedMin)} of sleep plus ${st.fallAsleepMin} min to fall asleep)`,
      `- Hard stop: ${fmtTime(a.hardStop)} (${st.windDownMin} min screen-free before lights-out)`],
    ['## Week', `- School days: ${dayList(st.schoolDays)}`, `- Off-day: ${DAY[st.offDay]}`,
      ...(review ? [`- Weekly review: ${DAY[review.reviewDay]} at ${hm(review.reviewTime)}`] : [])],
    fixed.length > 0 && ['## Fixed blocks', ...fixed.map((b) => `- ${b.label}: ${dayList(b.days)}, ${hm(b.start)}–${hm(b.end)}`)],
  ));
}

function recovery(ctx: Ctx): Generated | null {
  const phases = ctx.maybe<any>('phases');
  const rules = ctx.rules.list().filter((r) => r.enabled && r.available);
  if (!phases && !rules.length) return null;
  const p = phases?.current();
  return one('margin:recovery', 'Recovery plan', blocks(
    p && [`## Phase`, `${cap(p.phase)}, week ${p.week}, started ${md(p.startDate)}.`, ...p.rules.map((r: string) => `- ${r}`)],
    rules.length > 0 && ['## Rules you set', ...rules.map((r) => `- **${r.name}**${r.why ? `: ${r.why}` : ''}${r.source ? ` (${r.source})` : ''}`)],
  ));
}

function habits(ctx: Ctx): Generated | null {
  const h = ctx.maybe<any>('habits');
  if (!h) return null;
  const list = h.list().filter((x: any) => x.state !== 'archived');
  const pct = (v: number | null) => (v == null ? 'not enough days yet' : `${v}%`);
  return one('margin:habits', 'Habits', list.length
    ? list.map((x: any) => [`- **${x.name}**, ${x.state === 'formation' ? `forming${x.day ? ` (day ${x.day})` : ''}` : 'automatic'}: ${x.cue}`,
      ...(x.why ? [`  Why: ${x.why}`] : []), `  Last 2 weeks ${pct(x.consistency2w)}, last 4 weeks ${pct(x.consistency4w)}.`].join('\n')).join('\n')
    : 'No habits yet.');
}

function rituals(ctx: Ctx): Generated | null {
  const r = ctx.maybe<any>('rituals');
  if (!r) return null;
  return one('margin:rituals', 'Rituals', blocks(...r.list().map((x: any) => [`## ${x.name}`, ...x.steps.map((s: any, i: number) => `${i + 1}. ${s.label}`)])));
}

function leisure(ctx: Ctx): Generated | null {
  const o = ctx.maybe<any>('offday');
  if (!o) return null;
  const items = o.leisure();
  return one('margin:leisure', 'Leisure list', items.length
    ? blocks('Things you do for their own sake, after shutdown and on the off-day.', items.map((x: any) => `- ${x.title}`))
    : 'Nothing on the leisure list yet. It holds things you would do even if they produced nothing.');
}

function scripts(ctx: Ctx): Generated | null {
  const d = ctx.maybe<any>('delegation');
  if (!d) return null;
  const list = d.scripts();
  return one('margin:scripts', 'Saying no', list.length
    ? blocks(...list.map((x: any) => [`## ${x.title}`, ...x.body.split('\n').map((l: string) => `> ${l}`)]))
    : 'No scripts yet.');
}

function training(ctx: Ctx): Generated | null {
  const t = ctx.maybe<any>('training');
  if (!t) return null;
  const list: any[] = t.sessions(addDays(today(), -55), today());
  if (!list.length) return { prefix: 'margin:training', notes: [] };
  const recent = [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const minutes = list.reduce((n, s) => n + s.minutes, 0);
  return one('margin:training', 'Training', blocks(
    `${list.length} session${list.length === 1 ? '' : 's'} in the last 8 weeks, ${fmtDuration(minutes)} in all.`,
    ['## Recent', ...recent.map((s) => `- ${md(s.date)}: ${cap(s.kind)}, ${s.minutes} min, effort ${s.rpe} of 10${s.note ? `. ${s.note}` : ''}`)],
  ), blocks(recent.filter((s) => s.soreness != null || s.dreaded).map((s) => `- ${md(s.date)}:${s.soreness != null ? ` soreness ${s.soreness} of 10` : ''}${s.dreaded ? ' (dreaded it)' : ''}`)));
}

function wellbeing(ctx: Ctx): Generated | null {
  const c = ctx.maybe<any>('checkin');
  if (!c) return null;
  const entries: any[] = c.entries(addDays(today(), -27), today());
  const base = c.baseline();
  if (!entries.length && !base) return { prefix: 'margin:wellbeing', notes: [] };
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sleep = entries.map((e) => e.sleepMin);
  return one('margin:wellbeing', 'Sleep and energy',
    'Sleep, energy and check-in ratings from Margin. This part stays on your Mac unless you turn on sharing in Settings → Claude.',
    blocks(
      entries.length > 0 && ['## Last 4 weeks', `- Check-ins: ${entries.length}`, `- Average sleep: ${fmtDuration(avg(sleep))}`,
        `- Nights under 7 h: ${sleep.filter((m) => m < 420).length}`, `- Average energy: ${avg(entries.map((e) => e.energy)).toFixed(1)} of 10`],
      base && ['## Baseline', `- Bedtime ${hm(base.bedtime)}, wake ${hm(base.wakeTime)}${base.caffeineTime ? `, last caffeine ${hm(base.caffeineTime)}` : ''}`,
        `- Energy ${base.energy}, dread ${base.dread}, effective ${base.effective} (0–10)`],
    ));
}

// ---------------------------------------------------------------- Projects and people
function projects(ctx: Ctx): Generated | null {
  const pr = ctx.maybe<any>('projects');
  if (!pr) return null;
  const td = ctx.maybe<any>('todoist'), del = ctx.maybe<any>('delegation'), focus = ctx.maybe<any>('focus');
  const t0 = today();
  const deadlines: any[] = pr.deadlines(t0, addDays(t0, 90));
  const logs: any[] = focus?.timeLogs({ from: addDays(t0, -27), to: t0 }) ?? [];
  const notes: GenNote[] = pr.list().map((p: any) => {
    const m = p.maintenance;
    const minutes = logs.filter((l) => l.projectId === p.id).reduce((n, l) => n + l.minutes, 0);
    const tasks: any[] = td && p.todoist ? td.tasks(p.todoist.type === 'label' ? { label: p.todoist.name } : { projectId: p.todoist.id }) : [];
    const fns: any[] = del?.functions(p.id) ?? [];
    const waiting: any[] = del?.waiting(p.id) ?? [];
    const dl = deadlines.filter((d) => d.projectId === p.id);
    const own = String(pr.notes(p.id) ?? '').trim();
    return {
      source: `margin:project:${p.id}`, title: p.name, area: 'Projects',
      auto: blocks(
        [`**Status:** ${p.archived ? 'Archived (data kept)' : STATUS[p.status] ?? p.status}${p.isSchool ? ', school' : ''}`,
          ...(p.purpose ? [`**Purpose:** ${p.purpose}`] : []), ...(p.goal ? [`**Goal:** ${p.goal}`] : []),
          ...(m ? [`**Maintenance line:** ${m.action}, up to ${m.capMin} min a week${m.told ? `. Told: ${m.told}` : ''}`] : []),
          ...(p.restartDate ? [`**Restarts:** ${md(p.restartDate)}`] : []),
          ...(p.weeklyBudgetMin ? [`**Weekly budget:** ${fmtDuration(p.weeklyBudgetMin)}`] : []),
          ...(minutes ? [`**Focus time, last 4 weeks:** ${fmtDuration(minutes)}`] : [])].join('  \n'),
        dl.length > 0 && ['## Coming up', ...dl.slice(0, 12).map((d) => `- ${md(d.date)}: ${d.title}${d.kind === 'deadline' ? ' (deadline)' : ''}`)],
        tasks.length > 0 && ['## Open tasks', ...taskLines(tasks)],
        fns.length > 0 && ['## Delegated', ...fns.map((f) => `- ${f.name}: ${f.owner ? link(f.owner) : 'no owner yet'}, next check-in ${md(f.nextCheckin)}`)],
        waiting.length > 0 && ['## Waiting on', ...waiting.map((w) => `- ${w.what}: ${link(w.who)}, since ${md(w.since)}${w.due ? `, due ${md(w.due)}` : ''}`)],
        own && ['## Notes from the project tab', own],
      ),
    };
  });
  return { prefix: 'margin:project:', notes };
}

/** Todoist projects that aren't Margin project tabs still get a note, so every list lives somewhere in the brain. */
function todoistProjects(ctx: Ctx): Generated | null {
  const td = ctx.maybe<any>('todoist');
  if (!td) return null;
  const linked = new Set((ctx.maybe<any>('projects')?.list() ?? []).filter((p: any) => p.todoist?.type === 'project' && p.todoist.id).map((p: any) => p.todoist.id));
  const open: any[] = td.tasks({});
  const notes: GenNote[] = td.projects().filter((p: any) => !linked.has(p.id)).map((p: any) => {
    const tasks = open.filter((t) => t.projectId === p.id);
    return {
      source: `margin:todoist:${p.id}`, title: p.inbox ? 'Todoist inbox' : p.name, area: 'Projects',
      auto: blocks(`Todoist ${p.inbox ? 'inbox' : 'project'}, ${tasks.length} open task${tasks.length === 1 ? '' : 's'}.`, taskLines(tasks)),
    };
  });
  return { prefix: 'margin:todoist:', notes };
}

/** One note per person you delegate to or wait on. */
function people(ctx: Ctx): Generated | null {
  const del = ctx.maybe<any>('delegation');
  if (!del) return null;
  const pr = ctx.maybe<any>('projects');
  const pname = (id: string): string | null => pr?.get(id)?.name ?? null;
  const byKey = new Map<string, { name: string; fns: any[]; waiting: any[] }>();
  const person = (name: string) => {
    const k = titleKey(cleanTitle(name));
    if (!byKey.has(k)) byKey.set(k, { name: cleanTitle(name), fns: [], waiting: [] });
    return byKey.get(k)!;
  };
  for (const f of del.functions()) if (f.owner?.trim()) person(f.owner).fns.push(f);
  for (const w of del.waiting()) if (w.who?.trim()) person(w.who).waiting.push(w);
  const notes: GenNote[] = [...byKey.entries()].map(([k, p]) => {
    const checkins = p.fns.flatMap((f) => del.checkins({ functionId: f.id, limit: 5 }) as any[]).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    const proj = (id: string) => (pname(id) ? ` (${link(pname(id)!)})` : '');
    return {
      source: `margin:person:${k}`, title: p.name, area: 'People',
      auto: blocks(
        p.fns.length > 0 && ['## Owns', ...p.fns.map((f) => [`- ${f.name}${proj(f.projectId)}`,
          ...(f.decisionRights ? [`  Decides: ${f.decisionRights}`] : []), ...(f.goodEnough ? [`  Good enough: ${f.goodEnough}`] : []),
          `  Check-in ${f.cadence}, ${f.checkinMin} min${f.lastCheckin ? `, last ${md(f.lastCheckin)}` : ''}, next ${md(f.nextCheckin)}`].join('\n'))],
        checkins.length > 0 && ['## Check-in notes', ...checkins.map((n) => `- ${md(n.date)}: ${n.note}`)],
        p.waiting.length > 0 && ['## You’re waiting on', ...p.waiting.map((w) => `- ${w.what}${proj(w.projectId)}, since ${md(w.since)}${w.due ? `, due ${md(w.due)}` : ''}`)],
      ),
    };
  });
  return { prefix: 'margin:person:', notes };
}

// ---------------------------------------------------------------- Journal
function reviews(ctx: Ctx): Generated | null {
  const rv = ctx.maybe<any>('review');
  if (!rv) return null;
  const notes: GenNote[] = rv.history().map((h: any) => ({
    source: `margin:review:${h.weekStart}`, title: `Week of ${fromISO(`${h.weekStart}T12:00:00`).toFormat('MMM d, yyyy')}`, area: 'Journal',
    auto: blocks(
      `Weekly review, done ${md(dateOf(fromISO(h.completedAt)))}.${h.stopBreaks != null ? ` Stop breaks that week: ${h.stopBreaks}.` : ''}`,
      h.priorities.length > 0 && ['## Priorities', ...h.priorities.map((p: string, i: number) => `${i + 1}. ${p}`)],
    ),
    wellbeing: blocks(
      h.scores?.energy != null && `Energy ${h.scores.energy}, dread ${h.scores.dread ?? '–'}, effective ${h.scores.effective ?? '–'} (0–10).${h.sleepAvgMin != null ? ` Average sleep ${fmtDuration(h.sleepAvgMin)}.` : ''}`,
      h.summary?.trim() && ['## Summary', h.summary.trim()],
    ),
  }));
  return { prefix: 'margin:review:', notes };
}

/** One entry per day with something in it: done tasks, focus, habits, training, shutdown, notes you wrote. */
function journal(ctx: Ctx, days: number): DayNote[] {
  if (days <= 0) return [];
  const to = today(), from = addDays(to, -(days - 1));
  const group = <T>(xs: T[] | null | undefined, key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs ?? []) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); }
    return m;
  };
  const td = ctx.maybe<any>('todoist'), checkin = ctx.maybe<any>('checkin'), shutdown = ctx.maybe<any>('shutdown');
  const focus = ctx.maybe<any>('focus'), habits = ctx.maybe<any>('habits'), training = ctx.maybe<any>('training');
  const day = ctx.maybe<any>('day'), pr = ctx.maybe<any>('projects');

  const done = group<any>(td?.completions(from, to), (c) => c.date);
  const checks = new Map<string, any>((checkin?.entries(from, to) ?? []).map((e: any) => [e.date, e]));
  const nights = new Map<string, any>((shutdown?.history(from, to) ?? []).map((n: any) => [n.date, n]));
  const breaks = group<any>((shutdown ?? day)?.stopBreaks(from, to), (b) => b.date);
  const logs = group<any>(focus?.timeLogs({ from, to }), (l) => dateOf(fromISO(l.start)));
  const sessions = group<any>(training?.sessions(from, to), (s) => s.date);
  const habitDone = new Map<string, string[]>();
  for (const h of habits?.list() ?? []) for (const r of h.recent ?? []) if (r.status === 'done' && r.date >= from) habitDone.set(r.date, [...(habitDone.get(r.date) ?? []), h.name]);
  const written = group(ctx.db.all<{ title: string; created_at: string }>(
    'SELECT title, created_at FROM brain_notes WHERE deleted_at IS NULL AND date IS NULL AND source IS NULL AND created_at >= ? ORDER BY created_at', from), (r) => r.created_at.slice(0, 10));
  const opened = new Set(ctx.db.all<{ date: string }>('SELECT date FROM brain_notes WHERE date >= ? AND deleted_at IS NULL', from).map((r) => r.date));
  const projectName = (id: string) => pr?.get(id)?.name ?? td?.projects().find((p: any) => p.id === id)?.name ?? 'Other';

  const out: DayNote[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const c = checks.get(d), n = nights.get(d);
    const active = done.has(d) || !!c || !!n?.completedAt || breaks.has(d) || logs.has(d) || sessions.has(d) || habitDone.has(d) || written.has(d);
    if (!active && !opened.has(d)) { out.push({ date: d, auto: '', wellbeing: '' }); continue; }
    let sched: any[] = [];
    try { sched = (day?.timeline(d) ?? []).filter((it: any) => it.source !== 'fixed'); } catch { /* calendar unavailable */ }
    const focusBy = new Map<string, number>();
    for (const l of logs.get(d) ?? []) focusBy.set(projectName(l.projectId), (focusBy.get(projectName(l.projectId)) ?? 0) + l.minutes);
    const br = breaks.get(d)?.length ?? 0;
    out.push({
      date: d,
      auto: blocks(
        sched.length > 0 && ['## Schedule', ...sched.map((it) => `- ${it.allDay ? 'All day' : fmtTime(fromISO(it.start))}: ${it.title}`)],
        done.has(d) && ['## Done', ...done.get(d)!.map((x) => `- ${x.content}`)],
        focusBy.size > 0 && ['## Focus', ...[...focusBy].map(([name, min]) => `- ${name}: ${fmtDuration(min)}`)],
        habitDone.has(d) && ['## Habits', ...habitDone.get(d)!.map((h) => `- ${h}`)],
        sessions.has(d) && ['## Training', ...sessions.get(d)!.map((s) => `- ${cap(s.kind)}, ${s.minutes} min, effort ${s.rpe} of 10`)],
        (!!n?.completedAt || br > 0) && ['## Shutdown',
          ...(n?.completedAt ? [`Logged at ${fmtTime(fromISO(n.completedAt))}${n.minutesAfterStop > 0 ? `, ${fmtDuration(n.minutesAfterStop)} after the stop` : ''}.`] : []),
          ...(br ? [`Stop broken ${br === 1 ? 'once' : `${br} times`}.`] : [])],
        written.has(d) && ['## Notes written', ...written.get(d)!.map((x) => `- ${link(x.title)}`)],
      ),
      wellbeing: c ? `Slept ${fmtDuration(c.sleepMin)}, bed ${fmtTime(fromISO(c.bedtime))}, up ${fmtTime(fromISO(c.wakeTime))}. Energy ${c.energy} of 10.${c.napMin ? ` Nap ${c.napMin} min.` : ''}` : '',
    });
  }
  return out;
}

/** The front page: who this is about, and links to everything above. */
function about(ctx: Ctx, gens: Generated[]): Generated {
  const name: string | undefined = kvGet<any>(ctx.db, 'todoist.user', null)?.name;
  const all = gens.flatMap((g) => g.notes);
  const me = all.filter((n) => n.area === 'Me');
  const count = (prefix: string) => all.filter((n) => n.source.startsWith(prefix)).length;
  const phase = ctx.maybe<any>('phases')?.current();
  const day = ctx.maybe<any>('day');
  const a = day?.anchors(today());
  const lists = count('margin:project:') + count('margin:todoist:'), people = count('margin:person:');
  return one('margin:about', 'About me', blocks(
    `${name ? `${name}’s` : 'Your'} second brain. Margin keeps this part current; your own notes about yourself go in the space below it.`,
    [...(a ? [`- Wake ${fmtTime(a.wake)}, hard stop ${fmtTime(a.hardStop)}, lights-out ${fmtTime(a.lightsOut)}`] : []),
      ...(phase ? [`- Recovery phase: ${cap(phase.phase)}, week ${phase.week}`] : []),
      `- ${lists} project${lists === 1 ? '' : 's'} and lists${people ? `, ${people} ${people === 1 ? 'person' : 'people'}` : ''}`],
    me.length > 0 && ['## Start here', ...me.map((n) => `- ${link(n.title)}`)],
  ), undefined, true);
}

export function compile(ctx: Ctx, svc: BrainService) {
  const st = svc.settings();
  if (!st.compile) return { created: 0, updated: 0, removed: 0 };
  const gens: Generated[] = [];
  for (const g of [routine, recovery, habits, rituals, leisure, scripts, training, wellbeing, projects, todoistProjects, people, reviews]) {
    try { const out = g(ctx); if (out) gens.push(out); } catch (e: any) { ctx.log.warn(`brain: ${g.name} skipped`, e?.message); }
  }
  try { gens.push(about(ctx, gens)); } catch (e: any) { ctx.log.warn('brain: about skipped', e?.message); }
  let days: DayNote[] = [];
  try { days = journal(ctx, st.journalDays); } catch (e: any) { ctx.log.warn('brain: journal skipped', e?.message); }
  return svc.applyCompiled(gens, days);
}
