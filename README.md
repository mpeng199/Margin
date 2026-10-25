# Margin

A quiet, local planner for getting out of burnout and staying out. It makes your load visible, forces the
decisions that reduce it, and protects a fixed daily stop, your sleep, and one real day off.

Everything runs on your Mac. Data leaves it only for Todoist and Google Calendar sync and for Claude calls
you turn on.

## Start it

```bash
cd ~/minimike && ./start.sh
```

The first run installs dependencies, builds the app, installs the background service (it starts at login
and keeps notifications working with the window closed), puts **Margin.app** in `~/Applications`, and opens
it. Run the same command any time; it's safe to repeat.

It works immediately on realistic mock data. Connect your real accounts below whenever you're ready.

## Connect your accounts (about 10 minutes)

### 1. Todoist (1 minute)

1. Open Todoist → **Settings → Integrations → Developer** and copy your **API token**.
2. In Margin: **Settings → Todoist**, paste it, click **Connect**.

The token goes into your Mac's Keychain, not a file. Margin syncs every 5 minutes. It never deletes tasks or
projects: "drop" completes a task with a note (or tags it, your choice in Settings).

Your plan is Todoist Free (5 active projects, no task durations), so estimates are kept in Margin and project
tabs link to a Todoist **label** once the project limit is reached. Tasks still live in Todoist.

### 2. Google Calendar (6 minutes)

Google needs a small "app" in your own Google Cloud account. It's free and only you use it.

1. Go to <https://console.cloud.google.com/> signed in as the Google account you use for your calendar.
2. **Create a project**: project picker (top bar) → **New project** → name it `Margin` → **Create**, then select it.
3. **Enable the API**: ☰ → **APIs & Services → Library** → search **Google Calendar API** → **Enable**.
4. **Consent screen**: ☰ → **Google Auth platform → Branding** → **Get started**. App name `Margin`, your
   email as support email → **Next** → Audience **External** → **Next** → your email → **Next** → agree →
   **Create**.
5. **Scopes**: **Google Auth platform → Data Access → Add or remove scopes**, add these three, then **Update**
   and **Save**:
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/calendar.app.created`
   - (optional, only if you want Margin to be able to write to your own calendars after you confirm each change)
     `https://www.googleapis.com/auth/calendar.events.owned`
6. **Test user**: **Google Auth platform → Audience → Test users → Add users** → your email → **Save**.
7. **Create the client**: **Google Auth platform → Clients → Create client** → type **Desktop app** →
   name `Margin desktop` → **Create**. **Download the JSON now** — Google won't show the secret again.
8. **Publish** (this matters): **Google Auth platform → Audience → Publish app** → confirm. Apps left in
   "Testing" lose their sign-in every 7 days. Publishing a personal app doesn't need Google's review; you'll
   see a "Google hasn't verified this app" screen once — click **Advanced → Go to Margin**.
9. In Margin: **Settings → Google Calendar**, paste the downloaded JSON (or the client ID and secret) →
   **Save Client** → **Connect Google**. Approve in the browser tab that opens and come back.

Margin reads all your calendars. It writes only to calendars it creates: **Margin · Blocks** for time
blocks, and one **Project · …** calendar per project tab (so the separation shows in Google Calendar on your
phone). If your sign-in ever expires, a **Reconnect** banner appears on Today; one click fixes it.

### 3. Claude (optional, 2 minutes)

Margin works fully with AI off. To turn it on: **Settings → Claude**, then pick one:

- **Claude plan**: uses your Claude subscription through the Claude Agent SDK / Claude Code login. Install
  Claude Code (`npm install -g @anthropic-ai/claude-code`), run `claude` once and sign in, then choose
  **Claude plan** in Margin. Usage counts against your plan's limits.
- **API key**: create a key at <https://console.anthropic.com/> → **API Keys**, paste it in Margin (stored in
  the Keychain). This is billed separately from a Claude plan; set the monthly budget cap in the same panel.

Check-in, sleep and mood data are **not** sent to Claude unless you turn on "Share check-in data".
Everything Claude wants to change arrives as a change set you review in **Review changes**.

### 4. Let Claude Code use Margin (optional, 1 minute)

```bash
claude mcp add margin -- node --no-warnings --import tsx /Users/michaelpeng/minimike/src/mcp/server.ts
```

Claude Code (and the Claude desktop app, see `docs/MCP.md`) can then read Today, projects and metrics and
propose changes, which land in the same review queue.

## Daily use

- **Today** shows your anchors (wake, hard stop, lights-out), the morning check-in, the day across all
  calendars, three must-dos plus the homework lane, carry-overs that need a decision, and capacity.
- **Shutdown** starts from the 30/10/0-minute notifications before your stop and takes about ten minutes.
  After it, Margin is in **Evening** mode until morning: a capture box, your leisure list, and the
  lights-out countdown. Opening work views takes a deliberate "I'm breaking my stop".
- **Projects** each have their own tab: overview, tasks, timeline, calendar, people, notes and log.
- **Review** on Sunday afternoon (about 45 minutes) produces one set of changes to approve.
- **Get help** is always one click away (the life-buoy in the toolbar).

Keyboard: ⌘K command palette · ⌘N quick capture · ⌃⌥Space capture from anywhere · ⌘1–6 sections · ⌘, Settings.

## Troubleshooting

- Background service log: `~/Library/Logs/Margin/daemon.log`. App data: `~/Library/Application Support/Margin`
  (nightly backups in `backups/`; JSON/CSV export in Settings → Backup and export).
- Restart the service: `./start.sh`. Stop it: `launchctl bootout gui/$(id -u)/dev.minimike.margin`.
- Notifications: allow **Margin** in System Settings → Notifications.
- If ⌃⌥Space is taken by another app, set `MARGIN_CAPTURE_SHORTCUT` (e.g. `Control+Shift+Space`) before `./start.sh`.

## Development

See `CLAUDE.md` (architecture, conventions, commands) and `docs/ADDING_A_MODULE.md`. Decisions are in
`docs/DECISIONS.md`; the source of truth is `docs/SPEC.md`.

```bash
npm run dev      # daemon + Vite with hot reload, data in .margin-dev/
npm test         # unit + integration tests (mock Todoist/Google)
npm run e2e      # click-through in Chrome
```
