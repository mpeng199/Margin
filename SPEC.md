# SPEC: burnout-proof life planner (local Mac app)

This file is the source of truth for what the app does. Where it is silent, decide with taste and log the decision in docs/DECISIONS.md. Values in [brackets] are defaults; every one is editable in Settings.


## 1. What the app is for

- Recovery from burnout comes from carrying less, not coping better. In a meta-analysis of 20 controlled trials (Panagioti 2017), changing workload and schedules beat individual coping techniques (SMD -0.45 vs -0.18). So the app's first job is to make my load visible and force decisions: cut, pause, delegate. Its second job is to protect a fixed daily stop, sleep, and one real day off.
- The core loop is a hard daily stop with a shutdown ritual. Mentally detaching from work after hours has the strongest link to lower fatigue of the recovery experiences studied (Bennett 2018), and writing a specific plan for unfinished tasks stops them from nagging (Masicampo & Baumeister 2011; Scullin 2018).
- The app must not become another source of load. Daily tracking takes under 2 minutes. No work notifications after shutdown or on the off-day. No streak shaming.
- Tone everywhere: direct and specific, no cheerleading. Misses are data, not verdicts.
- Every core rule shows a one-line "why" with its source.
- Local-first and private. Data leaves my Mac only for Todoist/Google sync and the Claude calls I allow.


## 2. Platform constraints

- Runs locally on my Mac. One command to install and start. Launches at login. Opens as an app-like window with a dock icon.
- A background process runs even when the window is closed: native macOS notifications, sync, rule checks.
- Suggested: TypeScript end to end, SQLite with migrations, schema-validated settings. You choose the shell (local web app plus background service, Tauri, or Electron) and record why.
- Secrets live in the macOS Keychain. Never in the repo, the database, or logs.
- Time zone America/New_York. All time math is DST-safe. US daylight saving ends Sunday, November 1, 2026, so test across it.
- Quiet, beautifully crafted UI: light and dark mode, keyboard-first (command palette, global quick-capture shortcut), fast (Today renders from local cache in under a second).
- Permissively licensed open-source dependencies only. Watch for "premium" calendar and timeline plugins.


## 3. Integrations

### Todoist (source of truth for tasks)
- Personal API token, pasted once in Settings.
- Use the current official Todoist API (developer.todoist.com). Its API versions have changed recently, so check which one is current. Use incremental sync where available.
- Read projects, sections, tasks, labels, due dates, durations, priorities. Write: create, update, complete, reschedule, move, label, comment.
- Rescheduling must preserve recurrence on recurring tasks. Some update paths overwrite the due string and silently kill recurrence; verify against the docs and test it.
- Never delete my tasks or projects. "Drop" means complete with a note, or move to an archive label/project (my choice in Settings).
- Store estimates in Todoist's duration field where possible. App-only metadata (must-do flag, carry count, next action, owner) lives in the local DB keyed by task ID. Mirror the must-do flag as a Todoist label so it shows up there too.

### Google Calendar (source of truth for events)
- OAuth for an installed/desktop app with a loopback redirect, using the narrowest scopes that work. The README walks me through creating the Google Cloud project, enabling the Calendar API, setting up the consent screen, and adding myself as a test user.
- Google expires refresh tokens after 7 days for apps left in "Testing" status. Detect invalid_grant, show a one-click reconnect banner, and explain in the README how to avoid it (move the app to production status for personal use).
- Read all my calendars with incremental sync tokens.
- By default, write only to calendars the app owns: one "Blocks" calendar for time blocks it schedules, plus one calendar per project (section 5). Writing to my primary calendar needs an explicit yes per action.
- Never change events the app didn't create unless I confirm that specific change.
- Proposed time blocks are created only after I say yes.

### Claude (the app calls Claude)
- Pluggable provider. Implement both and let me choose in Settings:
  (a) My Claude plan login, through the Claude Agent SDK or headless `claude -p`. Per support.claude.com, Agent SDK and `claude -p` usage currently draws from plan limits. Confirm in the current docs before relying on it: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
  (b) A Claude API key from the Claude Console. API usage is billed separately from a Claude plan. Max and Team plans include monthly API credits once a Console organization is linked in claude.ai Settings > Billing: https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
