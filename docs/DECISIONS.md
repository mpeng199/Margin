# Decisions

Judgment calls made where SPEC.md was silent or left a choice open. Newest at the bottom of each section.

## Platform and architecture

**Two processes: a launchd daemon + a thin Electron window.** The daemon (Node 22, `src/daemon.ts`) owns
the database, sync, rules, scheduler and notifications and serves the web UI on `127.0.0.1:7317`. launchd
(`~/Library/LaunchAgents/dev.minimike.margin.plist`, `RunAtLoad` + `KeepAlive`) starts it at login and
restarts it if it dies, so notifications fire with the window closed. `Margin.app` (Electron, packaged into
`~/Applications`) provides the dock icon, vibrancy sidebar, native menu bar, tray item, the global capture
shortcut (⌃⌥Space) and Notification Center delivery. Why not one Electron process: native SQLite modules
must be rebuilt for Electron's ABI, which breaks running the same code under plain Node for tests; and a
launchd agent is more reliable for background work than an app that can be quit. Why not Tauri: a Rust
toolchain adds a long first build for no user-visible gain here. Why not a bare browser tab: the spec asks for
an app window with a dock icon and a global shortcut.

**SQLite via Node's built-in `node:sqlite`.** No native build step, no ABI drift, WAL mode, per-module
append-only migrations tracked in `_migrations`.

**Hono for HTTP, React 19 + Vite for UI, TanStack Query, wouter, cmdk, lucide, Luxon, zod 4.** All MIT/ISC.
No calendar or Gantt library: FullCalendar's resource timeline and most Gantt libraries are premium or
GPL; the project timeline, main week/month views and charts are hand-built so DST handling and the visual
language stay under our control.

**Local-server security.** Any web page can send requests to localhost, so the daemon only binds to
127.0.0.1, rejects foreign `Host` headers (DNS rebinding), rejects foreign `Origin`s, and requires an
`X-Margin: 1` header on every mutating request (forces a CORS preflight that is never approved).

**Live updates by invalidation.** Every bus event is forwarded over SSE; the UI refetches (debounced). Data
is local and small, so "refetch everything on any change" is simpler and fast enough (Today renders from
SQLite in tens of milliseconds).

**Scheduling is a 30-second tick, not cron.** Each tick asks enabled modules what's due for today and
yesterday and runs it once per key. Fire times are recomputed from wall-clock anchors every tick, so DST,
laptop sleep and settings changes need no re-registration. Notifications more than 20 minutes late (e.g. the
Mac was asleep) are skipped rather than delivered stale.

**Modules are folders, discovered automatically.** Server half `manifest.ts`, web half `web/index.tsx`
(found with `import.meta.glob`). Nav entries and widget placement live in the server manifest so a disabled
module disappears everywhere at once; toggling is live, data is kept.

**Settings forms are generated** from each module's zod schema (zod → JSON Schema), so new modules get a
Settings page for free; complex settings (accounts, rituals, rules) provide custom panels.

## Time and the burnout rules

**Lights-out = the earlier of (wake − 8h30 on the clock) and (wake − 8h30 of real time).** On ordinary
nights they're identical. On the fall-back night (Sat Oct 31 → Sun Nov 1, 2026) the clock version is earlier:
the stop stays at 9:00 PM and you get 9h30 in bed. On the spring-forward night the elapsed version is
earlier: lights-out moves an hour earlier so the full 8h30 window survives. Either way sleep is never
squeezed and the stop never moves later than the time you're used to.

**School nights**: the night before a school day (Mon–Fri by default). A per-date or per-weekday wake
override can move a school night's stop earlier, never later than the base computation.

**Evening mode starts at shutdown completion or at the hard stop, whichever comes first,** and lasts
until wake. The spec says Evening mode follows shutdown; also entering it at the stop keeps the stop real
on nights the ritual is skipped. The shutdown ritual itself stays reachable in Evening mode.

**"I'm breaking my stop" unlocks work views for 45 minutes** (setting), then the gate returns; every break
is logged with the view and date. While a break is active the dusk palette stays on as a quiet reminder.

**Late night**: declared on the day, before 4 PM, at most one per week (weeks start Sunday). Extends the
stop by up to 60 minutes, capped at lights-out.

**Capacity** = free minutes between wake and the hard stop minus the union of fixed blocks and busy timed
events from every calendar (all-day and "free" events don't count; Margin's own work blocks don't count as
fixed time because they are where planned work happens). "Near zero" means under 30 free minutes.

**Fixed blocks vs the calendar.** Fixed blocks live in settings so capacity works with no Google account.
When a calendar event with the same name covers a fixed block (the real calendar already has "School"
and "Lab (tentative)"), the timeline shows the calendar event only. Onboarding's "put school and lab on the
Blocks calendar" skips blocks that already exist on any calendar.

## Integrations

**Todoist API v1 only** (REST v2 and Sync v9 return 410 since 2026). Reads use incremental `/sync`; writes
use `/sync` commands with UUIDs (idempotent retries) and every `sync_status` entry is checked.

