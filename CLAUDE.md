# Margin — notes for Claude Code sessions

Margin is a local, burnout-proof planner for macOS (see `docs/SPEC.md`, the source of truth, and
`docs/DECISIONS.md` for every judgment call). One person uses it every day to run their evenings, so
correctness, calm copy, and speed beat feature count.

## Repository and shipping

This folder is the clone of **github.com/mpeng199/Margin** and also the installed app (the launchd daemon
runs from here; Margin.app is in /Applications). To ship a change: commit and `git push origin main`.
Installed copies notice within an hour (`modules/update`) and offer **Update and Restart**, which runs
`scripts/update.mjs`: fast-forward pull → `npm install` if dependencies changed → build → `scripts/install.mjs
--relaunch`. Don't leave uncommitted edits to tracked files here: they block updates on purpose.
`.claude/skills/apple-design` is a git submodule (`git submodule update --init`).

## Run, test, build

```bash
./start.sh                      # install (first run) + start: builds web, installs launchd agent, opens Margin.app
npm run dev                     # daemon (tsx watch, data in .margin-dev/) + Vite on :5173 proxying /api
npm test                        # vitest: tests/** and modules/**/*.test.ts
npx tsc --noEmit -p tsconfig.json
npm run build                   # web → web/dist (the daemon serves it)
npm run e2e                     # Playwright click-through in Chrome (needs a running dev daemon)
npm run new-module -- <id> "<description>"   # scaffold a module (or use the /new-module skill)
```

Ports: the installed daemon is `127.0.0.1:7317`; `.claude/launch.json` runs a dev daemon on `7318`
with `MARGIN_DATA_DIR=.margin-dev`, in-memory Keychain, and log-only notifications.

## Architecture

```
src/core/          shell: boot, db (node:sqlite), registry, bus, scheduler, settings, keychain,
                   notify, changesets, rules, http (Hono), time (Luxon, DST-safe)
src/integrations/  todoist/ (client + mock), google/ (client, oauth, mock), claude/
src/daemon.ts      background process (launchd agent dev.minimike.margin)
src/mcp/           MCP server exposing Margin to Claude Code / Claude desktop
modules/<id>/      every feature: manifest.ts (+ server files), web/index.tsx, <id>.test.ts
web/src/           React shell: app/ (Shell, Page, Palette, ChangeSets, Settings), ui/ (kit), lib/
shell/             Electron main process (window, menus, tray, global capture, notifications)
scripts/           install.mjs (launchd + packaging), package-shell.mjs, make-icons.mjs, new-module.mjs
```

Processes: the **daemon** owns all data, sync, rules and scheduling and serves the web app.
**Margin.app** (Electron) is a thin window: vibrancy, menu bar, tray, global ⌃⌥Space capture, and
Notification Center delivery (the daemon pushes notifications over SSE; with no shell connected it
falls back to `osascript`).

## Module contract (read `src/core/types.ts`)

A module is a folder with `manifest.ts` default-exporting `defineModule({...})`. Discovery is
automatic (folders starting with `_` are skipped). The manifest declares: `settings` (zod, every field
defaulted → Settings UI is generated), `migrations` (append-only SQL), `service(ctx)` (API other
modules call via `ctx.service(id)` / `ctx.maybe(id)`), `routes` (mounted at `/api/<id>`), `jobs`
(`every` minutes or `at` wall-clock times), `notifications(ctx, date)` (planned per day, sent once per
key), `emits`/`on` (events), `rules` (conditions/actions/defaults), `claude` (tools + context),
`nav` and `widgets` (rendered by the web half).

The web half `modules/<id>/web/index.tsx` default-exports `defineWebModule({ id, routes, widgets,
commands, settingsPanel, sidebar })` from `@web/lib/module`. Widget slots: `today.banner`,
`today.main`, `today.side`, `evening`, `offday`. Routes with `work: true` and nav entries with
`work: true` are gated in Evening mode and on the off-day.

### Cross-module services (call through `ctx.maybe` when the module is optional)