- Configurable models. Defaults: claude-sonnet-5-5 for planning and reviews, claude-haiku-5-5 for parsing and short summaries. Cache the stable system prompt.
- Claude works through app-defined tools (read tasks, events, projects, metrics; propose changes). Every write Claude wants goes into a change set I review as a diff: apply all, apply some, edit, or discard. Nothing writes silently.
- Usage meter, plus a monthly budget cap for the API-key provider.
- The app works fully with AI turned off. A toggle keeps check-in, sleep, and mood data out of anything sent to Claude.
- In-app Claude: direct, specific, uses my own data, pushes back when a plan exceeds capacity, never diagnoses. If I mention hopelessness or self-harm, it responds with care and points me to 988 and a trusted adult.
- AI features:
  - Plan my day, within the caps and before the stop.
  - Turn a shutdown brain dump into next actions with slots.
  - Write the weekly review summary and a proposed change set.
  - Draft delegation messages and "no" replies. It never sends them.
  - Parse natural-language capture when Todoist's own quick-add parsing isn't enough.
  - An Ask panel.

### Claude calls the app (last phase)
- Expose the app as a local MCP server so Claude Code and the Claude desktop app can read Today, projects, and metrics, and can propose changes through the same change-set review. Document how to register it.


## 4. Burnout system

### 4.1 Day anchors and capacity
- I set a wake time. Lights-out = wake minus 8h30m (8 h of sleep plus about 30 min to fall asleep). Hard stop = lights-out minus 60 min (screen-free wind-down). Example: wake 6:30, lights-out 10:00 PM, stop 9:00 PM. Always compute from my confirmed wake time; never hardcode.
- Per-day overrides are allowed (e.g., early badminton days), but on school nights the stop never moves later than the computed time.
- Capacity: for each day, free minutes = the time between fixed blocks (school, commute, lab, gym, dinner) and the hard stop. Planned load uses estimates x1.5 (planning fallacy). Show capacity vs load per day and per week. If weekday capacity is near zero, say so plainly on Today and in the weekly review, and ask which commitment changes. Never solve it by squeezing sleep.

### 4.2 Hard stop and shutdown (the core loop)
- Notifications at stop minus 30 min ("wrap up"), minus 10 ("start shutdown"), and 0 ("shutdown now"), plus a lights-out cue [15 min before].
- 10-minute guided shutdown:
  1. Brain-dump every open loop into one box.
  2. Give each item a specific next action and a day or slot. Claude proposes these if it's enabled.
  3. Choose tomorrow's must-dos.
  4. Glance at tomorrow's calendar.
  5. Confirm every deadline in the next 72 hours is covered.
  6. Phone goes out of the bedroom.
  7. Tap "Shutdown complete", which logs the time.