**Rescheduling recurring tasks** sends `item_update` with the new `date` plus the task's existing `string`,
`is_recurring`, `timezone` and `lang` — the only documented-in-practice path that keeps recurrence (see
docs/research/todoist.md §4). After each reschedule the app verifies the task is still recurring and restores
the original due date if not. The mock reproduces the recurrence-killing behavior of the wrong paths so tests
prove the right one.

**Done = `item_close`** (advances recurring tasks), **Drop = comment + `item_complete`** (ends a recurring
task without deleting it) or, by setting, a `dropped` label. There is no code path that sends a delete.

**Free plan constraints.** The user's Todoist is on the Free plan: 5 active projects and no task durations.
Estimates are stored locally whenever `user_plan_limits.current.durations` is false; a project tab can link
to a Todoist *label* instead of a project when the project cap is reached.

**Google OAuth**: Desktop client, loopback redirect on a random 127.0.0.1 port, PKCE S256, system browser.
Base scopes `calendar.calendarlist.readonly` + `calendar.events.readonly` + `calendar.app.created` (the
narrowest set that reads everything and fully manages calendars the app creates). Writing to calendars the
user owns needs `calendar.events.owned`, which desktop apps can only get through a full re-consent (no
incremental auth) — exposed as an explicit "Allow writes to my own calendars" toggle, and every such change
still needs `confirmed: true` set by a per-change yes.

**Calendar sync**: per-calendar sync tokens with `singleEvents=true`; the first full sync starts 60 days back;
a 410 wipes that calendar and re-syncs; a nightly full re-sync catches calendar renames that incremental
calendarList sync misses. `invalid_grant` sets a reconnect flag that drives a one-click banner.

**Mocks are servers, not stubs.** `createMockTodoist` and `createMockGoogle` implement the HTTP APIs the real
clients call (sync tokens, 410s, scope rules, DST-correct recurring instances, plan limits) and persist to
JSON in the data dir. Mock mode and tests run the real client code.

**Secrets** (Todoist token, Google client secret + refresh token, Claude API key) live in the login Keychain
under service "Margin" via `@napi-rs/keyring`. Tests use an in-memory keychain.

## Product

**Name: Margin.** Recovery means restoring margin — space between load and limits — and the app's job is to
show and protect it.

**WIP limit counts Core projects.** "At most 2 non-school projects active" counts non-school projects with
status Core; Maintain projects run at a capped minimum through their maintenance line.

**Notifications by category.** `work` notifications are silenced in Evening mode and on the off-day by one
gate in the core; `wellbeing` ones (lights-out cue, caffeine cutoff, breaks) always pass.

**Onboarding seeds** come from SPEC §7 verbatim (school M/W/Th 6:45–2:02, Tue/Fri until 3:30 — start time
assumed 8:45 from the current calendar — lab 3:40–6:15, home 6:15–6:45, gym ~50 min M/W/F, dinner, badminton
Tue 6–8 AM). Everything is editable on the same screen.

**Model work split.** The coordinator built the shell, integrations, day module, onboarding, backup and
tooling; feature modules were built by parallel agents against written service/event contracts
(docs/AGENT_BRIEF.md), then integrated and reviewed.

## Calls made while building the modules

- **Shutdown can't finish with an open loop lacking a next action, an uncovered deadline in the next
  72 hours (unless you accept the risk with a reason), or the phone step unconfirmed.** If those steps are
  removed from the editable ritual, the flow re-inserts them before the last step so the rules stay
  satisfiable.
- **Off-day "Move to Sunday/Monday" applies its change set on the click** (the click is the yes) and
  links to the record in Review changes.
- **Rule banners are hidden per day, not dismissed in the engine**: hiding a banner never lifts the lock
  that came with it (e.g. adding projects while sleep is short).
- **New projects always start as Proposed** and activate only through an equal-size trade
  (yes requires a no), from the projects list, the project's Overview, or the weekly review.
- **Focus blocks** end at the hard stop (starting after it is refused), keep running state in the DB so
  they survive restarts, and log elapsed minutes from instants (the repeated 1 AM hour counts once).
- **Training warning signs** (SPEC lists no thresholds): resting HR ≥ 5 bpm over the prior 4-week mean,
  a lift not improving its best estimated 1RM across ≥ 2 sessions in 14 days, 7-day mean soreness ≥ 6,
  ≥ 2 dreaded sessions in 7 days. Two or more suggest a deload (cited: Meeusen et al. 2013 consensus).
- **MCP reads go through `/api/ai/read/*`**, which apply the "share check-in data" filter, so sleep,
  energy and mood never reach Claude Code unless that toggle is on.
- **Plan-login Claude** strips `ANTHROPIC_API_KEY` and related variables from the child process so a key
  can't silently bill instead of the plan; the budget cap applies only to the API-key provider.
- **Calendars for seed projects** are created only for Core and Maintain projects during onboarding, so
  paused side projects don't add a dozen calendars to the phone.
- **Countdowns use the daemon's clock** (the UI measures its offset from `/api/day/state`), which keeps
  them right if the browser clock drifts and makes dev time-travel possible (`POST /api/dev/clock`).
