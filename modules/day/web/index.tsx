import { useState } from 'react';
import { defineWebModule } from '@web/lib/module';
import { useApi, useAction } from '@web/lib/query';
import { useDay, useNow } from '@web/lib/hooks';
import { Section, Group, Item, Button, Sheet, Input, Tag, CapacityBar, Icon, Banner } from '@web/ui';
import { dt, fmtTime, fmtDur, fmtCountdown, fmtTimeShort } from '@web/lib/format';
import type { Capacity } from '../capacity';
import type { TimelineItem } from '../manifest';

/** The signature: the day as a horizon. Daylight until the stop, dusk until lights-out. */
function Horizon() {
  const day = useDay();
  const now = useNow(15_000);
  const timeline = useApi<TimelineItem[]>(day.data ? `/api/day/timeline?date=${day.data.date}` : null);
  const [late, setLate] = useState(false);
  const d = day.data;
  if (!d) return null;
  const a = d.anchors;
  const t0 = dt(a.wake).toMillis();
  const t1 = dt(a.lightsOut).toMillis();
  const span = t1 - t0;
  const pos = (iso: string | number) => `${Math.max(0, Math.min(100, (((typeof iso === 'number' ? iso : dt(iso).toMillis()) - t0) / span) * 100))}%`;
  const stopPct = pos(a.effectiveStop);
  const toStop = Math.round((dt(a.effectiveStop).toMillis() - now) / 60000);
  const busy = (timeline.data ?? []).filter((i) => i.busy && !i.allDay);
  return (
    <Section>
      <div className="horizon-card group pad">
        <div className="horizon-head">
          <div>
            <div className="horizon-count num">{toStop > 0 ? fmtCountdown(toStop) : '0 min'}</div>
            <div className="muted">{toStop > 0 ? `until your stop at ${fmtTime(a.effectiveStop)}` : `Your stop was ${fmtTime(a.effectiveStop)}`}</div>
          </div>
          {d.lateNight ? <Tag tone="dusk">Late night +{d.lateNight.extensionMin}m</Tag> : null}
        </div>
        <div className="horizon-flag small num" style={{ right: `calc(100% - ${stopPct})` }}>Stop {fmtTimeShort(a.effectiveStop)}</div>
        <div className="horizon" aria-hidden="true">
          <div className="horizon-day" style={{ width: stopPct }} />
          <div className="horizon-dusk" style={{ left: stopPct }} />
          {busy.map((b) => (
            <div key={b.id} className="horizon-busy" style={{ left: pos(b.start), width: `calc(${pos(b.end)} - ${pos(b.start)})` }} title={`${b.title} ${fmtTimeShort(b.start)}–${fmtTimeShort(b.end)}`} />
          ))}
          <div className="horizon-stop" style={{ left: stopPct }} />
          {now > t0 && now < t1 && <div className="horizon-now" style={{ left: pos(now) }} />}
        </div>
        <div className="horizon-labels small num">
          <span>Wake {fmtTimeShort(a.wake)}</span>
          <span>Lights-out {fmtTimeShort(a.lightsOut)}</span>
        </div>
        {a.notes.map((n) => <p key={n} className="small muted" style={{ marginTop: 8 }}>{n}</p>)}
        <div className="row" style={{ marginTop: 12 }}>
          <span className="why-line grow">Detaching after hours has the strongest link to lower fatigue (Bennett 2018).</span>
          {!d.lateNight && d.mode === 'day' && (
            <Button variant="plain" onClick={() => setLate(true)} disabled={!d.lateNightAvailable.allowed} title={d.lateNightAvailable.reason}>Late night…</Button>
          )}
        </div>
      </div>
      <LateNightSheet open={late} onClose={() => setLate(false)} />
    </Section>
  );
}

function LateNightSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const day = useDay();
  const [reason, setReason] = useState('');
  const declare = useAction('post', '/api/day/late-night', () => onClose());
  const d = day.data;
  if (!d) return null;
  const ext = 60;
  return (
    <Sheet open={open} onClose={onClose} title="Declare a late night"
      subtitle={`Tonight’s stop moves up to ${ext} minutes later. Lights-out stays at ${fmtTime(d.anchors.lightsOut)}. One per week, declared before 4 PM.`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!reason.trim() || declare.isPending} onClick={() => declare.mutate({ reason } as any)}>Declare Late Night</Button></>}>
      <Input style={{ width: '100%' }} autoFocus placeholder="What needs the extra time?" value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="small muted" style={{ marginTop: 10 }}>Anything that still doesn’t fit goes to triage, not into the night.</p>
    </Sheet>
  );
}

