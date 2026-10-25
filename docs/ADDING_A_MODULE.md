# Adding a module

Every feature in Margin is a module: a folder under `modules/` that the daemon discovers at boot and
the web app discovers at build time. Adding one never requires editing core files.

## 1. Scaffold

```bash
npm run new-module -- reading-log "Track pages read per day"
```

This copies `modules/_template` to `modules/reading-log`, renames ids, and runs its test. (In Claude
Code, the `/new-module` skill does the same from a one-line description and then fills in the logic.)

## 2. The server half: `manifest.ts`

```ts
export default defineModule({
  id: 'reading-log',                 // must equal the folder name
  name: 'Reading log',
  description: 'Track pages read per day.',
  defaultEnabled: true,              // core: true makes it impossible to turn off
  requires: ['day'],                 // other modules that must be on
  settings: z.object({ dailyPages: z.number().int().default(20).describe('Pages per day') }),
  migrations: [`CREATE TABLE reading (id TEXT PRIMARY KEY, date TEXT NOT NULL, pages INTEGER NOT NULL)`],
  service: (ctx) => ({ total: (from, to) => … }),     // ctx.service('reading-log').total(…)
  routes(r, ctx) { r.get('/days', (c) => c.json(…)); },    // → GET /api/reading-log/days
  jobs: [{ id: 'nudge', at: () => ['19:00'], run: (ctx) => … }],
  notifications: (ctx, date) => [{ key: `reading:${date}`, at: at(date, '19:00'), title: '…', body: '…', category: 'wellbeing' }],
  emits: ['reading.logged'],
  on: { 'shutdown.completed': (p, ctx) => … },
  rules: { conditions: [{ id: 'reading.missed_two', label: '…', description: '…', params: z.object({}), evaluate: (ctx) => ({ met, detail }) }] },
  claude: { tools: [{ name: 'reading_days', kind: 'read', description: '…', input: z.object({}), run: (ctx) => … }] },
  nav: [{ id: 'reading', label: 'Reading', icon: 'BookOpen', path: '/reading', section: 'main', order: 60 }],
  widgets: [{ id: 'today', slot: 'today.side', order: 50 }],
});
```

Rules of the road:

- **Settings**: every field needs `.default()`; add `.describe()` text — it becomes the label hint in
  the generated Settings form. Time fields use the `^\d{2}:\d{2}$` pattern to get a time picker;
  weekday arrays (`min(1).max(7)` items) get a day picker.
- **Migrations** are append-only. Ship a new array entry to change a table; never edit an old one.
- **Notifications**: categories are `work` (silenced in Evening mode and on the off-day),
  `wellbeing` (always allowed, e.g. lights-out cue), `system`. Keys must be unique per occurrence.
- **Writes to Todoist/Google** in bulk: `ctx.changes.propose({ source, title, summary, changes })`
  with kinds like `todoist.task.reschedule`, `gcal.event.create`. Register new kinds with
  `ctx.changes.register(kind, { label, apply, editable })` in `init`.
- **Time**: only `src/core/time.ts` helpers. Add a DST test if the module schedules anything.

## 3. The web half: `web/index.tsx`

```tsx
export default defineWebModule({
  id: 'reading-log',
  routes: [{ path: '/reading', component: ReadingPage }],   // work: true to gate after the stop
  widgets: { today: ReadingWidget },                        // ids match manifest.widgets
  commands: [{ id: 'reading.log', label: 'Log reading', group: 'Reading', run: () => '/reading' }],
});
```

Build screens from `@web/ui` and wrap pages in `<Page title=…>`. Fetch with `useApi('/api/…')`, write
with `useAction('post', '/api/…')`. Put module CSS in `web/reading-log.css` and import it.

## 4. Test

Create `modules/reading-log/reading-log.test.ts`:

```ts
import { testApp } from '../../tests/helpers';
const app = await testApp({ at: '2026-10-31T20:00:00-04:00', only: ['day', 'reading-log'] });
const r = await app.req('GET', '/api/reading-log/days');
```

Run `npm test`, `npx tsc --noEmit -p tsconfig.json`, and `npm run build`.

## 5. Turn it on

Modules appear in Settings → Modules. Toggling is live; data is kept when a module is off.
