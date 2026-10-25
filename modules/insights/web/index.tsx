import { useState, type ReactNode } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { defineWebModule } from '@web/lib/module';
import { Page } from '@web/app/Page';
import { useApi } from '@web/lib/query';
import { Section, Segmented, Spinner } from '@web/ui';
import { fmtDur } from '@web/lib/format';
import type { InsightsSummary, SectionKey } from '../build';
import { C1, C2, C3, CGRAY, ChartCard, ColumnChart, DotPlot, HBarChart, LineChart } from './charts';
import './insights.css';

type Range = '4' | '8' | '12';
const RANGES: { value: Range; label: string }[] = [{ value: '4', label: '4 weeks' }, { value: '8', label: '8 weeks' }, { value: '12', label: '12 weeks' }];

const day = (iso: string) => DateTime.fromISO(iso);
const shortDay = (iso: string) => day(iso).toFormat('MMM d');
const longDay = (iso: string) => day(iso).toFormat('EEE, MMM d');
const weekOf = (iso: string) => `Week of ${shortDay(iso)}`;
const hours = (h: number) => fmtDur(Math.round(h * 60));
const clock = (min: number) => {
  const m = Math.round(min), h24 = Math.floor(m / 60) % 24;
  return `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
};
const clockHour = (min: number) => clock(min).replace(':00 ', ' ');
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const every7 = (i: number, iso: string) => (i % 7 === 0 ? shortDay(iso) : undefined);

function datesBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = day(from); d <= day(to); d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

/** No table under an empty chart. */
const tbl = (columns: string[], rows: (string | number | null)[][]) => (rows.length ? { columns, rows } : undefined);
const Cards = ({ children }: { children: ReactNode }) => <div className="ins-grid">{children}</div>;
const None = ({ children }: { children: ReactNode }) => <p className="ins-empty">{children}</p>;

/** One section: the charts when the data is there, otherwise the honest reason it isn't. */
function Block({ k, s, title, why, children }: { k: SectionKey; s: InsightsSummary; title: string; why?: string; children: ReactNode }) {
  const reason = s.missing[k] ? `This needs the ${s.missing[k]} module. Turn it on in Settings → Modules.`
    : s.failed.includes(k) ? 'This section couldn’t load. Try again in a moment.' : null;
  return (
    <Section title={title} why={why}>
      {reason ? <div className="ins-card"><None>{reason}</None></div> : children}
    </Section>
  );
}

function Sleep({ s }: { s: InsightsSummary }) {
  const d = s.sleep;
  const dates = datesBetween(s.from, s.to);
  const idx = new Map(dates.map((x, i) => [x, i]));
  const nights = d?.nights ?? [];
  const byDate = new Map(nights.map((n) => [n.date, n]));
  const sleeps = nights.filter((n) => n.sleepMin !== null);
  const wakes = nights.filter((n) => n.wakeMin !== null);
  const [lo, hi] = (d?.targetMin ?? [480, 600]).map((m) => m / 60);
  const top = Math.max(hi, Math.ceil(Math.max(0, ...sleeps.map((n) => n.sleepMin! / 60)) / 2) * 2);
  const ticks = Array.from({ length: top / 2 + 1 }, (_, i) => i * 2);
  const wMin = Math.min(...wakes.map((n) => n.wakeMin!)), wMax = Math.max(...wakes.map((n) => n.wakeMin!));
  const yMin = Math.max(0, Math.floor((wMin - 30) / 60) * 60), yMax = Math.ceil((wMax + 30) / 60) * 60;
  return (
    <Block k="sleep" s={s} title="Sleep" why="Teens 13–18 need 8–10 hours a night (Paruthi 2016).">
      {d && (
        <Cards>
          <ChartCard title="Sleep duration" summary={d.summary.sleep}
            table={tbl(['Night', 'Sleep'], sleeps.map((n) => [longDay(n.date), hours(n.sleepMin! / 60)]))}>
            {sleeps.length === 0 ? <None>Check in for a few mornings and this fills in.</None> : (
              <ColumnChart ariaLabel="Hours of sleep each night, with the 8 to 10 hour target shaded" mode="group" yMax={top} yTicks={ticks}
                yFormat={(n) => `${n}h`} valueFormat={hours} band={{ from: lo, to: hi, label: `Target ${lo}–${hi} h` }}
                series={[{ name: 'Sleep', color: C1 }]}
                data={dates.map((x, i) => ({ key: x, label: every7(i, x), title: longDay(x), values: [byDate.get(x)?.sleepMin != null ? byDate.get(x)!.sleepMin! / 60 : null] }))} />
            )}
          </ChartCard>
          <ChartCard title="Wake time" summary={d.summary.wake} legend={[{ name: 'Weekday', color: C1, shape: 'dot' }, { name: 'Weekend', color: C1, shape: 'ring' }]}
            table={tbl(['Morning', 'Woke'], wakes.map((n) => [longDay(n.date), clock(n.wakeMin!)]))}>
            {wakes.length === 0 ? <None>Check in for a few mornings and this fills in.</None> : (
              <DotPlot ariaLabel="Wake time each morning; weekends are open circles" count={dates.length} yMin={yMin} yMax={yMax} yStep={yMax - yMin > 360 ? 120 : 60}
                yFormat={clockHour} kinds={['Weekday', 'Weekend']}
                refLine={d.wake.avgMin !== null ? { v: d.wake.avgMin, label: `Average ${clock(d.wake.avgMin)}` } : undefined}
                xTicks={dates.flatMap((x, i) => (i % 7 === 0 ? [{ i, label: shortDay(x) }] : []))}
                dots={wakes.map((n) => ({ i: idx.get(n.date) ?? 0, v: n.wakeMin!, kind: n.weekend ? 1 : 0, title: longDay(n.date), text: clock(n.wakeMin!) }))} />
            )}
          </ChartCard>
        </Cards>
      )}
    </Block>
  );
}

function Energy({ s }: { s: InsightsSummary }) {
  const d = s.energy;
  const dates = datesBetween(s.from, s.to);
  const daily = new Map((d?.daily ?? []).map((x) => [x.date, x.energy]));
  const weekly = d?.weekly ?? [];
  const rated = weekly.some((w) => w.energy !== null || w.dread !== null || w.effective !== null);
  const rate = (n: number | null) => (n === null ? null : String(n));
  return (
    <Block k="energy" s={s} title="Energy and weekly ratings" why="Your own ratings, 0 to 10. Read them as a trend, not a score.">
      {d && (
        <Cards>
          <ChartCard title="Energy each morning" summary={d.summary.daily}
            table={tbl(['Morning', 'Energy'], d.daily.map((x) => [longDay(x.date), x.energy]))}>
            {d.daily.length === 0 ? <None>Check in for a few mornings and this fills in.</None> : (
              <LineChart ariaLabel="Energy rating from the morning check-in, 0 to 10" labels={dates} tipTitle={(i) => longDay(dates[i])} xLabel={(i) => every7(i, dates[i])}
                series={[{ id: 'energy', name: 'Energy', color: C1, points: dates.map((x) => daily.get(x) ?? null) }]} />
            )}
          </ChartCard>
          <ChartCard title="Weekly ratings" summary={d.summary.weekly}
            legend={[{ name: 'Energy', color: C1, shape: 'line' }, { name: 'Dread', color: C2, shape: 'line' }, { name: 'Effective', color: C3, shape: 'line' }]}
            table={tbl(['Week', 'Energy', 'Dread', 'Effective'], weekly.map((w) => [weekOf(w.weekStart), rate(w.energy), rate(w.dread), rate(w.effective)]))}>
            {!rated ? <None>Finish a weekly review and this fills in.</None> : (
              <LineChart ariaLabel="Weekly energy, dread and effectiveness ratings, 0 to 10" labels={weekly.map((w) => w.weekStart)} tipTitle={(i) => weekOf(weekly[i].weekStart)} xLabel={(i) => shortDay(weekly[i].weekStart)}
                series={[
                  { id: 'energy', name: 'Energy', color: C1, points: weekly.map((w) => w.energy) },
                  { id: 'dread', name: 'Dread', color: C2, points: weekly.map((w) => w.dread) },
                  { id: 'effective', name: 'Effective', color: C3, points: weekly.map((w) => w.effective) },
                ]} />
            )}
          </ChartCard>
        </Cards>
      )}
    </Block>
  );
}

function Stops({ s }: { s: InsightsSummary }) {
  const d = s.stops;
  return (
    <Block k="stops" s={s} title="Stop" why="Detaching after hours has the strongest link to lower fatigue (Bennett 2018).">
      {d && (
        <ChartCard title="Stop adherence" summary={d.summary} legend={[{ name: 'Stop held', color: C1 }, { name: 'Stop broken', color: C2 }, { name: 'Nothing logged', color: CGRAY }]}
          note="A night with nothing logged is a gap in the data, not a miss."
          table={tbl(['Week', 'Held', 'Broken', 'Nothing logged'], d.weeks.map((w) => [weekOf(w.weekStart), w.held, w.broken, w.unlogged]))}>
          {d.nights === 0 ? <None>Finish a shutdown for a few evenings and this fills in.</None> : (
            <ColumnChart ariaLabel="Nights per week the stop held, was broken, or had nothing logged" yFormat={String} valueFormat={(n) => count(n, 'night')}
              series={[{ name: 'Stop held', color: C1 }, { name: 'Stop broken', color: C2 }, { name: 'Nothing logged', color: CGRAY }]}
              data={d.weeks.map((w) => ({ key: w.weekStart, label: shortDay(w.weekStart), title: weekOf(w.weekStart), values: [w.held, w.broken, w.unlogged] }))} />
          )}
        </ChartCard>
      )}
    </Block>
  );
}

function Carry({ s }: { s: InsightsSummary }) {
  const d = s.carry;
  return (
    <Block k="carry" s={s} title="Carry-overs" why="Tasks you moved to another day, counted by the week they moved.">
      {d && (
        <ChartCard title="Tasks carried to another day" summary={d.summary} legend={[{ name: 'Carry-overs', color: C1 }, { name: 'Tasks reaching 3 carries', color: C2 }]}
          table={tbl(['Week', 'Carry-overs', 'Tasks', 'Reached 3'], d.weeks.map((w) => [weekOf(w.weekStart), w.carries, w.tasks, w.hit3]))}>
          {d.carries === 0 ? <None>Nothing was carried over in this range.</None> : (
            <ColumnChart ariaLabel="Carry-overs per week, and tasks reaching three carries" mode="group" yFormat={String} valueFormat={(n) => String(n)}
              series={[{ name: 'Carry-overs', color: C1 }, { name: 'Tasks reaching 3 carries', color: C2 }]}
              data={d.weeks.map((w) => ({ key: w.weekStart, label: shortDay(w.weekStart), title: weekOf(w.weekStart), values: [w.carries, w.hit3] }))} />
          )}
        </ChartCard>
      )}
    </Block>
  );
}

function MustDos({ s }: { s: InsightsSummary }) {
  const d = s.mustDo;
  return (
    <Block k="mustDo" s={s} title="Must-dos" why="Each task counts once, on its latest date.">
      {d && (
        <ChartCard title="Must-do completion" summary={d.summary} note={d.note}
          legend={[{ name: 'Done on the day', color: C1 }, { name: 'Done later', color: C2 }, { name: 'Still open', color: CGRAY }]}
          table={tbl(['Week', 'Planned', 'Done on the day', 'Done later'], d.weeks.map((w) => [weekOf(w.weekStart), w.planned, w.done, w.later]))}>
          {d.planned === 0 ? <None>Set must-dos in the plan for a few days and this fills in.</None> : (
            <ColumnChart ariaLabel="Must-dos per week: done on the day, done later, and still open" yFormat={String} valueFormat={(n) => count(n, 'task')}
              series={[{ name: 'Done on the day', color: C1 }, { name: 'Done later', color: C2 }, { name: 'Still open', color: CGRAY }]}
              data={d.weeks.map((w) => ({ key: w.weekStart, label: shortDay(w.weekStart), title: weekOf(w.weekStart), values: [w.done, w.later, Math.max(0, w.planned - w.done - w.later)] }))} />
          )}
        </ChartCard>
      )}
    </Block>
  );
}

function Projects({ s }: { s: InsightsSummary }) {
  const d = s.projects;
  const budgeted = !!d?.rows.some((r) => r.budgetMin);
  return (
    <Block k="projects" s={s} title="Time per project" why="Focus timer plus calendar sessions that have already happened.">
      {d && (
        <ChartCard title="Hours by project" summary={d.summary} legend={[{ name: 'Focus timer', color: C1 }, { name: 'Calendar sessions', color: C2 }]}
          note={budgeted ? `The dark tick is the project’s weekly time budget across ${count(d.weeks, 'week')}.` : undefined}
          table={tbl(['Project', 'Focus', 'Calendar', 'Total', 'Budget'], d.rows.map((r) => [r.name, fmtDur(r.focusMin), fmtDur(r.eventMin), fmtDur(r.totalMin), r.budgetMin ? fmtDur(r.budgetMin) : null]))}>
          {d.rows.length === 0 ? <None>Start a focus timer on a project and this fills in.</None> : (
            <HBarChart ariaLabel="Hours per project, split into focus timer and calendar sessions" xFormat={(n) => `${n}h`} valueFormat={hours}
              rows={d.rows.map((r) => ({
                key: r.projectId, label: r.name, title: r.name,
                bars: [{ value: r.focusMin / 60, color: C1, name: 'Focus timer' }, { value: r.eventMin / 60, color: C2, name: 'Calendar sessions' }],
                marker: r.budgetMin ? { value: r.budgetMin / 60, name: 'Time budget' } : undefined,
              }))} />
          )}
        </ChartCard>
      )}
    </Block>
  );
}

function Habits({ s }: { s: InsightsSummary }) {
  const d = s.habits;
  const any = !!d?.rows.some((r) => r.d14 !== null || r.d28 !== null);
  const pct = (n: number | null) => (n === null ? null : `${n}%`);
  return (
    <Block k="habits" s={s} title="Habits" why="Consistency over the last 14 and 28 days.">
      {d && (
        <ChartCard title="Habit consistency" summary={d.summary} legend={[{ name: 'Last 14 days', color: C1 }, { name: 'Last 28 days', color: C2 }]}
          table={tbl(['Habit', '14 days', '28 days'], d.rows.map((r) => [r.name, pct(r.d14), pct(r.d28)]))}>
          {d.rows.length === 0 ? <None>Add a habit and log it for a few days; this fills in.</None>
            : !any ? <None>Log a habit for a few days and this fills in.</None> : (
              <HBarChart ariaLabel="Consistency per habit over 14 and 28 days" mode="group" xMax={100} xTicks={[0, 25, 50, 75, 100]} xFormat={(n) => `${n}%`} valueFormat={(n) => `${Math.round(n)}%`}
                rows={d.rows.map((r) => ({ key: r.id, label: r.name, title: r.name, bars: [{ value: r.d14, color: C1, name: 'Last 14 days' }, { value: r.d28, color: C2, name: 'Last 28 days' }] }))} />
            )}
        </ChartCard>
      )}
    </Block>
  );
}

function InsightsPage() {
  const [range, setRange] = useState<Range>('8');
  const q = useApi<InsightsSummary>(`/api/insights/summary?weeks=${range}`, { placeholderData: keepPreviousData });
  const s = q.data;
  return (
    <Page title="Insights" subtitle={s ? `${shortDay(s.from)} – ${shortDay(s.to)}` : undefined} width="wide"
      actions={<Segmented<Range> label="Range" value={range} options={RANGES} onChange={setRange} />}>
      {!s ? (
        <div className="empty">{q.isError ? 'Insights didn’t load. Try again in a moment.' : <Spinner />}</div>
      ) : (
        <>
          <Sleep s={s} />
          <Energy s={s} />
          <Stops s={s} />
          <Carry s={s} />
          <MustDos s={s} />
          <Projects s={s} />
          <Habits s={s} />
        </>
      )}
    </Page>
  );
}

export default defineWebModule({
  id: 'insights',
  routes: [{ path: '/insights', component: InsightsPage, work: false }],
  commands: [{ id: 'insights.open', label: 'Open Insights', group: 'Insights', run: () => '/insights' }],
});
