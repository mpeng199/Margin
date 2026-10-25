# Google Calendar API + OAuth (desktop app) research

Researched 2026-10-24 from the live docs. I fetched the pages with curl and converted them to text, so the quotes are verbatim. No authenticated calls were made.
Short names used below:
- NA = https://developers.google.com/identity/protocols/oauth2/native-app
- O2 = https://developers.google.com/identity/protocols/oauth2
- CA = https://developers.google.com/workspace/calendar/api/auth
- REF = https://developers.google.com/workspace/calendar/api/v3/reference

Base URL for all Calendar calls: `https://www.googleapis.com/calendar/v3`

---

## 1. Desktop OAuth: loopback redirect + PKCE

### Client type and secret
- Create the client as **"Desktop app"**. Quote: "Your client ID and client secret are generated ... Desktop apps are public clients and cannot keep secrets confidential. Always use PKCE (Proof Key for Code Exchange) when requesting authorization codes." ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#creatingcred))
- `client_secret` is marked **"Optional"** in both the token exchange and the refresh table ([NA step 5](https://developers.google.com/identity/protocols/oauth2/native-app#exchange-authorization-code), [NA refresh](https://developers.google.com/identity/protocols/oauth2/native-app#offline)). **AMBIGUOUS:** historically Google rejected Desktop-client token calls that lacked the secret. Ship the secret in the app config and always send it. It's not really secret for public clients, but keep it out of git anyway.
- Console change (Apr 2025 blog): "Once the creation screen is closed, the client secret will not be shown again. ... Developers will need to download their OAuth client secrets when they're created". Also: "OAuth clients inactive for 6 months will be automatically deleted" (restorable for 30 days). ([Google Developers Blog, 2025-04-28](https://developers.googleblog.com/usability-and-safety-updates-to-google-auth-platform/))

### Step 1: PKCE ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#step1-code-verifier))
- `code_verifier` is 43–128 chars from `[A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"`.
- `code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))` (no padding), with `code_challenge_method=S256`.
- If `code_challenge_method` is omitted, it "defaults to `plain`". **Always send S256.**

### Step 2: auth URL — `GET https://accounts.google.com/o/oauth2/v2/auth` ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#obtainingaccesstokens))

| param | value |
|---|---|
| `client_id` | from the console (required) |
| `redirect_uri` | `http://127.0.0.1:PORT` (required). "start an HTTP listener on a random available port. Substitute port with the actual port number". `localhost` also works "but this configuration may cause issues with client firewalls". |
| `response_type` | `code` (required) |
| `scope` | space-delimited (required) |
| `code_challenge` / `code_challenge_method` | `S256` ("Recommended"; treat as required) |
| `state` | random value; verify it on return (CSRF). "The OAuth client must prevent CSRF". |
| `login_hint` | optional email |
| `access_type=offline`, `prompt=consent` | **Not in the desktop param table.** The desktop doc says "Note that refresh tokens are always returned for installed applications." These params are documented for the web-server flow ([web-server doc](https://developers.google.com/identity/protocols/oauth2/web-server#request-parameter-access_type)), where `prompt=consent` forces re-consent and a new refresh token. Sending both is harmless and makes re-auth reliably return a refresh token. |
| `include_granted_scopes` | **Don't rely on it.** Quotes: "Incremental authorization is not supported for installed apps or devices." and "incremental authorization with installed apps is not supported due to the fact that the client cannot keep the `client_secret` confidential." ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#identify-access-scopes)) |

Example (from the docs, with scopes swapped in):
```
https://accounts.google.com/o/oauth2/v2/auth?
 scope=https%3A//www.googleapis.com/auth/calendar.calendarlist.readonly%20https%3A//www.googleapis.com/auth/calendar.events.readonly%20https%3A//www.googleapis.com/auth/calendar.app.created&
 response_type=code&
 state=<random>&
 redirect_uri=http%3A//127.0.0.1%3A9004&
 client_id=<client_id>&
 code_challenge=<S256 challenge>&code_challenge_method=S256&
 access_type=offline&prompt=consent
```
The redirect lands on `http://127.0.0.1:9004/?code=...&state=...` or `?error=access_denied`. "for best usability it should respond by displaying an HTML page that instructs the user to close the browser and return to your app." Open the URL in the **system browser**, never a WKWebView: that gives `disallowed_useragent`.

### Step 5: token exchange — `POST https://oauth2.googleapis.com/token` (form-encoded) ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#exchange-authorization-code))
```
POST /token HTTP/1.1
Host: oauth2.googleapis.com
Content-Type: application/x-www-form-urlencoded

code=4/P7q7W91a-oMsCeLvIaQm6bTrgtp7&client_id=your_client_id&client_secret=your_secret&
redirect_uri=http://127.0.0.1:9004&grant_type=authorization_code&code_verifier=<verifier>
```
Response:
```json
{"access_token": "1/fFAGRNJru1FTz70BzhT3Zg", "expires_in": 3920, "token_type": "Bearer",
 "scope": "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/calendar.readonly",
 "refresh_token": "1//xEoDL4iW3cxlI7yDbSRFYNG01kVKM2C-259HOF2aQbI"}
```
- `redirect_uri` must be byte-identical to the one in the auth URL, including the port.
- **Granular consent:** users can untick scopes. "Your app must verify which scopes were actually granted ... examine the `scope` field in the access token response." ([NA step 6](https://developers.google.com/identity/protocols/oauth2/native-app#check-granted-scopes)) Store the granted scope set and disable features accordingly.
- DPoP is optional ("recommended"). Skip it for v1 of the app.

### Refresh — `POST https://oauth2.googleapis.com/token` ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#offline))
```
client_id=your_client_id&client_secret=your_secret&refresh_token=<refresh_token>&grant_type=refresh_token
```
Response: `{"access_token":"...","expires_in":3920,"scope":"...","token_type":"Bearer"}`. No new refresh token is returned; keep the old one.
- Limits: "There is currently a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID. If the limit is reached, creating a new refresh token automatically invalidates the oldest refresh token without warning." ([O2](https://developers.google.com/identity/protocols/oauth2#expiration))
- A refresh token dies when: access is revoked; it's "not been used for six months"; the account exceeds the live-token limit; Testing-mode expiry (section 3); and other admin cases. ([O2](https://developers.google.com/identity/protocols/oauth2#expiration))
- Error: `invalid_grant`, meaning "When refreshing an access token, the token may have expired or has been invalidated. Authenticate the user again" ([NA errors](https://developers.google.com/identity/protocols/oauth2/native-app#authorization-errors-invalid-grant)).

### Revoke — `POST https://oauth2.googleapis.com/revoke?token={token}` ([NA](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke))
- Send it with `Content-type: application/x-www-form-urlencoded`. Success is 200; failure is 400 with an error code.
- "If the token is an access token and it has a corresponding refresh token, the refresh token will also be revoked." Also: "Revocation removes all OAuth 2.0 scopes previously granted to a project".
- Revocation "might take some time before ... full effect".

## 2. Scopes

Full current list ([CA](https://developers.google.com/workspace/calendar/api/auth), matches [scopes page](https://developers.google.com/identity/protocols/oauth2/scopes#calendar)):

| Scope (`https://www.googleapis.com/auth/...`) | Meaning (verbatim) |
|---|---|
| `calendar` | See, edit, share, and permanently delete all the calendars you can access using Google Calendar. |
| `calendar.readonly` | See and download any calendar you can access using your Calendar. |
| `calendar.freebusy` | View your availability in your calendars. |
| `calendar.events` | View and edit events on all your calendars. |
| `calendar.events.readonly` | View events on all your calendars. |
| `calendar.settings.readonly` | View your Calendar settings. |
| `calendar.addons.execute` | Run as a Calendar add-on. |
| `calendar.addons.current.event.read` | See the events you open in Google Calendar. |
| `calendar.addons.current.event.write` | Edit the events you open in Google Calendar. |
| `calendar.events.owned` | See, create, change, and delete events on Google calendars you own. |
| `calendar.events.owned.readonly` | See the events on Google calendars you own. |
| `calendar.events.freebusy` | See the availability on Google calendars you have access to. |
| `calendar.app.created` | Make secondary Google calendars, and see, create, change, and delete events on them. |
| `calendar.calendarlist` | See, add, and remove Google calendars you're subscribed to. |
| `calendar.calendarlist.readonly` | See the list of Google calendars you're subscribed to. |
| `calendar.calendars` | See and change the properties of Google calendars you have access to, and create secondary calendars. |
| `calendar.calendars.readonly` | See the title, description, default time zone, and other properties of Google calendars you have access to. |
| `calendar.acls` | See and change the sharing permissions of Google calendars you own. |
| `calendar.acls.readonly` | See the sharing permissions of Google calendars you own. |
| `calendar.events.public.readonly` | See the events on public calendars. |

### Narrowest combination (checked against each method's "Authorization" table in REF)

- **(a) Read events from all calendars + list calendars:** `calendar.calendarlist.readonly` + `calendar.events.readonly`.
  - `calendarList.list` accepts only `calendar.readonly | calendar | calendar.calendarlist | calendar.calendarlist.readonly` ([REF calendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)).
  - `events.list` accepts `calendar.events.readonly` among others ([REF events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)).
  - This pair is narrower than `calendar.readonly`.
- **(b) Create own secondary calendars + fully manage their events:** `calendar.app.created` (**confirmed it exists**). It is listed on:
  - `calendars.insert`: `calendar | calendar.app.created | calendar.calendars` ([REF](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert))
  - `calendarList.patch`: `calendar | calendar.app.created | calendar.calendarlist` ([REF](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/patch))
  - `events.insert`, `events.patch`, `events.delete`: `calendar | calendar.events | calendar.app.created | calendar.events.owned` ([insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete))
  - `events.list`
  - **AMBIGUOUS:** the per-calendar restriction (only calendars this app created) comes from the scope description, not from the method pages. Expect 403 on other calendars.
- **(c) Opt-in writes to primary:** `calendar.events.owned` (**confirmed current name**). There is **no primary-only scope**; this covers every calendar the user *owns*.
  - Because desktop apps get no incremental auth, opting in means running the **full consent flow again** with the base scopes + `calendar.events.owned`, then replacing the stored refresh token.
- Recommended base request: `calendar.calendarlist.readonly calendar.events.readonly calendar.app.created`. Add `calendar.events.owned` only on opt-in.

### Sensitive vs restricted
- **Restricted:** no Calendar scope appears on Google's restricted list. That list covers Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient, and Health scopes ([restricted scopes](https://support.google.com/cloud/answer/13464325)).
- **Sensitive:** the Calendar docs no longer print a per-scope category. The console's **Data Access → Add or Remove Scopes** dialog sorts scopes into "non-sensitive", "Your sensitive scopes", and "Your restricted scopes" ([configure consent](https://developers.google.com/workspace/guides/configure-oauth-consent)). Treat all Calendar data scopes as **sensitive (verification required for public apps)**.
- **AMBIGUOUS:** I couldn't find whether `calendar.app.created` / `calendar.calendarlist.readonly` are classified non-sensitive. Check the console dialog when adding them. For a personal app it doesn't matter (section 3).

## 3. Testing vs In production (7-day refresh tokens)

- Verbatim ([O2 Refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)): "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of "Testing" is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile (through the `userinfo.email, userinfo.profile, openid` scopes, or their OpenID Connect equivalents)."
- Audience doc ([Manage app audience](https://support.google.com/cloud/answer/15549945)):
  - Testing access is "limited to up to 100 test users listed in the OAuth consent screen".
  - "Test user authorizations expire seven days after consent."
  - To leave Testing, click **Publish app**, and the status becomes **In production**.
- What it looks like after 7 days: the refresh POST returns HTTP 400 with
  ```json
  {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
  ```
  The `error` code is in Google's docs ([NA invalid_grant](https://developers.google.com/identity/protocols/oauth2/native-app#authorization-errors-invalid-grant)). The exact `error_description` string isn't in the Google docs; it's the widely reported body ([Nango](https://nango.dev/blog/google-oauth-invalid-grant-token-has-been-expired-or-revoked)). Handle it by **clearing tokens and re-running the consent flow**. Don't retry.
- **Fix for a personal app:** set Audience to External and click **Publish app** (In production). Then **re-authorize once**, because the old Testing token stays dead. Production refresh tokens don't have the 7-day expiry (only the six-month-unused and similar rules apply).
- Unverified + in production, with sensitive scopes:
  - Users see the "unverified app" screen before consent. For personal use, "users will be allowed to click through 'unverified app' warning screens during sign-in" if the app is "for your personal use" with "fewer than 100 users" ([verification not needed](https://support.google.com/cloud/answer/13464323)).
  - Cap: "100 new users in total, after the app presents the unverified app screen", applied "for the project's lifetime" ([audience](https://support.google.com/cloud/answer/15549945), [unverified apps](https://support.google.com/cloud/answer/7454865)).
  - The click-through path is usually "Advanced → Go to <app> (unsafe)". **AMBIGUOUS:** the docs don't describe the exact UI text.
  - **Conclusion: publish to production without submitting for verification. You get the warning screen once per account, no 7-day expiry, and a 100-user ceiling, which is fine for one user.**

## 4. Incremental sync

Sources: [sync guide](https://developers.google.com/workspace/calendar/api/guides/sync), [REF events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

### events.list — `GET /calendars/{calendarId}/events`
- **Full sync:** list with your chosen fixed params and follow `pageToken` until a page carries `nextSyncToken`. Store that token per calendar. "the `nextSyncToken` field is present only on the very last page." New entries during pagination "won't be missed".
- **Incremental sync:** `GET ...?syncToken=<token>` plus the **same other params**. "the result will always contain deleted entries". If you get `nextPageToken`, repeat "the exact same list query ... (with the exact same `syncToken`), append the `pageToken`" until a new `nextSyncToken` appears.
- **Not allowed with `syncToken`** (verbatim list): `iCalUID`, `orderBy`, **`privateExtendedProperty`**, `q`, `sharedExtendedProperty`, **`timeMin`**, **`timeMax`**, **`updatedMin`**. Using them gives **400**. Also "it is not allowed to set `showDeleted` to False." "All other query parameters should be the same as for the initial synchronization to avoid undefined behavior."
  - **DOC CONFLICT:** the guide's Java sample sets `timeMin` (one year ago) on the *full* sync and then sends only `syncToken` on later calls. The reference says to keep params identical. Practical reading: you may bound the *full* sync with `timeMin`, but incremental calls must drop it. **Simplest safe choice: no time bounds, and use `singleEvents=true` consistently on both.**
- **410 Gone:** "If the `syncToken` expires, the server will respond with a 410 GONE response code and the client should clear its storage and perform a full synchronization without any `syncToken`." Error body:
  ```json
  {"error": {"errors": [{"domain": "calendar", "reason": "fullSyncRequired",
     "message": "Sync token is no longer valid, a full sync is required.", "locationType": "parameter", "location": "syncToken"}],
     "code": 410, "message": "Sync token is no longer valid, a full sync is required."}}
  ```
  A 410 with `reason: "deleted"` also occurs when deleting an already-deleted event; treat that as success. ([errors](https://developers.google.com/workspace/calendar/api/guides/errors))
- **`singleEvents`:** "Whether to expand recurring events into instances and only return single one-off events and instances of recurring events, but not the underlying recurring events themselves." Default false. The guide's incremental example uses `singleEvents=true`. **WARNING:** with `singleEvents=true` and no `timeMax`, an infinite recurring series expands forever. The docs don't state a cap, so **AMBIGUOUS**. Options: accept it and page through (`maxResults` default 250, max 2500), or sync masters with `singleEvents=false` and expand RRULEs locally.
- **`showDeleted`:** cancelled items appear in incremental results regardless. "If `showDeleted` and `singleEvents` are both True, only single instances of deleted events (but not the underlying recurring events) are returned."
- **Cancelled events in results** ([REF events `status`](https://developers.google.com/workspace/calendar/api/v3/reference/events)): "The list method returns cancelled events only on incremental sync (when `syncToken` or `updatedMin` are specified) or if the `showDeleted` flag is set to `true`."
  - "Cancelled exceptions of an uncancelled recurring event indicate that this instance should no longer be presented ... only guaranteed to have values for the `id`, `recurringEventId` and `originalStartTime` fields".
  - "All other cancelled events represent deleted events. Clients should remove their locally synced copies ... Deleted events are only guaranteed to have the `id` field populated."
- Response: `{"kind":"calendar#events","summary","timeZone","accessRole","nextPageToken"?,"nextSyncToken"?,"items":[...]}`. The docs say `nextPageToken` and `nextSyncToken` are mutually exclusive.

### calendarList.list — `GET /users/me/calendarList` ([REF](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list))
- Same token pattern. `maxResults` default 100, max 250.
- With `syncToken`, `minAccessRole` and `showOwnOrganizationOnly` are not allowed. "All entries deleted and hidden since the previous list request will always be in the result set and it is not allowed to set `showDeleted` neither `showHidden` to False." Expect 410 when the token expires.
- Quote: "If only read-only fields such as calendar properties or ACLs have changed, the entry won't be returned." So a renamed calendar (summary change) may not show up incrementally. **Re-fetch the full list occasionally** (e.g. daily).
- Entries have a `deleted: true` flag when removed.

## 5. Calendars and events CRUD

- **Create secondary calendar:** `POST /calendars` with body `{"summary": "minimike: Tasks", "timeZone": "America/Los_Angeles", "description": "..."}`. Only `summary` is required ([REF calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert)).
  - "This calendar is also added to the creator's calendar list, and cannot be removed, unless the calendar is deleted or transferred." ([concepts](https://developers.google.com/workspace/calendar/api/concepts/events-calendars))
  - Store the returned `id` (looks like `xxxx@group.calendar.google.com`).
  - **Make creation idempotent:** keep the id locally, and on startup check `calendarList` for it before creating another.
- **Color / visibility:** `PATCH /users/me/calendarList/{calendarId}` with `{"colorId": "7", "selected": true}`. `colorId` refers to the `calendar` section of `GET /colors`. Or send `?colorRgbFormat=true` with `{"backgroundColor":"#0088aa","foregroundColor":"#ffffff"}` ("supersedes the index-based colorId"). `selected` means "Whether the calendar content shows up in the calendar UI ... default is False." ([REF calendarList](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList))
- **Events:**
  - insert: `POST /calendars/{calendarId}/events`
  - patch: `PATCH /calendars/{calendarId}/events/{eventId}` (patch semantics: send only the fields to change)
  - delete: `DELETE /calendars/{calendarId}/events/{eventId}`
  - Query param `sendUpdates=none|all|externalOnly` controls invitation emails. For self-only events, leave it unset (the default is false/no notifications for insert).
- `colorId` + the new **event labels**:
  - `eventLabelVersion` default `0`: "Version `0` assumes no event label support and processes the `colorId` field". With `1`, "the `colorId` field is ignored."
  - So **don't send `eventLabelVersion=1`** if you use `colorId` (event `colorId` comes from the `event` section of `/colors`).
- **Your own event IDs (good for idempotent inserts):** "characters allowed ... base32hex ... lowercase letters a-v and digits 0-9", 5–1024 chars, unique per calendar. A duplicate gives **409 `duplicate`**, which you can treat as "already created". ([REF events `id`](https://developers.google.com/workspace/calendar/api/v3/reference/events))
- **Tagging app events** ([extended properties guide](https://developers.google.com/workspace/calendar/api/guides/extended-properties)):
  ```json
  PATCH /calendars/{calendarId}/events/{eventId}
  {"extendedProperties": {"private": {"minimikeTaskId": "6X7rM8997g3RQmvh", "minimikeVer": "1"}}}
  ```
  - Query them with `GET /calendars/{calendarId}/events?privateExtendedProperty=minimikeTaskId%3D6X7rM8997g3RQmvh`.
  - Private properties "are specific to the `calendarId` and `eventId` used in the request".
  - Delete a key by patching it to `null`. Note that "Any properties not included in an update request will be deleted" when you use `update` (PUT), which is one more reason to use PATCH.
  - Limits: key ≤ 44 chars ("longer keys will be silently dropped"), value ≤ 1024 chars ("silently truncated"), and ≤ 300 properties / 32 kB per event.
  - **DOC CONFLICT:** the guide says repeated `privateExtendedProperty` constraints "are OR'ed together", while the events.list reference says repeats "return events that match all given constraints". Use a single constraint per query.
  - **`privateExtendedProperty` cannot be combined with `syncToken`.** Use it for one-off lookups and filter synced events locally by `extendedProperties.private`.
- **Event JSON shape** ([REF events](https://developers.google.com/workspace/calendar/api/v3/reference/events)):
  ```json
  {"id": "...", "status": "confirmed", "summary": "Deep work: essay", "description": "...",
   "start": {"dateTime": "2026-10-25T09:00:00-07:00", "timeZone": "America/Los_Angeles"},
   "end":   {"dateTime": "2026-10-25T10:30:00-07:00", "timeZone": "America/Los_Angeles"},
   "colorId": "9", "transparency": "opaque",
   "extendedProperties": {"private": {"minimikeTaskId": "6X7rM8997g3RQmvh"}},
   "recurringEventId": "…only on instances…", "originalStartTime": {"dateTime": "…"},
   "updated": "2026-10-24T18:00:00.000Z", "etag": "\"…\""}
  ```
  - **All-day:** `"start": {"date": "2026-10-25"}, "end": {"date": "2026-10-26"}`. The end is **exclusive** ("The (exclusive) end time").
  - `dateTime` needs an offset "unless a time zone is explicitly specified in `timeZone`". For recurring events, `timeZone` "is required".
  - `status` is `confirmed` (default), `tentative`, or `cancelled`.
  - `transparency`: `opaque` (default, "Busy") or `transparent` ("Available").
  - `recurringEventId`: "For an instance of a recurring event, this is the `id` of the recurring event to which this instance belongs. Immutable."
  - `recurrence[]` holds RRULE/EXDATE lines ("DTSTART and DTEND lines are not allowed").
  - `eventType` can't change after creation. Values: `default`, `focusTime`, `outOfOffice`, `workingLocation`, `birthday`, `fromGmail`. Consider ignoring `workingLocation` and `birthday` when computing busy time.
  - Use `etag` + `If-Match` for safe updates; a mismatch gives 412 `conditionNotMet`.

## 6. Quotas and rate-limit errors

([usage limits](https://developers.google.com/workspace/calendar/api/guides/quota), [errors](https://developers.google.com/workspace/calendar/api/guides/errors))
- **New quota model from May 1, 2026:** "Cloud projects created on or after May 1, 2026 are subject to the new API quotas."
  - Per minute per project: **10,000 requests**. Per minute per user per project: **600 requests** (sliding window).
  - Daily billing threshold: **1,000,000 requests/day/project** before charges ("planned to incur charges ... later in 2026"). A personal app is nowhere near this.
- Errors to handle:
  - `403 userRateLimitExceeded` (back off).
  - `403 rateLimitExceeded` or `429 rateLimitExceeded`: "can return either 403 or 429 error codes—currently they are functionally similar and should be responded to in the same way, by using exponential backoff."
  - `403 quotaExceeded` "Calendar usage limits exceeded." (abuse limits, e.g. too many writes or calendar creations; back off for a long time).
  - `500 backendError` (back off).
  - `404 notFound`: the guide literally suggests "Use exponential backoff."
  - `409 duplicate`, `410` (see §4), and `412`.
  - Distinguish the 403 rate-limit cases by `error.errors[0].reason`, not by status code, because 403 `forbiddenForNonOrganizer` must not be retried.
- **Backoff** (verbatim algorithm): wait `min(((2^n)+random_number_milliseconds), maximum_backoff)` seconds, where `random_number_milliseconds` ≤ 1000 and "`maximum_backoff` is typically 32 or 64 seconds". Cap the retry count. Also: "Operational limits ... if you attempt to write to a single calendar in quick succession". **Serialize writes per calendar.**

## 7. Console setup (≈10 minutes, 2026 console names)

Sources: [configure consent](https://developers.google.com/workspace/guides/configure-oauth-consent), [create credentials](https://developers.google.com/workspace/guides/create-credentials), [Calendar quickstart](https://developers.google.com/workspace/calendar/api/quickstart/python), [audience](https://support.google.com/cloud/answer/15549945)

1. Go to https://console.cloud.google.com/ and sign in with the Google account whose calendar you'll use.
2. **Create a project:** project picker (top bar) → **New project** → name it `minimike` → **Create** → select it.
3. **Enable the API:** Menu ☰ → **APIs & Services → Library** → search "Google Calendar API" → **Enable**.
4. **Consent screen:** Menu ☰ → **Google Auth platform → Branding**. If you see "Google Auth platform not configured yet", click **Get Started**:
   - App Information: App name `minimike`, User support email = your email → **Next**
   - Audience: choose **External** (a personal Gmail can't pick Internal; Internal needs a Workspace org) → **Next**
   - Contact Information: your email → **Next**
   - Finish: tick **I agree to the Google API Services: User Data Policy** → **Continue** → **Create**
5. **Scopes:** **Google Auth platform → Data Access → Add or Remove Scopes**. Find these via the filter box (or the manual-entry box at the bottom of the dialog; exact label unverified):
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/calendar.app.created`
   - optional: `https://www.googleapis.com/auth/calendar.events.owned`

   Click **Update** → **Save**. (Note which section each one lands in: non-sensitive or sensitive.)
6. **Test user** (needed while in Testing): **Google Auth platform → Audience → Test users → Add users** → your email → **Save**.
7. **Create the client:** **Google Auth platform → Clients → Create Client** → Application type **Desktop app** → Name `minimike-desktop` → **Create**. **Download the JSON right now**, because the secret is not shown again after you close the dialog. Save it as `credentials.json` outside the repo (or in the app's config dir). It contains `installed.client_id` and `installed.client_secret`.
   - Do **not** tick "Use this client for an AI-powered agent". It can't be changed later.
   - Desktop clients have no redirect-URI field. The docs tell you to listen on "a random available port", which implies any `http://127.0.0.1:<port>` is accepted. That is widely relied on, but not stated in so many words.
8. **Publish:** **Google Auth platform → Audience → Publish app** → confirm. Status becomes **In production**. Don't click "Prepare for verification". Then sign in once from the app. Expect the "Google hasn't verified this app" screen, and click through (Advanced → continue). The refresh token now won't expire after 7 days.
9. If you authorized while still in Testing, re-authorize after publishing, because the old refresh token still dies at day 7.

## Gotchas checklist

1. Desktop apps get **no incremental auth**. Adding `calendar.events.owned` later means a full re-consent and a new refresh token. Always read the granted `scope`.
2. In Testing mode, the refresh token dies after 7 days with `invalid_grant`. Publish to production (unverified is fine for 1 user, with a warning screen and a 100-user lifetime cap).
3. `syncToken` can't be combined with `timeMin`, `timeMax`, `updatedMin`, `q`, `orderBy`, `iCalUID`, or `private`/`sharedExtendedProperty`. A 410 means wipe and fully resync that calendar. Store tokens per calendar.
4. Deleted and cancelled events come back in incremental results with only `id` guaranteed (cancelled recurring exceptions also carry `recurringEventId` and `originalStartTime`).
5. `calendarList` incremental sync skips changes to read-only fields (e.g. calendar renames). Refresh the full list periodically.
6. All-day `end.date` is exclusive. Recurring events require `start.timeZone`.
7. `colorId` is ignored if you send `eventLabelVersion=1`.
8. Treat 403 `rateLimitExceeded` and 429 the same: exponential backoff, keyed off `errors[0].reason`.
9. Download the client secret at creation time (it's masked afterwards). Clients unused for 6 months are auto-deleted.
