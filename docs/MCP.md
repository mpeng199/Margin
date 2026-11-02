# Margin for Claude Code and Claude desktop (MCP)

Margin ships a small MCP server so Claude Code or Claude desktop can read your plan and suggest changes.
It only **reads** and **proposes**. Every proposal lands in Margin → Review changes, and nothing is applied
until you apply it there.

The MCP server is a thin client of the Margin daemon. **Margin has to be running** (Margin.app, or
`./start.sh`). With the daemon stopped, every tool answers "Margin isn’t running".

## Claude Code

```bash
claude mcp add margin -- node --no-warnings --import tsx /Users/michaelpeng/minimike/src/mcp/server.ts
```

Check it with `claude mcp list`, or `/mcp` inside a session. Add `--scope user` to use it from any folder.

## Claude desktop

Open Settings → Developer → Edit Config, and add this to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart Claude:

```json
{
  "mcpServers": {
    "margin": {
      "command": "node",
      "args": ["--no-warnings", "--import", "tsx", "/Users/michaelpeng/minimike/src/mcp/server.ts"],
      "cwd": "/Users/michaelpeng/minimike"
    }
  }
}
```

`cwd` matters: `tsx` is resolved from the Margin folder’s `node_modules`. If `node` isn’t on the PATH that
Claude desktop sees, use its full path (`which node`).

## Tools

| Tool | What it does |
|---|---|
| `get_today` | Mode and hard stop, capacity, schedule, and the plan (must-dos, homework, carry-overs, triage queue) for a date. Start here. |
| `list_projects` | Active projects: status, purpose, goal, weekly time budget, separation rule. |
| `get_project` | One project: settings, tasks, deadlines, delegated functions, what it is waiting on. |
| `get_metrics` | 1–12 weeks (default 4): stop breaks, completions, focus minutes per project, habit consistency, weekly scores. |
| `list_tasks` | Todoist tasks (up to 150), filterable by project, label, due date. |
| `search_notes` | Searches the second brain (titles, the person's text, compiled notes). Private notes are never included. |
| `read_note` | One note by title: the person's text, the compiled part, tags, links and backlinks. |
| `list_notes` | Notes by area or tag, pinned and recently edited first. |
| `propose_note` | Queues a new note, or text appended to an existing one, for review. Nothing is saved until applied. |
| `list_change_kinds` | The kinds of change `propose_changes` accepts. |
| `propose_changes` | Queues a change set for your review (source "MCP"). Returns its id; nothing is applied. |

These call `GET /api/ai/read/*`, `GET /api/brain/claude/*`, `POST /api/ai/propose` and `POST /api/brain/claude/propose`
on the daemon (writes carry the `X-Margin: 1` header).

## Privacy

Notes marked private (the lock in Brain) are never returned. Journal notes and the wellbeing part of compiled
notes are treated like check-in data. Sleep, energy, mood and dread are removed from everything the MCP server returns unless
**Settings → Claude → Share check-in, sleep and mood with Claude** is on. That is the same switch the
in-app Claude uses, and it is off by default. Anything the tools return goes to whichever Claude app you
connected, and from there to Anthropic.

## Other port or data

The server reads `MARGIN_PORT` (default `7317`). To point it at a dev daemon, add `-e MARGIN_PORT=7318`
to `claude mcp add`, or an `"env": { "MARGIN_PORT": "7318" }` entry in the desktop config.

## Troubleshooting

- **"Margin isn’t running"**: open Margin.app or run `./start.sh`.
- **Server fails to start**: run the command by hand in Terminal. It should print `margin MCP ready` on
  stderr and then wait for input (Ctrl-C to quit).
- **A proposal was rejected**: the tool reply says why (unknown change kind, past the hard stop, too many
  must-dos for a day). Fix it and propose again.