- **Habit formation limit vs the Phase 1 set.** SPEC 8 caps formation at 2 but prescribes three Phase 1
  habits (fixed wake time, shutdown complete, phone out of the bedroom). The prescribed set is the one
  allowed exception; nothing new unlocks until those three hold 80%+ for two weeks.

## Distribution and updates

- **GitHub is the update channel.** The installed commit is recorded in `installed.json` (data dir) by
  every install/update; the daemon fetches `origin/main` hourly and offers the difference. Comparing with
  what was *built* (not the checkout's HEAD) means a folder that was pulled but never rebuilt still gets
  the update. Updates are fast-forward only and refuse to run over uncommitted edits.
- **The updater runs detached** in its own process group, so the daemon restart it triggers (launchd
  `kickstart -k`) doesn't kill it. Progress is a small state file the restarted daemon reads to announce
  "Margin updated" (or the failure). The window reloads itself when the daemon's version changes; the app
  is relaunched only when the Electron shell itself changed.
- **Margin.app installs to /Applications** when writable (so it's in Launchpad and Spotlight), otherwise
  ~/Applications; only one copy is kept.
- **The repo is public**, so the Apple HIG skill is a git submodule pointing at its original repository
  instead of a vendored copy, and the mock data uses placeholder addresses.

## Second brain (Brain module, Nov 2 2026)

- **Notes live in SQLite, not a folder of Markdown files.** Everything else in Margin is in the one
  database, so the daily backup, JSON export, tests and the "never lose data" rules cover notes for free.
  Obsidian vaults come in through **Import a Markdown Folder** (subfolders become areas, frontmatter tags
  become #tags). Re-importing updates notes that are unchanged here and never overwrites ones edited in
  Margin. The walk skips dot-folders, doesn't follow symlinks, and caps files (2,000) and size (1 MB).
- **Lightweight on purpose: areas, [[links]], #tags, backlinks.** One area per note (Inbox, Me, Projects,
  People, Journal, or any name typed in) instead of nested folders; tags for anything cross-cutting.
  Titles are unique (case-insensitive), which keeps [[links]] unambiguous; renaming rewrites links to the
  note in your text. No graph view and no plugins: the "Linked from" and "Not written yet" lists carry the
  same information in less space.
- **Compiled notes keep two texts.** A note's `body` is yours; its `auto` part ("From Margin") is rebuilt
  from the rest of Margin every 15 minutes and a few seconds after relevant events, and is read-only.
  Compiling never touches your text, so you can annotate a project or person note safely. Titles of
  compiled notes follow their source (rename the project, the note follows). A compiled note you delete
  stays deleted (a hidden tombstone remembers it); when a source disappears, a note you wrote in keeps your
  text and loses the compiled part, and an untouched one goes away.
- **What gets compiled:** About me (pinned front page), Routine (anchors, week, fixed blocks), Recovery
  plan (phase rules, your rules with their whys), Habits, Rituals, Leisure list, Saying no, Training,
  Sleep and energy, one note per Margin project and per Todoist list that isn't a project tab, one note per
  person you delegate to or wait on, each weekly review, and a journal: one note per day that had something
  in it (done tasks, focus, habits, training, shutdown, stop breaks, notes written), with that day's
  schedule. Calendar events alone don't make a journal entry. Red-flag answers are never copied in.
- **Wellbeing stays apart.** Sleep, energy, ratings, and the weekly summary (which quotes them) go in a
  separate wellbeing text shown with a lock line. Claude never sees it, never sees private notes, and never
  sees journal notes, unless "Share check-in, sleep and mood with Claude" is on, because the journal is
  where mood gets written. Search for Claude only looks at title, your text and the compiled text.
- **Claude reads and proposes; it never writes.** In-app tools and MCP get `search_notes`, `read_note`,
  `list_notes` and `propose_note`. A proposal becomes a change set (`brain.note.create` or
  `brain.note.append`) that waits in Review changes. Appending to a private or (unshared) journal note is
  refused at proposal time.
- **Body edits don't emit events.** Autosave runs 600 ms after typing stops; emitting on every save would
  refetch every screen. Create, delete, restore, rename, pin, area and privacy changes do emit.
- **Not a work view.** Brain stays open on the off-day; in Evening mode it is closed like everything else,
  but ⌘N → Save as Note (⌘Return) still captures a thought into the Notes inbox.
- **Search is a LIKE scan ranked in code** (title over text over compiled text). It's instant at personal
  scale and avoids FTS5 shadow tables in the JSON export; switch to FTS5 past ~10k notes.
- **Remote images in notes are shown as links, not loaded**, so opening a note never tells a server you
  read it; raw HTML in Markdown is dropped. The shell only hands http(s) and mailto links to macOS.
- **Keyboard shortcuts come from each nav entry's `shortcut`**, matching the native Go menu (⌘1 Today …
  ⌘8 Ask, ⌘9 Brain). Before this the palette numbered entries by sidebar position, which disagreed with
  the menu from ⌘4 on.