- After shutdown the app is in Evening mode until wake time. It shows only:
  - a capture box (items land in tomorrow's inbox)
  - the leisure list
  - a lights-out countdown

  Opening work views takes a deliberate "I'm breaking my stop" tap. The app logs it without guilt copy.
- Exceptions: a late night must be declared before 4 PM that day, max 1 per week. It extends that night's stop by up to [60 min]; lights-out stays put. Otherwise, whatever doesn't fit goes to triage, not into the night.
- This shutdown replaces my current habit: a ~10-minute nightly wind-down that triages tasks and proposes tomorrow's blocks. Blocks are still created only after my yes.

### 4.3 Daily plan
- Max 3 must-dos per day beyond homework [3]. Adding a 4th forces a swap, or makes the new one optional.
- Homework is its own lane. It counts toward capacity but not toward the must-do cap.
- One 60-90 min deep block per day on a single project. Messages are batched into 2 slots [after school, at shutdown].
- If the plan is over capacity, it must be triaged before it's accepted.

### 4.4 Carry-over
- Unfinished items at shutdown carry to tomorrow with a next action. Each task tracks its carry count.
- At 3 carries, the task must be triaged: do first tomorrow, give it a fixed slot, delegate, or drop. There is no 4th roll.
- When I mark anything urgent or bump its priority, ask: "What actually happens if this waits a week?" (mere urgency effect; Zhu, Yang & Hsee 2018).

### 4.5 Commitment triage
- Every project is Core, Maintain, Pause, or Drop.
- Maintain requires a maintenance line: the smallest weekly action, a minutes cap, and who has been told.
- Pause requires a restart date. Paused projects vanish from Today and planning. Their tasks are hidden by label or filter, never deleted.
- Drop archives the tab (data kept) and closes out its tasks per the Drop setting.
- WIP limit: at most 2 non-school projects active in a week [2].
- "Yes requires a no": a new commitment starts as Proposed. It activates only in the weekly review, after I pick something of equal size to pause or drop.

### 4.6 Delegation
- Per project:
  - functions, each with an owner, decision rights, a due date, and written "good enough" criteria
  - a check-in cadence [weekly, 20 min]
  - a waiting-on list
- Script library for saying no, with copy to clipboard. Seeds:
  - "I'm at capacity through January; I can do X in February or point you to Y."
  - "I can do this if I drop Z. Which matters more?"

### 4.7 Sleep and daily check-in
- Morning check-in in under 30 seconds: bedtime, wake time, energy 0-10.
- Rules:
  - target 8-10 h (AASM, ages 13-18)
  - weekend wake no more than 1.5 h later than on weekdays
  - caffeine cutoff reminder [2 PM]
  - phone charges outside the bedroom
  - daylight within 30 min of waking
  - naps 20 min max, before 4 PM

### 4.8 Off-day
- One full day off per week [Saturday]. Off-day mode hides work views and silences work notifications.
- The day before, warn about tasks due on the off-day and offer to move them.
- Leisure list, with a test on every item: "Would I be upset if this produced nothing?" If yes, it's work.
- Weekday evenings: 30-60 min of non-productive time after shutdown. The leisure list shows in Evening mode.

### 4.9 Weekly review [Sunday afternoon, 45 min]
- Guided steps:
  1. Score the week: energy, dread/cynicism and "I'm effective" (each 0-10), average sleep, and stop breaks.
  2. Triage the carry-over list.
  3. Set 3 priorities.
  4. Check the WIP limit and project statuses.
  5. Do the owner check-ins.
  6. Review deadlines for the next 3 weeks.
  7. Apply rule outcomes.
  8. Decide on Proposed commitments.
  9. Confirm the next off-day.
- Claude writes a short, honest summary and a proposed change set.

### 4.10 Recovery phases
- Stabilize (weeks 1-2), then Recover (weeks 3-8), then Rebuild (month 3+). A phase banner on Today shows that phase's rules.
- Nothing gets added back before Rebuild. In Rebuild, re-add one commitment at a time, and only after 3+ stable weekly scores.

### 4.11 Rules engine
- Pre-committed if-then rules, stored as data, with an editor. Each rule is a condition plus an action. Actions: banner, notification, required review step, lock adding projects, ask Claude, create task.
- Default rules:
  - Stop broken 2+ times in a week: the next review requires removing one Maintain item.
  - Under 7 h of sleep 3 nights in a row: adding projects is locked, the off-day is non-negotiable, and a banner shows.
  - Dread at 7+ two weeks running, or repeatedly working past the stop on one project: prompt me to fully delegate that function.
  - Energy trending up and stop held 6 of 7 days: "on track". Flat after 3 weeks: cut one more commitment. Worse after 2-3 weeks, or any red flag: show the Get help card.

### 4.12 Training load
- Log gym and badminton sessions. At least 1 rest day a week, ideally the off-day.
- Phase 1: deload (cut volume by about a third, hold intensity).
- Weekly check for warning signs:
  - resting heart rate up
  - lifts stalled for 2+ weeks
  - persistent soreness
  - dreading sessions

  Two or more: suggest a deload or rest.
- Under 7 h of sleep: suggest a lighter session. Never trade sleep for training.

### 4.13 Focus blocks
- Single-project timer [50 min work / 10 min break] that logs time to that project. The break prompt says to get away from screens.

### 4.14 Get help (always one click away)
- Red flags:
  - thoughts of death, self-harm, or suicide
  - low mood or loss of interest most days for 2+ weeks
  - panic attacks or persistent physical symptoms
  - under about 6 h of sleep most nights despite the chance to sleep
  - big changes in eating or weight, or using caffeine, nicotine, alcohol, or other drugs to cope
  - functioning dropping despite effort, or no improvement after 2-3 weeks of the plan
- Shows 988 (call or text) and an optional trusted-adult contact I enter. Opens automatically when a rule fires; dismissible for the day only.
- Burnout and depression overlap heavily (r of about .80; Bianchi 2021), so the app never tells me it's "just burnout". It is not a medical tool.


## 5. Projects as tabs (the feature I care about most)

- Every project is its own tab: pinned in the sidebar, reorderable, with a color and icon.
- Each project links to one Todoist project (created or linked) and one Google calendar that belongs only to that project. The app creates that calendar (e.g., "Project · Delphic Medicine") or links an existing one. It holds the project's timeline, so the separation also shows up in Google Calendar on my phone.
- Inside a project tab:
  - Overview: status, one-line purpose, current goal, maintenance line, next milestone, weekly time budget vs actual, open loops, carry-over hotspots.
  - Tasks: the linked Todoist project (sections, subtasks), with estimate, must-do, owner, and carry count.
  - Timeline: a Gantt-style view of this project only (phases as date ranges, milestones, deadlines, dated tasks, work sessions). Zoom week/month/quarter/semester, a today line, drag to reschedule (writes back after confirmation).
  - Calendar: month and week views of this project only. Optional faint overlay of my main calendar for conflict checks, off by default.
  - People: delegation functions, owners, waiting-on, check-in notes.
  - Notes: local markdown.
  - Log: completions, time spent, review notes.
- Separation rule: anything that takes my time (work sessions, meetings) always appears in Today and the main calendar, so planning stays honest. Everything else about a project (milestones, phases, deadlines) stays in its tab unless I choose otherwise per project: hidden / deadlines and milestones only [default] / everything.
- Todoist projects I don't turn into tabs stay plain lists; their tasks still show in Today.
- Project templates (e.g., application cycle, research paper, student org) pre-create phases, milestones, and a maintenance line. Any project can be saved as a template.
- Seed projects for onboarding. I confirm, rename, or link each one. Suggested statuses come from my burnout plan:
  - School: Core (homework lane).
  - Summer 2027 applications: Core.
  - Columbia Science Honors Program: Core if attendance is required.
  - Lim Lab (Mount Sinai): Core or Maintain. Keep the standing block.
  - Delphic Medicine: Maintain, run through owners for manuscript intake and reviewer assignment, editing/production, outreach/social media, and operations/scheduling. Suggested maintenance line: one 20-min owner check-in plus 30 min of decisions, Sundays.
  - Hunter Red Cross Club: Maintain at the minimum required hours, batched into one event a month.
  - WaypointNYC (community health org): Pause, or minimal Maintain.
  - Side projects (Serene, ToxReadout, LocalFlow, Blender/web work, and this app): pause all but one. The one I keep becomes leisure, with no deadlines.


## 6. Screens

- Today:
  - anchors and stop countdown
  - morning check-in
  - the day's timeline across all calendars
  - 3 must-dos and the homework lane
  - carry-overs needing triage
  - capacity bar, phase banner, rule alerts
- Calendar: main week and month view, following the separation rule, with load vs capacity per day.
- Projects (section 5).
- Habits, Review, Settings, Get help.
- Insights:
  - sleep duration and wake-time consistency
  - energy and the three weekly ratings
  - stop adherence and carry-over stats
  - must-do completion
  - time per project
  - habit consistency
- Quick capture everywhere via a global shortcut, landing in the Todoist inbox. Use Todoist's own quick-add parsing first; Claude only when needed.


## 7. Onboarding (about 10 minutes, every step skippable)

1. Connect accounts (or continue on mocks).
2. Enter a wake time. Show the computed lights-out and hard stop, with the math.
3. Confirm fixed weekly blocks. Seed them from my current schedule:
   - school Mon/Wed/Thu 6:45 a.m.-2:02 p.m.; Tue/Fri ending 3:30 p.m.
   - lab weekdays 3:40-6:15 p.m.; home around 6-7 p.m.
   - gym 45-60 min, then dinner, after lab
   - badminton Tuesday 6-8 a.m.

   By default, put school and lab blocks on the Blocks calendar every weekday (after my yes). Run the capacity check immediately and show the result.
4. Set the off-day and the weekly-review time.
5. Map Todoist projects to tabs and set each status (seed list in section 5).
6. Set delegation owners for Delphic Medicine.
7. Import upcoming application deadlines into that project's timeline.
8. Record a baseline:
   - current actual bedtime and wake time
   - caffeine timing
   - the three ratings
   - a red-flag check (any yes opens Get help)
   - the phase 1 start date


## 8. Habits (built to keep adding)

- No-code habit builder. Each habit has:
  - name and why
  - an if-then cue, "After X, I will Y" (implementation intentions; Gollwitzer & Sheeran 2006)
  - type: yes/no, count, minutes, or 0-10
  - schedule: specific days or N per week
  - target, reminder, start date
- Show consistency % over 2 and 4 weeks, not only streaks. One miss is fine. Two in a row triggers a gentle "never miss twice" nudge (in Lally 2010, a single missed day didn't derail habit formation).
- At most 2 habits in formation at once [2]. The next unlocks when the current ones hold 80%+ for 2 weeks. Habits graduate to "automatic" and leave the daily view. No "21 days" claims: Lally 2010 found a median of 66 days (range 18-254).
- Seed library (off unless chosen):
  - fixed wake time
  - daylight within 30 min
  - caffeine cutoff
  - phone out of bedroom
  - shutdown complete
  - lights-out on time
  - 50/10 breaks
  - message batching
  - weekly review
  - off-day
  - leisure after shutdown
- Phase 1 turns on only three: fixed wake time, shutdown complete, phone out of bedroom.


## 9. Extensibility (non-negotiable)

- Module architecture. Every feature above is a module in its own folder, with a manifest declaring:
  - nav entries and Today widgets
  - settings schema and migrations
  - scheduled jobs and notifications
  - events emitted and consumed (e.g., day.started, task.carried, shutdown.completed, checkin.submitted)
  - rule conditions and actions it adds
  - Claude tools and context it exposes

  Modules toggle on and off in Settings.
- Core shell: module registry, event bus, scheduler, storage, integration clients, change-set review UI.
- No-code extension through data: habits, rules, rituals (the shutdown, weekly review, and morning steps are editable checklists), custom check-in metrics, and project templates.
- For future Claude Code sessions:
  - CLAUDE.md covering architecture, conventions, and how to run, test, and extend
  - docs/ADDING_A_MODULE.md
  - a template module
  - a project-level Claude Code skill or command, "new-module", that scaffolds, wires, and tests a module from a one-line description
- JSON/CSV export and an automatic daily local backup of the database.


## 10. Safety and data rules

- Never delete my Todoist tasks or projects, or Google events the app didn't create.
- Bulk changes, and anything Claude initiates, go through change-set review. Single direct actions (like checking off a task) apply immediately.
- While building and testing on my real accounts: read-only, except inside a throwaway test project and calendar you create and name as obviously disposable. Leave them for me to delete.


## 11. Build phases

Commit after each phase. If anything must be cut, cut from the end. Phases 1-4 are the minimum.

1. Shell: modules, SQLite, settings, Keychain, background process, notifications, onboarding skeleton.
2. Integrations: Todoist and Google Calendar sync, and writes through change sets, with recorded fixtures for tests.
3. Daily loop: anchors, capacity, Today, must-do cap, homework lane, shutdown, Evening mode, carry-over, quick capture.
4. Projects as tabs: linking, all sub-views, separation rule, statuses, WIP limit, "yes requires a no", templates.
5. Recovery system: check-ins, sleep, off-day, weekly review, rules engine, phases, training, focus, habits, insights, Get help.
6. Claude: providers, tools, change sets, AI features, usage meter. Then the MCP server.
7. Extensibility kit and polish: CLAUDE.md, docs, template module, new-module skill, backups, README, autostart.


## 12. Definition of done

- One command installs and runs it. It launches at login, and notifications fire with the window closed.
- Onboarding finishes on real accounts (or mocks) and lands on a populated Today and project tabs.
- The daily loop works end to end: plan within the caps, focus block, shutdown with carry-over, Evening mode, morning check-in.
- A weekly review produces a change set that applies correctly to Todoist and Google Calendar.
- Each project tab shows only its own timeline and calendar, and the separation settings work in the main views.
- Tests:
  - unit tests for anchors, capacity, caps, carry-over, rules, phases, and the November 1, 2026 DST change
  - integration tests on recorded Todoist and Google responses
  - an end-to-end click-through, in a real browser, of onboarding, the daily loop, a weekly review, and a project tab
- README: a 10-minute setup for the Todoist token, the Google OAuth client, the Claude login or API key, and MCP registration.


## Sources (for the "why" lines)

- Panagioti et al. 2017, JAMA Internal Medicine: structural vs individual burnout interventions
- Bennett, Bakker & Field 2018, Journal of Organizational Behavior: recovery experiences
- Masicampo & Baumeister 2011, Journal of Personality and Social Psychology: plan-making and unfinished goals
- Scullin et al. 2018, Journal of Experimental Psychology: General: bedtime to-do lists
- Zhu, Yang & Hsee 2018, Journal of Consumer Research: mere urgency effect
- AASM teen sleep advisory; Drake et al. 2013 (caffeine 6 h before bed); Carter et al. 2016, JAMA Pediatrics (bedtime devices)
- Albulescu et al. 2022, PLOS ONE: micro-breaks; Leroy 2009: attention residue
- Lally et al. 2010: habit formation; Gollwitzer & Sheeran 2006: implementation intentions
- Bianchi et al. 2021: burnout and depression overlap
