# Brief for module-building agents (parallel build, Oct 25 2026)

You are one of several agents building Margin's modules at the same time in ONE checkout
(/Users/michaelpeng/minimike). Read this whole file, then `CLAUDE.md`, `docs/SPEC.md` (your sections
are named in your prompt), `src/core/types.ts`, and these reference implementations:
`modules/day/manifest.ts` + `modules/day/web/index.tsx` (a complete module), `modules/todoist/manifest.ts`
(service + change-set appliers), `modules/_template/` (minimal), `web/src/ui/index.tsx` (UI kit),
`web/src/app/Page.tsx`, `tests/helpers.ts`, `tests/integration/google.test.ts` (test style).

## Hard rules for working in parallel

1. **Only create/edit files inside your own module folders** (`modules/<your ids>/`). Do not edit
   `src/core/**`, `web/src/**`, `tests/helpers.ts`, `package.json`, other agents' modules, or the
   CSS token files. If you truly need a core change, work around it inside your module and list the
   request in your final report.
2. **Do not run `npm install`** (concurrent installs corrupt node_modules). Available deps: react 19,
   wouter, @tanstack/react-query, cmdk, lucide-react (icons by PascalCase name via `<Icon name=…>`),
   react-markdown, luxon, zod 4, hono. If something else is essential, report it.
3. **Do not git commit.** The coordinator commits.
4. **Do not start servers on 7317/7318 or open browser panes.** Verify with tests. If you want to
   curl your routes against a live daemon, start one on your own port with your own data dir:
   `MARGIN_PORT=74xx MARGIN_DATA_DIR=.margin-<you> MARGIN_KEYCHAIN=memory MARGIN_NOTIFY=log MARGIN_DEV=1 node --no-warnings --import tsx src/daemon.ts` and stop it when done.