| id | service highlights |
|---|---|
| `day` | `planningDate()`, `anchors(date)`, `state()`, `mode()`, `workAllowed()`, `capacity(date)`, `week()`, `timeline(date)`, `breakStop()`, `isOffDay()` |
| `todoist` | `sync()`, `tasks(filter)`, `task(id)`, `meta/setMeta(taskId)`, `close`, `reschedule` (keeps recurrence), `update`, `move`, `addLabel`, `comment`, `add`, `quickAdd`, `drop` (never deletes), `setEstimate`, `completions(from,to)`, `projects()`, `sections()`, `labels()`, `status()` |
| `google` | `sync()`, `eventsBetween(start,end,{calendarIds})`, `calendars()`, `ensureAppCalendar(kind, ref, summary, color)`, `appCalendarId`, `createEvent/patchEvent/deleteEvent` (app-owned only), `status()` |
| `plan` | `loadFor(date)` (feeds capacity), `mustDos(date)`, `homework(date)`, `carry(taskIds, toDate)`, `triageQueue()` |
| `shutdown` | `completedAt(date)` (Evening mode starts here or at the stop) |
| `rituals` | `get(id)` editable checklists: `shutdown`, `weekly-review`, `morning` |
| `projects` | `list()`, `get(id)`, `filterForMain(events)` (separation rule), `projectForTask(task)`, `isHidden(task)` (paused/dropped), `activeNonSchool()` |
| `checkin` | `entry(date)`, `entries(from,to)`, `sleepNights(n)` |
| `focus` | `timeLogs({projectId, from, to})`, `active()` |
| `gethelp` | `open(reason)` |
| `ai` | `enabled()`, `run(feature, input)`, `usage()` |
| `update` | `status()`, `check()` (git fetch + compare with installed.json), `apply()` (detached updater), `dismiss()` |

### Events (persisted in `events`, forwarded to the UI over SSE)

`day.started`, `mode.changed`, `stop.broken`, `day.late_night_declared`, `task.completed`,
`task.carried {taskId, count}`, `task.triaged`, `task.dropped`, `plan.accepted`, `shutdown.started`,
`shutdown.completed {date, at}`, `checkin.submitted {date, sleepMin, energy}`, `review.completed`,
`focus.completed {projectId, minutes}`, `habit.logged`, `project.status_changed`, `rule.fired`,
`gethelp.opened`, `todoist.synced`, `google.synced`, `changeset.proposed`, `changeset.applied`.

## Conventions

- **Never delete** Todoist tasks/projects or Google events Margin didn't create. Bulk writes and
  anything Claude initiates go through `ctx.changes.propose(...)`; single direct actions (checking off
  a task) apply immediately.
- **Time**: use `src/core/time.ts`. Dates are `'YYYY-MM-DD'` strings; moments are Luxon DateTimes in
  the user's zone; durations are elapsed minutes. Never `new Date(y, m, d)` math, never `86400000`.
  Tests pin the clock with `testApp({ at: '…' })` and must cover the Nov 1, 2026 DST change where
  time matters.
- **Copy**: direct and specific, no cheerleading, no guilt; misses are data. Every core rule shows
  a one-line why with its source (`<Section why=…>` or `<Why source=…>`). Buttons in Title Case,
  body in sentence case. Errors say what happened and what to do.
- **UI**: build from `@web/ui` (Section/Group/Item lists, Button, Sheet, Banner, Tag, Toggle, …) and
  tokens in `web/src/styles/tokens.css`. Module-specific CSS goes in `modules/<id>/web/<id>.css`
  imported by the module's web file, using the tokens. Accent = system accent; amber = needs a
  decision; red = Get help only; dusk = evening.
- **Data fetching**: `useApi(path)` / `useAction(method, path)`; every bus event refetches.
- **Secrets** only through `ctx.keychain`. Never log tokens.
- Tests: `tests/helpers.ts` → `testApp({ at, only })` boots a temp app with mocks.
- Design references: `.claude/skills/apple-design/` (HIG pages) and `docs/DESIGN.md`.