function CapacityWidget() {
  const day = useDay();
  const cap = useApi<Capacity>(day.data ? `/api/day/capacity?date=${day.data.date}` : null);
  const c = cap.data;
  if (!c) return null;
  if (c.offDay) {
    return (
      <Section title="Capacity">
        <Group pad><p className="small muted">{c.items.length ? `Today is your day off, and ${c.items.length} task${c.items.length === 1 ? ' is' : 's are'} still planned for it. Move them to keep the day clear.` : 'Today is your day off. Nothing is planned, which is the point.'}</p></Group>
      </Section>
    );
  }
  const msg = {
    none: `There’s no free time today between fixed blocks and your stop. Which commitment changes?`,
    over: `Planned work is ${fmtDur(c.overByMin)} more than the time you have. Triage before you accept the plan.`,
    tight: 'Close to full. Leave the rest for another day.',
    ok: 'Fits, with room for overruns.',
    open: 'Plenty of room today.',
  }[c.status];
  return (
    <Section title="Capacity" why="Estimates ×1.5 for the planning fallacy">
      <Group pad>
        <div className="row between num" style={{ marginBottom: 8 }}>
          <span><strong>{fmtDur(c.loadMin)}</strong> <span className="muted">planned</span></span>
          <span><strong>{fmtDur(c.freeMin)}</strong> <span className="muted">free before the stop</span></span>
        </div>
        <CapacityBar loadMin={c.loadMin} freeMin={c.freeMin} />
        <p className={`small ${c.status === 'over' || c.status === 'none' ? '' : 'muted'}`} style={{ marginTop: 8, color: c.status === 'over' || c.status === 'none' ? 'var(--amber)' : undefined }}>{msg}</p>
      </Group>
    </Section>
  );
}

function TimelineWidget() {
  const day = useDay();
  const now = useNow(30_000);
  const q = useApi<TimelineItem[]>(day.data ? `/api/day/timeline?date=${day.data.date}` : null);
  const items = q.data ?? [];
  const allDay = items.filter((i) => i.allDay);
  const timed = items.filter((i) => !i.allDay);
  return (
    <Section title="Schedule">
      <Group>
        {allDay.map((i) => (
          <Item key={i.id}><span className="tl-swatch" style={{ background: i.color ?? 'var(--ink-3)' }} /><div className="title ellipsis">{i.title}</div><span className="meta">All day</span></Item>
        ))}
        {timed.map((i) => {
          const past = dt(i.end).toMillis() < now;
          const live = dt(i.start).toMillis() <= now && !past;
          return (
            <Item key={i.id} className={past ? 'tl-past' : ''}>
              <span className="tl-time num">{fmtTimeShort(i.start)}</span>
              <span className="tl-swatch" style={{ background: i.color ?? (i.source === 'fixed' ? 'var(--ink-3)' : 'var(--accent)') }} />
              <div className="title">
                <div className="ellipsis">{i.title}</div>
                <div className="sub">{fmtTimeShort(i.start)}–{fmtTime(i.end)}{i.calendarName ? ` · ${i.calendarName}` : i.source === 'fixed' ? ' · Fixed block' : ''}</div>
              </div>
              {live && <Tag tone="accent">Now</Tag>}
            </Item>
          );
        })}
        {!items.length && <div className="empty">Nothing on the calendar today.</div>}
      </Group>
    </Section>
  );
}

/** Plainly says when weekday capacity is near zero, per the spec. */
function NoCapacityBanner() {
  const week = useApi<{ weekdaysWithoutCapacity: string[] }>('/api/day/week');
  const n = week.data?.weekdaysWithoutCapacity.length ?? 0;
  if (n < 2) return null;
  return (
    <Banner tone="amber" icon="TriangleAlert" why="Changing workload beats coping techniques (Panagioti 2017, 20 trials).">
      <strong>{n} weekdays this week have almost no free time before your stop.</strong> Squeezing sleep isn’t an option. Which commitment changes?
    </Banner>
  );
}

export default defineWebModule({
  id: 'day',
  widgets: { horizon: Horizon, capacity: CapacityWidget, timeline: TimelineWidget, 'no-capacity': NoCapacityBanner },
  commands: [
    { id: 'late-night', label: 'Declare a late night', group: 'Day', run: () => '/today' },
  ],
});