5. **Verify before reporting**: `npx vitest run modules/<id>` (all green), `npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'modules/<id>'`
   (no errors in your files; ignore others' in-progress errors), and a compile check that doesn't
   clobber the shared build: `npx vite build --config web/vite.config.ts --outDir /tmp/margin-build-<you> --emptyOutDir --logLevel error`.
6. Cross-module calls go through services (`ctx.maybe<T>('id')` when the other module is optional,
   so your module still works if theirs is off or not finished). Import other modules' **types** only
   (`import type`). Never import another module's runtime code except `modules/day/*`, `modules/todoist/manifest`
   (exports `parseDue`, types), `modules/google/manifest` (types, `toGEvent`).
7. Events you emit/consume must match the contract below. Add new events freely, document them in your
   manifest `emits`.

## Quality bar

- Calm, quiet, Apple-native UI (System Settings vernacular): `Section` + `Group` + `Item` lists,
  `Button` (Title Case labels), `Sheet` for short modal tasks, `Banner` for alerts, `Tag`, `Toggle`,
  `Segmented`, `Check` (round completion). Sentence-case body copy. No cheerleading, no guilt, no
  exclamation marks, no emoji. Misses are data. Every core rule shows a one-line why + source
  (`<Section why="… (Author Year)">` or `<Why source="Author Year">`).
- Colors: accent = action/selection; amber (`var(--amber)`, `Tag tone="amber"`) = needs a decision /
  over capacity; red = Get help and red flags ONLY; dusk = evening. Use tokens from
  `web/src/styles/tokens.css` (`--ink`, `--ink-2`, `--ink-3`, `--line`, `--bg-group`, `--s1..s10`,
  `--r-control`, `--r-group`, `--t-*`). Module CSS in `modules/<id>/web/<id>.css`, imported by the web file;
  prefix classes with your module id to avoid collisions.
- Keyboard-first: every primary action reachable by keyboard; add palette `commands`.
- Accessibility: labels on icon-only buttons, no color-only meaning, focus visible (the kit does this).
- Fast: Today renders from local cache; no network calls on render paths (services read SQLite).
- DST: all time math via `src/core/time.ts`; test scheduling/date logic across Sun Nov 1, 2026.
- Tests: at least one `modules/<id>/<id>.test.ts` per module covering the rules you enforce
  (use `testApp({ at: '2026-10-26T16:00:00-04:00', only: [...] })` — `only` always includes core
  modules; add the module ids you depend on).

## Service contracts (implement exactly; consumers rely on these names)

Types: `Task`, `TaskMeta` from `modules/todoist/manifest.ts`; `CalEvent` from `modules/google/manifest.ts`;
`LoadItem` from `modules/day/capacity.ts`; `ISODate` from `src/core/time.ts`.

**plan** (agent: daily loop)
```ts
loadFor(date): LoadItem[]            // planned work for a date: must-dos + homework + other tasks due that day (not paused projects); estimate = task.estimateMin ?? day.settings().defaultEstimateMin; paddedMin = pad(est, multiplier)
mustDos(date): Task[]                 // meta.mustDoDate === date; required first, then optional
homework(date): Task[]                // homework lane for a date
carryOver(date): Task[]               // planned for `date`, not completed (candidates at shutdown)
carry(taskIds: string[], toDate: ISODate, nextActions?: Record<string, string>): Promise<void> // ++carryCount, set mustDoDate/due, emits task.carried {taskId, count}
triageQueue(): Task[]                 // carryCount >= 3, awaiting a decision
triage(taskId, decision: 'first' | 'slot' | 'delegate' | 'drop', opts?: { slotStart?: string; owner?: string; reason?: string }): Promise<void>
```
**shutdown** (agent: shutdown) `completedAt(date): string | null` · `history(from, to)`
**rituals** (agent: shutdown) `get(id: 'shutdown' | 'weekly-review' | 'morning'): { id, name, steps: { id, label, why?, source? }[] }` · `list()` · editable
**offday** (agent: shutdown) `nextOffDay(): ISODate` · `leisure(): { id, title, test: boolean }[]`
**projects** (agent: projects)
```ts
list(): Project[]  // Project = { id, name, color, icon, status: 'core'|'maintain'|'pause'|'drop'|'proposed', isSchool, purpose, goal,
                   //   maintenance: { action, capMin, told } | null, restartDate, todoist: { type: 'project'|'label', id?: string, name?: string } | null,
                   //   calendarId: string | null, separation: 'hidden'|'milestones'|'everything', weeklyBudgetMin, order, archived, sizeMin? }
get(id): Project | null
filterForMain(events: CalEvent[]): CalEvent[]     // separation rule for Today/main calendar
projectForTask(task: Task): Project | null
isHidden(task: Task): boolean                      // in a paused/dropped project
activeNonSchool(): Project[]
deadlines(from: ISODate, to: ISODate): { projectId, projectName, title, date, kind: 'deadline'|'milestone' }[]
setStatus(id, status, opts?): Project              // validates maintenance line / restart date / WIP / lock
```
**delegation** (agent: projects) `functions(projectId?)` · `dueCheckins(date)` · `waiting(projectId?)` · `logCheckin(functionId, note)`
**checkin** (agent: recovery) `entry(date)` · `entries(from, to)` (each `{ date, bedtime, wakeTime, sleepMin, energy, extras }`) · `sleepNights(n)`
**phases** (agent: recovery) `current(): { phase: 'stabilize'|'recover'|'rebuild', week, startDate, rules: string[] }` · `canAddCommitment(): { allowed, reason? }`
**gethelp** (agent: recovery) `open(reason: string)` · `state()`
**rules module** (agent: recovery) registers generic actions on the core engine: `banner`, `notification`, `require_review_step` (pushes `{ id, label, ruleId }` into kv `review.requiredSteps`), `lock_add_projects` (projects check `ctx.rules.isActive('lock_add_projects')`), `ask_claude`, `create_task`, `open_get_help`.
**review** (agent: review) `current()` · `isDue()` · `history()` · `scores(weeks): { weekStart, energy, dread, effective, sleepAvgMin, stopBreaks }[]`
**focus** (agent: habits/focus) `timeLogs({ projectId?, from?, to? }): { projectId, taskId, start, end, minutes }[]` · `active()`
**habits** (agent: habits/focus) `list()` · `log(habitId, date, value)` · `consistency(habitId, days)`
**training** (agent: habits/focus) `sessions(from, to)`
**ai** (agent: claude) `enabled(): boolean` · `run(feature: 'plan_day'|'shutdown_actions'|'weekly_summary'|'draft_message'|'parse_capture'|'ask', input: any): Promise<{ text: string; changeSetId?: string; data?: any }>` · `usage()`

## Events (names are a contract)

`day.started {date}`, `mode.changed {date, mode, from}`, `stop.broken {date, view}`, `task.completed {taskId}`,
`task.carried {taskId, count}`, `task.triaged {taskId, decision}`, `task.dropped`, `plan.accepted {date}`,
`shutdown.started {date}`, `shutdown.completed {date, at}`, `checkin.submitted {date, sleepMin, energy}`,
`review.completed {weekStart}`, `focus.completed {projectId, taskId, minutes}`, `habit.logged {habitId, date}`,
`project.status_changed {id, from, to}`, `project.created {id}`, `rule.fired`, `gethelp.opened {reason}`,
`training.logged`, `offday.started {date}`.

## Widget slots and suggested order (so Today composes cleanly)

- `today.banner`: gethelp auto card (−10), phase banner (0), rule alerts (10), capacity warning (30, exists)
- `today.main`: morning check-in (0, only until submitted), must-dos (10), homework lane (20), carry-over triage (30),
  deep block (40), focus timer (50), habits due today (60), message slots (70)
- `today.side`: horizon (0, exists), capacity (10, exists), schedule (20, exists), off-day warning (30)
- `evening`: lights-out countdown (0), shutdown prompt (5), capture box (10), leisure list (20)
- `offday`: rendered on `/offday` by the offday module (leisure, capture, check-in, rest day note)

Widgets render nothing (`return null`) when they have nothing to say. Keep each widget to one `Section`.
