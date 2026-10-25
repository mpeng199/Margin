---
name: new-module
description: Scaffold, wire, and test a new Margin module from a one-line description. Use when the user asks to add a feature, habit type, rule, tracker, screen, or integration to Margin ("add a reading log", "new module for X", "/new-module ...").
---

# New Margin module

Turn a one-line description into a working, tested module without touching core files.

1. Read `CLAUDE.md`, `docs/ADDING_A_MODULE.md`, and `src/core/types.ts`. Skim `modules/day/` as the reference module.
2. Pick an id (lowercase, dashes) and run `npm run new-module -- <id> "<description>"`. It copies `modules/_template`, renames everything, and runs the generated test.
3. Design before coding (write it as a short comment at the top of `manifest.ts`):
   - what it stores (tables → `migrations`), its settings (zod, all defaulted, `.describe()`d),
   - the service other modules may call, routes, events it emits/consumes (match names in CLAUDE.md),
   - Today widgets / nav (slots and order from `docs/AGENT_BRIEF.md`), rule conditions/actions, Claude tools,
   - any scheduled notifications (category `work` is silenced after the stop and on the off-day).
4. Implement `manifest.ts`, then `web/index.tsx` using `@web/ui` components and `useApi`/`useAction`.
   Bulk writes to Todoist/Google go through `ctx.changes.propose`. Time math only via `src/core/time.ts`.
   Copy: direct, no cheerleading or guilt; add a why-line with a source for any rule.
5. Write tests in `modules/<id>/<id>.test.ts` with `testApp({ at, only })`, covering every rule the module
   enforces, and a DST case (Sun Nov 1, 2026) if it schedules anything.
6. Verify: `npx vitest run modules/<id>`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`. Then check it in
   the running app (Settings → Modules shows it; toggling is live).
