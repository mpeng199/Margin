import { DateTime } from 'luxon';

export const ZONE = 'America/New_York';
/** Server clock minus client clock; set from /api/day/state so "today" follows the daemon. */
let serverOffset = 0;
export const setServerOffset = (ms: number) => { serverOffset = ms; };
export const serverNow = () => Date.now() + serverOffset;
const nowDt = () => DateTime.fromMillis(serverNow(), { zone: ZONE });
export const dt = (iso: string) => DateTime.fromISO(iso, { zone: ZONE });
export const fmtTime = (iso: string) => dt(iso).toFormat('h:mm a');
export const fmtTimeShort = (iso: string) => { const d = dt(iso); return d.minute ? d.toFormat('h:mm') : d.toFormat('h'); };
export const fmtDay = (isoDate: string) => DateTime.fromISO(isoDate, { zone: ZONE }).toFormat('EEE, MMM d');
export const fmtDayLong = (isoDate: string) => DateTime.fromISO(isoDate, { zone: ZONE }).toFormat('EEEE, MMMM d');
export const todayISO = () => nowDt().toISODate()!;
export function fmtDur(min: number) {
  const m = Math.round(Math.abs(min));
  const s = min < 0 ? '−' : '';
  if (m < 60) return `${s}${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${s}${h}h ${r}m` : `${s}${h}h`;
}
/** "2:14" style countdown (h:mm), or "14 min" under an hour. */
export function fmtCountdown(min: number) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
export function relDay(isoDate: string) {
  const d = DateTime.fromISO(isoDate, { zone: ZONE }).startOf('day');
  const t = nowDt().startOf('day');
  const diff = Math.round(d.diff(t, 'days').days);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toFormat('EEEE');
  return d.toFormat('MMM d');
}
/** relDay for mid-sentence use: "today", "tomorrow", but "Monday", "Nov 8". */
export function relDayLower(isoDate: string) {
  const r = relDay(isoDate);
  return /^(Today|Tomorrow|Yesterday)$/.test(r) ? r.toLowerCase() : r;
}
