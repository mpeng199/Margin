# Todoist API research (Todoist API v1)

Researched 2026-10-24 from the live docs. `D` = https://developer.todoist.com/api/v1/ (one Redoc page; anchors below are relative to it).
I parsed the docs from the OpenAPI spec embedded in that page, so the quotes are verbatim. No authenticated calls were made.

---

## 0. Which API (confirmed)

- **Todoist API v1** at `https://api.todoist.com/api/v1/` is the current API. Quote: "The Todoist API v1 is a new API that unifies the Sync API v9 and the REST API v2." ([D#tag/Migrating-from-v9](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9))
- **REST v2 and Sync v9 are shut down.** I checked this live with unauthenticated requests on 2026-10-24:
  - `GET https://api.todoist.com/rest/v2/tasks` → **HTTP 410** with body `This endpoint is deprecated. ... please update your use case to rely on the new API endpoints, available under /api/v1/ prefixes.`
  - `GET https://api.todoist.com/sync/v9/sync` → **HTTP 410** with the same body.
  - `GET https://api.todoist.com/api/v1/tasks` (no token) → 401 `{"error":"Unauthorized","error_code":477,...,"error_tag":"UNAUTHORIZED","http_code":401}`.
  - The old docs URLs `developer.todoist.com/rest/v2/` and `/sync/v9/` now redirect to `/api/v1/`.
  - Sunset date: the official docs give **no date**. Third parties reported "February 2026" as the announced shutdown ([Drafts forum, Dec 2025](https://forums.getdrafts.com/t/todoist-api-updates-deadline-febrary-2026/16403)), and Airbyte confirms "Every request to it now returns `HTTP 410 Gone`" ([Airbyte](https://docs.airbyte.com/integrations/sources/todoist-migrations)). **AMBIGUOUS: exact shutdown date not officially published; irrelevant now since both are 410.**
- Naming quirk: v1 renamed items→tasks, notes→comments, but "The only exceptions for renaming are the `/sync` and `/activities` endpoints" — so `/sync` still says `items`, `notes`, `item_add`, `note_add`. ([D#tag/Migrating-from-v9](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9))
- IDs are opaque non-numeric strings (e.g. `"6X7rM8997g3RQmvh"`). Old v9 numeric IDs are rejected for tasks, projects, sections, comments, and reminders. Endpoint paths must be lowercase ("the former will return 404"). ([D#tag/Migrating-from-v9](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9))
- `/sync` is **POST only** in v1 ("GET was removed"). ([same](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9))

## 1. Auth (personal token)

- Header: `Authorization: Bearer <token>`. Quote: "your application must provide an authorization header with the appropriate `Bearer $token`. ... you can obtain your personal API token from the [integrations settings](https://app.todoist.com/app/settings/integrations)". ([D#tag/Authorization](https://developer.todoist.com/api/v1/#tag/Authorization))
- Personal tokens don't expire. The 1-hour expiry and refresh tokens apply only to OAuth apps. An invalid token returns 401 with `error_code` 477, `error_tag` `UNAUTHORIZED`, and a `WWW-Authenticate: Bearer error="invalid_token"` header. ([D#tag/Authorization](https://developer.todoist.com/api/v1/#tag/Authorization))
- Error body format (all v1 endpoints, JSON):
  ```json
  {"error": "Task not found", "error_code": 478, "error_extra": {"event_id": "<hash>", "retry_after": 3}, "error_tag": "NOT_FOUND", "http_code": 404}
  ```
  "`retry_after` is server-provided backoff metadata and is not limited to `429 Too Many Requests` responses." ([D#tag/Migrating-from-v9](https://developer.todoist.com/api/v1/#tag/Migrating-from-v9))

## 2. Incremental sync — `POST https://api.todoist.com/api/v1/sync`

Source: [D#tag/Sync/Overview](https://developer.todoist.com/api/v1/#tag/Sync/Overview)

- Body is `application/x-www-form-urlencoded`. Parameter values are **JSON-encoded strings**.
- Params: `sync_token` (required; `*` = everything) and `resource_types` (required JSON array). The available types include `labels, projects, items, notes, sections, filters, reminders, reminders_location, locations, user, live_notifications, collaborators, user_settings, notification_settings, user_plan_limits, completed_info, stats, workspaces, workspace_users, ...`. `all` is allowed, and `-projects` excludes a type.
- For this app: `resource_types=["projects","sections","items","labels","notes","user","user_plan_limits"]`.
- Flow, quoted: "On your initial sync request, specify `sync_token=*` ... The server will also return a new `sync_token` ... In your subsequent Sync request, use the `sync_token` that you received from your previous sync response ... the Todoist API server will return only the updated resource data."
- Full-sync staleness: the full sync carries `full_sync_date_utc`. "For big accounts, the data may be returned with some delay ... doing an incremental sync afterwards is required to get up-to-date data." **Do one incremental sync right after every full sync.**
- Response fields: `sync_token`, `full_sync` (bool), `full_sync_date_utc`, `items[]`, `projects[]`, `sections[]`, `labels[]`, `notes[]` (task comments), `project_notes[]`, `user{}`, `user_plan_limits{}`, `temp_id_mapping{}`, `sync_status{}`.
- `day_orders` is "**Deprecated** ... use `user_item_orders`".
- **AMBIGUOUS:** the docs don't spell out how deletions appear in incremental results. The item objects do carry `is_deleted` and `checked`, so treat each incoming object as a full replacement of the local row. Drop rows where `is_deleted: true`. Treat `checked: true` as completed.

### Task (sync "item") fields — [D#tag/Sync/Tasks](https://developer.todoist.com/api/v1/#tag/Sync/Tasks)

`id, user_id, project_id, section_id (null = none), parent_id (null = root), content, description, priority, due, deadline, duration, labels (array of label NAMES), child_order, order_key, day_order, is_collapsed, checked, is_deleted, added_at, updated_at, completed_at, added_by_uid, assigned_by_uid, responsible_uid`.

- **Priority is inverted.** Quote: "`priority` ... (a number between `1` and `4`, `4` for very urgent and `1` for natural). **Note**: Keep in mind that `very urgent` is the priority 1 on clients. So, `p1` will return `4` in the API." So **API 4 = UI p1, 3 = p2, 2 = p3, 1 = p4 (none)**.
  - **DOC CONFLICT:** the REST create/update body schema says "Task priority (1-4, where 1 is highest)". The REST *response* schema says "from 1 (normal) to 4 (urgent)". The Sync docs and the response schema agree with each other, so the body-schema wording looks like a doc bug. Assume **4 = urgent** everywhere and check it against one real task.
- **`due` object (v1 has NO `datetime` key).** Fields are `date, timezone, string, lang, is_recurring`. The time is embedded in `date`. ([D#tag/Due-dates](https://developer.todoist.com/api/v1/#tag/Due-dates))
  - Full-day: `{"date":"2016-12-01","timezone":null,"string":"every day","lang":"en","is_recurring":true}`
  - Floating time: `date` = `YYYY-MM-DDTHH:MM:SS`, with no `Z` and `timezone: null`. It means local wall-clock time in the user's timezone.
  - Fixed zone: `date` = `YYYY-MM-DDTHH:MM:SSZ` (stored in UTC), plus `"timezone":"Europe/Madrid"`.
  - Quote: "Unless specified explicitly, dates with time are created as floating."
  - The official TS SDK still models an optional `datetime` on `due` ([sdk types](https://github.com/Doist/todoist-sdk-typescript/blob/main/src/types/tasks/types.ts)). **AMBIGUOUS:** parse `datetime` if present, but don't rely on it. Derive the time from the length and format of `date`.
- **`deadline`:** `{"date":"2024-01-25","lang":"en"}`. Quote: "deadlines only support non-recurring dates with no time component." ([D#tag/Deadlines](https://developer.todoist.com/api/v1/#tag/Deadlines))
- **`duration`:** `{"amount":15,"unit":"minute"}` or `null`. See section 6.

### Realistic trimmed incremental response (assembled from the docs' example objects; values illustrative)

```json
{
  "full_sync": false,
  "sync_token": "TnYUZEpuzf2FMA9qzyY3j4xky6dXiYejmSO85S5paZ_a9y1FI85mBbIWZGpW",
  "temp_id_mapping": {},
  "projects": [
    {"id": "6Jf8VQXxpwv56VQ7", "name": "Inbox", "inbox_project": true, "is_archived": false,
     "is_deleted": false, "parent_id": null, "child_order": 0, "view_style": "list", "color": "charcoal"}
  ],
  "sections": [
    {"id": "6X7FxXvX84jHphx2", "project_id": "6Jf8VQXxpwv56VQ7", "name": "Groceries",
     "section_order": 1, "is_archived": false, "is_deleted": false, "is_collapsed": false}
  ],
  "items": [
    {"id": "6X7rM8997g3RQmvh", "project_id": "6Jf8VQXxpwv56VQ7", "section_id": "6X7FxXvX84jHphx2",
     "parent_id": null, "content": "Water plants", "description": "", "priority": 4,
     "labels": ["home"], "child_order": 1,
     "due": {"date": "2026-10-25T09:00:00", "timezone": null, "string": "every day at 9am",
             "lang": "en", "is_recurring": true},
     "deadline": null, "duration": {"amount": 15, "unit": "minute"},
     "checked": false, "is_deleted": false,
     "added_at": "2025-01-21T21:28:43.841504Z", "updated_at": "2026-10-24T08:00:00Z", "completed_at": null}
  ],
  "labels": [{"id": "2156154810", "name": "home", "color": "lime_green", "is_deleted": false, "is_favorite": false}],
  "notes": [],
  "user": {"id": "2671355", "inbox_project_id": "6Jf8VQXxpwv56VQ7", "is_premium": false,
           "tz_info": {"timezone": "America/Sao_Paulo", "gmt_string": "-03:00"}}
}
```

## 3. Writes

### 3a. Sync commands (preferred: batched, idempotent, can be offline-queued)

Source: [D#tag/Sync/Overview](https://developer.todoist.com/api/v1/#tag/Sync/Overview) and [D#tag/Sync/Tasks](https://developer.todoist.com/api/v1/#tag/Sync/Tasks)

- POST `/api/v1/sync` with `commands=<JSON array>`.
- Each command is `{type, uuid, args, temp_id?}`.
- `uuid` gives idempotency. Quote: "Todoist will not execute a command that has same UUID as a previously executed command. This will allow clients to safely retry". **Persist the uuid with the queued command and reuse it on retry.**
- `temp_id` gives a placeholder ID for created objects. Later commands in the same request can reference it. The response's `temp_id_mapping` maps it to the real ID.
- Max 100 commands per request ([D#tag/Request-limits](https://developer.todoist.com/api/v1/#tag/Request-limits)).
- Response shape:
  ```json
  {"sync_token": "...",
   "sync_status": {"32eaa699-...": "ok",
                   "bec5b356-...": {"error_tag": "INVALID_ARGUMENT_VALUE", "error_code": 20, "error": "Invalid argument value",
                                    "http_code": 400, "error_extra": {"argument": "file_url", "explanation": "..."}}},
   "temp_id_mapping": {"381e601f-...": "6HWcc9PJCvPjCxC9"}}
  ```
- **A 200 response does NOT mean every command succeeded.** Check every `sync_status[uuid]`. Quote: "Clients should treat `400` command errors as a terminal signal and should not retry the command (e.g. ITEM_NOT_FOUND is non-retryable during sync)."
- **AMBIGUOUS:** the batching example response also includes `sync_token` and `full_sync`, which suggests you can send `commands` together with `sync_token` and `resource_types` in one POST. That isn't stated as a rule.

Payloads (`args` shown; the wrapper is `{"type": T, "uuid": "<uuid4>", "temp_id": "<uuid4 if creating>", "args": {...}}`):

| type | args (verbatim fields from docs) | notes |
|---|---|---|
| `item_add` | `{"content":"Buy Milk","project_id":"6Jf8VQXxpwv56VQ7","section_id":null,"parent_id":null,"labels":["Food"],"priority":4,"due":{"string":"tomorrow at 10:00"},"deadline":{"date":"2026-11-01"},"duration":{"amount":30,"unit":"minute"},"description":""}` | Only `content` is required. With no `project_id`, the task goes to Inbox. |
| `item_update` | `{"id":"6X7rM8997g3RQmvh","content":"Buy Coffee","due":{"string":"tomorrow at 10:00"}}` | Quote: "updating the parent, moving, completing or uncompleting tasks is not supported by `item_update`". `labels` **replaces** the whole list. Set `duration: null` to remove it. |
| `item_move` | `{"id":"...","section_id":"..."}` or `{"id":"...","project_id":"..."}` or `{"id":"...","parent_id":"..."}` | Quote: "Only one of `parent_id`, `section_id` or `project_id` must be set." The task "becomes the last root task of the section/project". |
| `item_complete` | `{"id":"...","date_completed":"2017-01-02T01:00:00.000000Z"}` | "Completes a task and its sub-tasks and moves them to the archive." This is not the recurring-aware path. |
| `item_close` | `{"id":"..."}` | Quote: "does exactly what official clients do when you close a task: regular tasks are completed and moved to the archive, recurring tasks are scheduled to their next occurrence." **Use this for the "done" button.** |
| `item_update_date_complete` | `{"id":"...","due":{"date":"2014-10-30","string":"every day"},"is_forward":1,"reset_subtasks":0}` | Explicit recurring completion. Quote: "using `item_update` won't do this". |
| `item_uncomplete` | `{"id":"..."}` | Restores the task. Ancestors are reinstated and it is placed at the end of its parent. |
| `label_add` | `{"name":"Food","color":"lime_green"}` | Creates a personal label. Attach it to a task via `item_update` `labels` (names, not IDs). |
| `note_add` | `{"item_id":"6X7gfV9G7rWm5hW8","content":"Note1"}` | This is a task comment. Comments are a plan-gated feature (`user_plan_limits.current.comments`). Free = yes. |
| `project_add` | `{"name":"Shopping List","color":"berry_red","parent_id":null,"view_style":"list"}` | Watch the Free limit (section 7). |
| `section_add` | `{"name":"Groceries","project_id":"9Bw8VQXxpwv56ZY2"}` | Max 20 sections per project (Help Center). |
| `project_archive` | `{"id":"6X7fphhgwcXVGccJ"}` | "Archive a project and its descendants." |

- **AMBIGUOUS (labels):** the docs only say labels are "a list of names that may represent either personal or shared labels." They don't say what happens when you put a name on a task that has no personal label yet. The safe route is to batch `label_add` (temp_id) and then `item_update` in one request.

### 3b. REST equivalents (JSON bodies, return the object)

| Action | Endpoint | Doc |
|---|---|---|
| Create task | `POST /api/v1/tasks` with `{content, description, project_id, section_id, parent_id, order, labels, priority, assignee_id, due_string \| due_date \| due_datetime, due_lang, duration, duration_unit, deadline_date}` | [create](https://developer.todoist.com/api/v1/#tag/Tasks/operation/create_task_api_v1_tasks_post) |
| Update task | `POST /api/v1/tasks/{id}` (same fields minus project, section, and parent). "Omit this field to keep it unchanged." Pass `null` to clear `duration` or `deadline_date`. | [update](https://developer.todoist.com/api/v1/#tag/Tasks/operation/update_task_api_v1_tasks__task_id__post) |
| Move | `POST /api/v1/tasks/{id}/move` with `{"project_id"\|"section_id"\|"parent_id": "..."}`. Returns the task. | [move](https://developer.todoist.com/api/v1/#tag/Tasks/operation/move_task_api_v1_tasks__task_id__move_post) |
| Close (recurring-aware) | `POST /api/v1/tasks/{id}/close`. "Tasks with recurring due dates will be scheduled to their next occurrence." | [close](https://developer.todoist.com/api/v1/#tag/Tasks/operation/close_task_api_v1_tasks__task_id__close_post) |
| Reopen | `POST /api/v1/tasks/{id}/reopen` | [reopen](https://developer.todoist.com/api/v1/#tag/Tasks/operation/reopen_task_api_v1_tasks__task_id__reopen_post) |
| Comment | `POST /api/v1/comments` with `{"task_id":"...","content":"..."}`. Exactly one of `task_id` or `project_id`. Content is at most 15000 chars. | [comment](https://developer.todoist.com/api/v1/#tag/Comments/operation/create_comment_api_v1_comments_post) |
| Section | `POST /api/v1/sections` with `{"name":"...","project_id":"..."}` | [section](https://developer.todoist.com/api/v1/#tag/Sections/operation/create_section_api_v1_sections_post) |
| Project | `POST /api/v1/projects` with `{"name":"...","color":"charcoal","view_style":"list"}` | [project](https://developer.todoist.com/api/v1/#tag/Projects/operation/create_project_api_v1_projects_post) |
| Archive project | `POST /api/v1/projects/{id}/archive` (and `/unarchive`) | [archive](https://developer.todoist.com/api/v1/#tag/Projects/operation/archive_project_api_v1_projects__project_id__archive_post) |

- The close and reopen 200 responses have an empty schema. **AMBIGUOUS:** they may return 204 or `{}`. Treat any 2xx as success.
- One docs curl sample (`POST /comments`) sends `X-Request-Id: $(uuidgen)`, and the TS SDK accepts an optional `requestId` on writes. The semantics (idempotency?) are not documented in v1. **AMBIGUOUS. Use sync `uuid` when you need guaranteed idempotency.**

## 4. CRITICAL: rescheduling a recurring task without killing recurrence

**What the official docs say (verbatim, [D#tag/Due-dates](https://developer.todoist.com/api/v1/#tag/Due-dates)):**

> "In addition, any of these due dates can be set to recurring or not, depending on the date string, provided by the client."

> (Create or update due date from a date object) "Note that this approach does not allow you to create recurring due dates."

> "You may provide all fields of an object in the constructor, but it's more convenient to provide only a subset of the fields and let the server fill the gaps."

> `lang`: "Used by clients and on the server side to properly process due dates when date object is not set, and when dealing with recurring tasks."

The docs have **no explicit "reschedule recurring task" section.** Reading them together:

- `due: {"string": "friday"}` (or REST `due_string: "friday"`) re-parses the string. "friday" is not a recurring string, so **recurrence is lost.**
- `due: {"date": "2026-10-30"}` alone (or REST `due_date` alone) is "from a date object", which "does not allow you to create recurring due dates". **Assume recurrence is lost.**

**Confirmed working method (from Doist's own code).** Todoist's official MCP server ([Doist/todoist-mcp `src/tools/reschedule-tasks.ts`](https://github.com/Doist/todoist-mcp/blob/main/src/tools/reschedule-tasks.ts), PR [#382](https://github.com/Doist/todoist-mcp/pull/382), Mar 2026) does a **Sync `item_update` with the new `date` plus the task's existing `string`, `is_recurring`, `timezone`, and `lang`**:

```json
[{"type": "item_update", "uuid": "<uuid4>",
  "args": {"id": "6X7rM8997g3RQmvh",
           "due": {"date": "2026-10-30T09:00:00",
                   "string": "every day at 9am",
                   "is_recurring": true,
                   "timezone": null,
                   "lang": "en"}}}]
```

- The PR text says: "The existing `update-tasks` tool uses the REST API which replaces the entire `dueString`, wiping recurrence patterns. This new tool updates only `due.date` while keeping `isRecurring`, `string`, `timezone`, and `lang` intact." It also reports a "Manual test: rescheduled a recurring 'every 3 days at 10am' task — recurrence pattern preserved".
- The motivating issue, [Doist/todoist-mcp#279](https://github.com/Doist/todoist-mcp/issues/279), says: "using `update-tasks` with `dueString: "friday"` wipes out the recurrence entirely. Using `dueString: "every day starting friday"` keeps it recurring but changes the pattern string."
- Time handling in that tool: if the new value is date-only and the task already had a time, it re-appends the old time. You must do this yourself: build `YYYY-MM-DDTHH:MM:SS` from the old `date`'s time part, and keep the `Z` suffix if the old date had one.
- **The REST v1 update endpoint has no way to send `string` and `date` together.** It takes `due_string`, `due_date`, and `due_datetime` as separate fields. **So always reschedule recurring tasks through `/sync` `item_update`.**
- **Rules for the app:**
  1. Read the current `due` from the local cache.
  2. If `is_recurring`, send the full due object with the new `date`.
  3. After the sync, verify the returned or next-synced task still has `is_recurring: true`. If not, alert and roll back by sending the old due object.
- **Still AMBIGUOUS (undocumented):** what the next occurrence becomes after completion when the new date is off-pattern (e.g. an "every monday" task moved to Wednesday). The UI moves only that occurrence. Expect the server to recompute from the pattern, but test it.
- Completing a recurring task: use `item_close` or `POST /tasks/{id}/close`, never `item_complete`. `item_complete` archives the task.

## 5. Quick Add — `POST https://api.todoist.com/api/v1/tasks/quick`

Source: [D quick_add](https://developer.todoist.com/api/v1/#tag/Tasks/operation/quick_add_api_v1_tasks_quick_post)

- JSON body: `{"text": "Buy milk today at 5pm #Shopping @groceries p1", "note": null, "reminder": null, "auto_reminder": false, "meta": false}`. Only `text` is required.
- Parses, quoting the docs: due dates ("`today`, `tomorrow at 5pm`, `next Monday`"), projects ("`#ProjectName` (use `#My\\ Project` for names with spaces)"), sections ("`/SectionName` (requires a project to be specified)"), labels (`@labelname`), priority ("`p1` to `p4`, `P1` to `P4`, or `!!1` to `!!4`"), assignees (`+Name`), deadlines ("`{date expression}`"), reminders (`!30m`, `!1h`, `!0mb`, `!14:00`), and descriptions ("` // description text` (must be at the end)").
- "If parsing fails for any element, the task is still created (with unparsed text remaining in the content)". `meta: true` adds a `meta` object showing how the text was parsed.
- Duration: not listed in the API doc. The Help Center documents Quick Add duration syntax "for 1h" / "for 1h15m" / "from 21:00 to 22:00" ([help](https://www.todoist.com/help/articles/set-a-task-duration-L1kYkZv8d)). Since quick add uses "the same parsing engine as Todoist's official clients", it probably works, **but durations are not on the Free plan** (section 6).
- Response: schema is `object (additionalProperties)`. The official TS SDK types it as a `Task` ([sdk](https://github.com/Doist/todoist-sdk-typescript/blob/main/src/todoist-api.ts)). **AMBIGUOUS: expect a task object; the docs show no example.**
- `note` is ignored if the plan lacks comments. `reminder` is "silently ignored" if the plan lacks reminders or the text can't be parsed.

## 6. Duration

- Format: `{"amount": <positive int>, "unit": "minute" | "day"}` or `null`. Quote: "Both the `amount` and `unit` **must** be defined." REST uses flat `duration` + `duration_unit`, and `duration` is "Only used if `duration_unit` is also provided." ([D#tag/Sync/Tasks](https://developer.todoist.com/api/v1/#tag/Sync/Tasks), [D update](https://developer.todoist.com/api/v1/#tag/Tasks/operation/update_task_api_v1_tasks__task_id__post))
- Quote: "The API accepts durations longer than 24 hours, but the Todoist web and desktop date picker limits duration edits to 24 hours." The Help Center says "The maximum duration time you can set for a task is 24 hours." **Cap at 24h in the app** to stay UI-compatible.
- Does it need a due datetime? The API docs say nothing. The Help Center says you can set one "with or without a date and time". **AMBIGUOUS** for the API. Only attach a duration when the task has a timed due.
- **Plan gate:** Help Center plans FAQ marks "Task durations | ❌" for Beginner/Free ([plans FAQ](https://www.todoist.com/help/account-and-billing/plans/todoist-plans-pricing-and-billing-faq-Vq2z0HWL6)), and the pricing page lists "Task duration" only under Pro. The API exposes the flag as `user_plan_limits.current.durations`. Oddly, the docs' *example* free-plan object shows `"durations": true`. **Check the flag at runtime. On Free, expect duration writes to be rejected or ignored, and keep durations app-side (local DB / calendar event length) instead.**

## 7. Archiving and Free-plan limits

- Archive: sync `project_archive {"id"}` or `POST /api/v1/projects/{id}/archive`. Unarchive: `project_unarchive` or `POST .../unarchive`. List archived: `GET /api/v1/projects/archived` (paginated). For personal projects, archiving applies "just for the initiating user". ([D archive](https://developer.todoist.com/api/v1/#tag/Projects/operation/archive_project_api_v1_projects__project_id__archive_post))
- Delete exists (`project_delete`, `DELETE /api/v1/projects/{id}`), but per the requirement **never call it**.
- **Free limit: 5 active personal projects, including sub-projects.** Help Center: "Active personal projects (including sub-projects)" is "Up to 5" for Beginner, 300 for Pro ([usage limits](https://todoist.com/help/articles/205064592), [plans FAQ](https://www.todoist.com/help/account-and-billing/plans/todoist-plans-pricing-and-billing-faq-Vq2z0HWL6)). The API docs' example free plan object has `"max_projects": 5, "max_sections": 20, "max_tasks": 300, "max_filters": 3, "max_labels": 500, "reminders": false, "comments": true, "activity_log_limit": 7` ([D#tag/Sync/User](https://developer.todoist.com/api/v1/#tag/Sync/User)).
  - Other limits (all plans): 20 sections per project, 300 active tasks per project (incl. sub-tasks and recurring), comment ≤ 15000 chars.
  - **AMBIGUOUS:** neither source says whether **Inbox counts**. The wording "active" implies **archived projects don't count**, but that isn't stated. With 3 projects including Inbox, the user has **2 left (safe assumption, counting Inbox)**. In code, read `user_plan_limits.current.max_projects` and count non-archived, non-deleted projects including Inbox. Refuse to `project_add` at the limit.
  - The error returned when you exceed the limit is not documented.

## 8. Rate limits and pagination

- Documented limits ([D#tag/Request-limits](https://developer.todoist.com/api/v1/#tag/Request-limits)), verbatim:
  - "For each user, you can make a maximum of 1000 partial sync requests within a 15 minute period."
  - "For each user, you can make a maximum of 100 full sync requests within a 15 minute period."
  - "You can reduce the number of requests you make by batching up to 100 commands in each request and it will still count as one."
  - Also: a 1 MiB POST body, 65 KiB of headers, and a 15 s processing timeout per standard request.
- **AMBIGUOUS: no separate number is documented for the REST v1 endpoints** (`/tasks`, `/projects`, ...). Handle 429 by sleeping `error_extra.retry_after` (or the `Retry-After` header) seconds. Prefer `/sync` for bulk work.
- Pagination ([D#tag/Pagination](https://developer.todoist.com/api/v1/#tag/Pagination)): cursor-based. Responses are `{"results": [...], "next_cursor": "..." | null}`. Pass `?cursor=<next_cursor>&limit=N` with `limit` default 50 and max 200 (above 200 gives 400 `INVALID_ARGUMENT_VALUE`).
  - "Always use the same parameters (filters, sorting, etc.) when using a cursor."
  - "Don't store cursors long-term."
  - Paginated endpoints: `/tasks`, `/tasks/filter`, `/labels`, `/labels/shared`, `/comments`, `/sections`, `/projects`, `/projects/archived`, `/projects/{id}/collaborators`, `/activities`.
  - The completed-tasks endpoint uses `items` + `next_cursor`, where `next_cursor` is "Omitted when there is no next page". This is a different key name from `results`.

## 9. Completed tasks (for logging completions)

- `GET /api/v1/tasks/completed/by_completion_date?since=<RFC3339>&until=<RFC3339>[&project_id=&section_id=&parent_id=&filter_query=&cursor=&limit=]` ([D](https://developer.todoist.com/api/v1/#tag/Tasks/operation/tasks_completed_by_completion_date_api_v1_tasks_completed_by_completion_date_get))
  - `since` is inclusive and `until` is exclusive. The window is "strictly limited by the specified completion date range (up to 3 months)". Default limit is 50.
  - Response is `{"items": [Task...], "next_cursor": "..."}`. Each item has `completed_at`, `completed_by_uid`, and `completed_count`.
  - Also available: `GET /api/v1/tasks/completed/by_due_date` and `GET /api/v1/tasks/completed/stats`.
  - The plan flag is `completed_tasks` ("Whether the user can search in the completed tasks archive"). The docs' free example shows `true`. **Verify at runtime.**
- Recurring completions **do not archive the task.** `item_close` just advances `due`, so they won't show up as `checked: true` in sync. To catch them:
  - (a) Log at the moment your app closes the task (most reliable).
  - (b) Use the activity log: `GET /api/v1/activities?event_type=completed` (or `object_event_types=["item:completed"]`, `date_from=`). An `item:updated` event carries `event_data_extra.update_intent` = `item_completed` for recurring completions ([D#tag/Activity](https://developer.todoist.com/api/v1/#tag/Activity)). **Free plan activity history = 7 days** (`activity_log_limit: 7`).
  - (c) Watch `completed_count` on the REST task object ("Increments on every completion, including recurring occurrences"). **AMBIGUOUS:** it's documented on the REST `ItemSyncView` schema and not shown in the Sync item example.

## Gotchas checklist

1. Old REST v2 and Sync v9 endpoints return 410. Use only `https://api.todoist.com/api/v1/...` with lowercase paths and new string IDs.
2. Priority is inverted (API 4 = p1). The REST body schema description contradicts this; trust the Sync docs.
3. The v1 `due` has no `datetime`. Time lives in `due.date`. A trailing `Z` means fixed-zone UTC; no `Z` means floating.
4. Reschedule a recurring task = Sync `item_update` with `due: {date: NEW, string: OLD, is_recurring, timezone, lang}`. Never send `due_string`, or `due_date` alone, for recurring tasks.
5. "Done" = `item_close` (recurring-aware), not `item_complete`.
6. A sync HTTP 200 can hide per-command errors. Check `sync_status`. Reuse the `uuid` on retry, and don't retry 400 command errors.
7. Free plan: 5 active projects (Inbox counting is unclear), no durations, no custom reminders, 7-day activity log. Read `user_plan_limits` at startup.
8. 100 full syncs and 1000 incremental syncs per 15 min per user. Do one full sync, then incremental only, and do one extra incremental sync right after a full sync.
