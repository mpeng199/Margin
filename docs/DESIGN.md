# Design

**Thesis.** A calm Mac utility whose one job is to protect the stop. It should feel like a well-made Apple
utility (System Settings, Reminders, Calendar) that happens to know a lot about recovery.

**Signature: the horizon.** The day is drawn as a horizon: daylight from wake to the hard stop, a crisp
line at the stop, dusk until lights-out. The same idea scales: the Today ribbon, the dusk tint after each
day's stop in the calendar, and Evening mode, where the whole app "sets" into the dusk palette. The app icon
is the sun half-set on a horizon. That's the only bold move; everything else is quiet.

**Platform first.** System font (SF Pro) at macOS text sizes (13 pt body, Title 1 22, Large Title 26);
the system accent color for controls (the shell reads it from macOS); light and dark follow the system
(no in-app appearance switch, per HIG); vibrancy only on the sidebar and capture panel (the functional
layer), never on content; native menu bar with every command; ⌘K palette; standard shortcuts.

**Vernacular.** Grouped inset lists (System Settings) rather than a card grid. Radius grows with container
size: controls 6, groups 10, sheets 14. Hairline separators inset from the leading edge.

**Color has one meaning each.** Accent = action and selection. Amber = needs a decision / over capacity.
Green = on track (rare). Red = Get help and red flags only. Dusk = evening. Text contrast ≥ 4.5:1 in both
appearances; increased-contrast and reduced-transparency are handled in `tokens.css`.

**Copy.** Direct, specific, sentence case; buttons in Title Case. No cheerleading, no guilt, no exclamation
marks. Misses are data. Every core rule carries a one-line why with its source.

**Motion.** Brief and functional (sheets rise 180 ms, toggles 180 ms); everything respects reduced motion.

**Avoided defaults.** No warm-cream + serif + terracotta, no black + acid accent, no broadsheet hairlines,
no gradient cards, no all-caps eyebrows. The Apple HIG references used are vendored in
`.claude/skills/apple-design/`.
