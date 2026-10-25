/**
 * The red flags from SPEC 4.14, phrased as plain questions. Shared by the server (which ids count) and the web
 * check. Any yes opens Get help. This is a prompt to talk to someone, not a screening tool or a diagnosis.
 */
export interface RedFlag { id: string; text: string }

export const RED_FLAGS: RedFlag[] = [
  { id: 'self_harm', text: 'I’ve had thoughts about dying, hurting myself, or suicide.' },
  { id: 'low_mood', text: 'I’ve felt low, or lost interest in things, on most days for two weeks or more.' },
  { id: 'panic_body', text: 'I’ve had panic attacks, or physical symptoms that keep coming back.' },
  { id: 'short_sleep', text: 'I’m sleeping under about 6 hours on most nights, even when I could sleep more.' },
  { id: 'coping', text: 'My eating or weight has changed a lot, or I’m using caffeine, nicotine, alcohol, or other drugs to get through.' },
  { id: 'functioning', text: 'Things are slipping even though I’m trying, or I’m no better after 2 to 3 weeks of this plan.' },
];

export const RED_FLAG_IDS = new Set(RED_FLAGS.map((f) => f.id));

/** Short, human labels for the reason a Get help request was opened. */
export function reasonLabel(reason: string): string {
  if (reason === 'baseline') return 'Something you shared during setup.';
  if (reason === 'red-flags') return 'Something you shared in a check.';
  return reason;
}
