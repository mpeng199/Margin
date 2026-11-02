# Handoff — Margin, Sunday Oct 25 2026

## Start it

```bash
cd ~/minimike && ./start.sh
```

Installs dependencies (first run), builds the app, installs the background service as a launchd agent
(starts at login, restarts if it dies), packages **Margin.app** into `/Applications` (registers itself as a
login item), and opens it. Safe to re-run. Margin opens into onboarding on mock data until you connect
accounts. The 10-minute account guide is in `README.md` → "Connect your accounts".

## What's built (SPEC phases 1–7)

- **Shell**: module registry (folders auto-discovered), SQLite with per-module migrations, zod settings with
  generated Settings UI, Keychain secrets, event bus + activity log, DST-safe tick scheduler, change sets
  with diff review, rules engine, local API with host/origin/CSRF guards, live updates over SSE.
- **Integrations**: Todoist API v1 (incremental sync, recurrence-preserving reschedule, close/drop without
  deletes, Free-plan limits), Google Calendar (loopback+PKCE OAuth, narrow scopes, sync tokens, 410 recovery,
  app-owned calendars only, reconnect banner on `invalid_grant`), faithful mock servers for both.
- **Daily loop**: anchors from wake time (DST-safe), capacity, Today, must-do cap of 3, homework lane, deep
  block, message slots, plan triage before accept, carry-over with forced triage at 3, urgency question,
  quick capture (⌘N in-app, ⌃⌥Space global), hard-stop notifications, 7-step shutdown, Evening mode,
  late-night exception, "I'm breaking my stop" logging.
- **Projects as tabs**: sidebar tabs with color/icon, overview, Todoist tasks, Gantt timeline (week → semester,
  drag with review), project calendar views, people/delegation, markdown notes, log; one Google calendar per
  project; separation rule in Today and the main calendar; statuses, WIP limit, yes-requires-a-no, templates.
- **Recovery**: morning check-in + sleep rules, off-day mode + leisure list, weekly review producing one
  change set for Todoist + Google, rules engine with SPEC defaults and an editor, recovery phases, training
  log with warning signs, 50/10 focus timer, habit builder with formation limit, insights, Get help.
- **Claude**: pluggable provider (off / Claude plan via Agent SDK or `claude -p` / API key with budget cap),
  app tools, every write as a change set, privacy toggle, usage meter, Ask panel, AI features (plan the day,
  shutdown next actions, weekly summary, drafts, capture parsing). **MCP server** for Claude Code / desktop.
- **Extensibility**: `CLAUDE.md`, `docs/ADDING_A_MODULE.md`, `modules/_template`, `npm run new-module` and
  the `/new-module` project skill, daily DB backup + JSON/CSV export.

## Verification (three iteration passes)

1. **Tests**: 255 unit/integration tests (anchors incl. the Nov 1 2026 fall-back and Mar 14 2027
   spring-forward, capacity, caps, carry-over, rules, phases, review change set applied to mock Todoist +
   Google, recorded-response tests through the live code paths, a cross-module daily loop over the DST
   weekend). Playwright click-through in Chrome passes: onboarding → plan within caps → focus block → stop →
   Evening mode → shutdown with carry-over → evening capture → next-morning check-in → weekly review on the
   25-hour Sunday → project timeline.
2. **Browser sweep** of every screen; fixed: sidebar overflow at narrow widths, countdowns using the browser
   clock, CSS load order overriding module styles, duplicate copy, date casing, Settings JSON fields → real
   controls, calendars created for paused projects, UTC date default after 8 PM.
3. **Re-run + install**: full suite and e2e green after fixes; `./start.sh` verified on this Mac (launchd
   agent running, Margin.app connected to the daemon as the notification channel); every Today request
   answers in under 5 ms.

## Unfinished / to know

- **Not tested against your real accounts.** There was no `.env`; I only *read* your Todoist and Calendar
  through the connected tools to model the structure. The recorded-response fixtures are transcribed from
  the official docs — re-record them from your account once connected.
- **Claude plan login won't work until Claude Code is reinstalled**: `~/.local/bin/claude` points to a
  missing binary. The API-key provider works independently. Providers were tested with a fake model.
- **Notifications** route through Margin.app (verified connected) or `osascript`; I didn't see a banner on
  screen. macOS will ask to allow Margin notifications the first time.
- School nights are Mon–Fri by setting; school holidays aren't read from the Hunter calendar yet.
- Project timeline drag/keyboard moves, insights charts and the Ask panel were verified by render tests,
  not hands-on clicking. "Save as template" exists in the API but has no button yet.
- The capture shortcut (⌃⌥Space) is set by env var `MARGIN_CAPTURE_SHORTCUT`, not in Settings.
- Margin.app is an unsigned local build (fine on this Mac).

## Since then (Nov 2)

- The code lives at **github.com/mpeng199/Margin** (public). This folder is the clone and the install.
- **Updates**: Margin checks GitHub hourly and shows a notification, a Today banner and a toolbar
  **Update** button; **Update and Restart** pulls, rebuilds and restarts in seconds. Verified end to end
  twice against the real repo. Margin → Check for Updates… checks on demand.
- Margin.app is in **/Applications** (Finder, Launchpad, Spotlight).
