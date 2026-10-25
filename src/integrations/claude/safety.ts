/**
 * Privacy and safety helpers shared by the ai module and the MCP server.
 *  - stripWellbeing: second line of defense for the "keep check-in data out of Claude" toggle.
 *  - detectCrisis: hopelessness / self-harm language in text the person typed.
 */
export const WELLBEING_KEY = /sleep|energy|mood|dread|bedtime|cynic/i;

/** Deep copy without any key named like sleep / energy / mood / dread / bedtime / cynicism. */
export function stripWellbeing<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripWellbeing(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (WELLBEING_KEY.test(k)) continue;
    out[k] = stripWellbeing(v, depth + 1);
  }
  return out as T;
}

const CRISIS: RegExp[] = [
  /\bsuicid(e|al)\b/,
  /\bkill(ing)? (myself|me)\b/,
  /\b(end|ending) (my (own )?life|it all)\b/,
  /\btake my (own )?life\b/,
  /\b(want|wanted|wanna|wish) (to|i (was|were)) (die|dead|disappear)\b/,
  /\bwish i (could )?(just )?(disappear|not wake up|wasn't here|wasn't alive)\b/,
  /\b(don't|do not|dont) want to (be here|live|exist|be alive|wake up)\b/,
  /\bself[- ]?harm\b/,
  /\b(hurt|hurting|harm|harming|cut|cutting) myself\b/,
  /\bbetter off (dead|without me)\b/,
  /\bno (reason|point) (to|in) (live|living|go on|going on|being alive|anything)\b/,
  /\bcan't (do this|go on|take (it|this)) (anymore|any more|any longer)\b/,
  /\b(i'm|i am|i feel|feel|feeling|everything's|everything is|it's|it is|life's|life is) (so |totally |completely |just )?hopeless\b/,
  /\bhopelessness\b/,
  /\bno hope\b/,
];

export function detectCrisis(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  return CRISIS.some((re) => re.test(t));
}

/** Shown when the provider is off, over budget, or fails during a crisis message. */
export const CARE_TEXT =
  'I’m glad you said something. This sounds heavy, and it matters more than any plan. ' +
  'If you might hurt yourself, call or text 988 (the Suicide & Crisis Lifeline) right now, or call 911 if you’re in danger. ' +
  'Please also tell a trusted adult today — a parent, a counselor, a doctor, someone close. You don’t have to carry this alone. ' +
  'Margin opened its Get help page for you. The planning can wait.';
