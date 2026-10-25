/**
 * Hand-rolled SVG charts for Insights, built to the dataviz rules: thin marks (bars <= 24px, 4px rounded
 * data ends square at the baseline, 2px lines, >= 8px markers), a 2px surface gap between touching fills and
 * a 2px surface ring on dots, hairline solid grid, selective direct labels, text in text tokens (never the
 * series color), a hover/focus tooltip on every mark, and a table view under every chart.
 *
 * Colors are CSS custom properties (--viz-1..3, --viz-surface) defined in insights.css for light and dark.
 * No imports from the app shell, so these render anywhere (and server-side in tests).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const C1 = 'var(--viz-1)';
export const C2 = 'var(--viz-2)';
export const C3 = 'var(--viz-3)';
export const CGRAY = 'var(--ink-3)';
const SURFACE = 'var(--viz-surface)';

const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

/** A clean axis: step of 1, 2 or 5 x 10^k so the top tick covers `max`. */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  return { max: top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

/** Rounded data end only: top corners (vertical bars) or right corners (horizontal bars). */
const roundTop = (x: number, y: number, w: number, h: number, r = 4) => {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};
const roundRight = (x: number, y: number, w: number, h: number, r = 4) => {
  r = Math.max(0, Math.min(r, h / 2, w));
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
};

function useWidth(initial = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.max(280, Math.floor(el.clientWidth)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/* ---------------------------------------------------------------- frame, legend, tooltip, table */
export interface LegendItem { name: string; color: string; shape?: 'rect' | 'line' | 'dot' | 'ring' | 'tick' }
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="ins-legend" aria-label="Legend">
      {items.map((it) => (
        <li key={it.name}>
          <svg width="16" height="12" aria-hidden="true">
            {it.shape === 'line' ? <line x1="1" x2="15" y1="6" y2="6" stroke={it.color} strokeWidth="2" strokeLinecap="round" />
              : it.shape === 'dot' ? <circle cx="8" cy="6" r="4" fill={it.color} />
              : it.shape === 'ring' ? <circle cx="8" cy="6" r="3.5" fill={SURFACE} stroke={it.color} strokeWidth="2" />
              : it.shape === 'tick' ? <line x1="8" x2="8" y1="1" y2="11" stroke={it.color} strokeWidth="2" />
              : <rect x="2" y="2" width="12" height="8" rx="2" fill={it.color} />}
          </svg>
          {it.name}
        </li>
      ))}
    </ul>
  );
}

export interface Tip { x: number; y: number; title: string; rows: { name: string; value: string; color?: string; mark?: 'line' | 'bar' | 'dot' | 'ring' }[] }
function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width * 0.6;
  return (
    <div className="ins-tip" role="tooltip" style={{ left: tip.x, top: Math.max(24, tip.y), transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)` }}>
      <div className="ins-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div className="ins-tip-row" key={i}>
          {r.color && (
            <svg width="14" height="10" aria-hidden="true">
              {r.mark === 'line' ? <line x1="1" x2="13" y1="5" y2="5" stroke={r.color} strokeWidth="2" strokeLinecap="round" />
                : r.mark === 'dot' ? <circle cx="7" cy="5" r="4" fill={r.color} />
                : r.mark === 'ring' ? <circle cx="7" cy="5" r="3" fill={SURFACE} stroke={r.color} strokeWidth="2" />
                : <rect x="1" y="1" width="12" height="8" rx="2" fill={r.color} />}
            </svg>
          )}
          <strong className="num">{r.value}</strong>
          <span>{r.name}</span>
        </div>
      ))}
    </div>
  );
}

export interface TableView { columns: string[]; rows: (string | number | null)[][] }
export function ChartCard({ title, summary, legend, table, note, children }: { title: ReactNode; summary: ReactNode; legend?: LegendItem[]; table?: TableView; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="ins-card">
      <h3>{title}</h3>
      <p className="ins-summary">{summary}</p>
      {legend && legend.length > 1 && <Legend items={legend} />}
      {children}
      {note && <p className="ins-note">{note}</p>}
      {table && (
        <details className="ins-table">
          <summary>View as table</summary>
          <div className="ins-table-wrap">
            <table>
              <thead><tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => (j === 0 ? <th key={j} scope="row">{v ?? '–'}</th> : <td key={j} className="num">{v ?? '–'}</td>))}</tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/** Pixel position of a pointer inside the chart wrapper. */
const at = (e: { clientX: number; clientY: number }, el: Element | null) => {
  const r = el?.getBoundingClientRect();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
};

/** Skips x labels that would touch the previous one. */
function xLabels(items: { x: number; label?: string }[], gap = 6) {
  let last = -Infinity;
  return items.filter((it) => {
    if (!it.label) return false;
    const half = (it.label.length * 6) / 2;
    if (it.x - half < last + gap) return false;
    last = it.x + half;
    return true;
  });
}

/* ---------------------------------------------------------------- columns (stacked or grouped) */
export interface ColumnDatum { key: string; label?: string; values: (number | null)[]; title: string }
export function ColumnChart({ data, series, mode = 'stack', height = 200, yMax, yTicks, yFormat = String, valueFormat = String, band, labelLast, ariaLabel }: {
  data: ColumnDatum[];
  series: { name: string; color: string }[];
  mode?: 'stack' | 'group';
  height?: number;
  yMax?: number;
  yTicks?: number[];
  yFormat?: (n: number) => string;
  valueFormat?: (n: number, seriesIndex: number) => string;
  /** Shaded reference range, e.g. a target. */
  band?: { from: number; to: number; label: string };
  /** Directly label the last bar's value. */
  labelLast?: boolean;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const m = { l: 40, r: 10, t: 12, b: 24 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const n = data.length;
  const step = pw / Math.max(1, n);
  const tops = data.map((d) => (mode === 'stack' ? sum(d.values) : Math.max(0, ...d.values.map((v) => v ?? 0))));
  const scale = yMax && yTicks ? { max: yMax, ticks: yTicks } : niceScale(Math.max(...tops, 1));
  const y = (v: number) => m.t + ph - (v / scale.max) * ph;
  const k = series.length;
  const bw = mode === 'stack' ? Math.min(24, Math.max(2, step * 0.72)) : Math.min(24, Math.max(2, (step * 0.72 - (k - 1) * 2) / k));
  const groupW = mode === 'stack' ? bw : k * bw + (k - 1) * 2;
  const focusable = n <= 30;

  const show = (i: number, pos?: { x: number; y: number }) => {
    const d = data[i];
    setActive(i);
    setTip({
      x: pos?.x ?? m.l + step * (i + 0.5), y: pos?.y ?? y(tops[i]), title: d.title,
      rows: series.flatMap((s, j) => (d.values[j] === null || d.values[j] === undefined ? [] : [{ name: s.name, value: valueFormat(d.values[j]!, j), color: s.color, mark: 'bar' as const }])),
    });
  };
  const hide = () => { setActive(null); setTip(null); };
  const lastIdx = (() => { for (let i = n - 1; i >= 0; i--) if (tops[i] > 0) return i; return -1; })();

  return (
    <div className="ins-plot" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        {band && <rect x={m.l} y={y(band.to)} width={pw} height={y(band.from) - y(band.to)} fill={C1} opacity="0.09" />}
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--line-strong)' : 'var(--line)'} strokeWidth="1" />
            <text x={m.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="ins-axis num">{yFormat(t)}</text>
          </g>
        ))}
        {band && <text x={m.l + pw - 4} y={y(band.to) + 13} textAnchor="end" className="ins-axis">{band.label}</text>}
        {active !== null && <rect x={m.l + step * active} y={m.t} width={step} height={ph} fill="var(--bg-hover)" />}
        {data.map((d, i) => {
          const cx = m.l + step * (i + 0.5);
          if (mode === 'stack') {
            const live = d.values.map((v, j) => ({ v: v ?? 0, j })).filter((s) => s.v > 0);
            let cum = 0;
            return live.map((s, idx) => {
              const top = y(cum + s.v), bottom = y(cum);
              cum += s.v;
              const isTop = idx === live.length - 1;
              const yy = isTop ? top : top + 2; // 2px surface gap under the segment above
              const h = Math.max(1, bottom - yy);
              return isTop
                ? <path key={`${d.key}-${s.j}`} d={roundTop(cx - bw / 2, yy, bw, h)} fill={series[s.j].color} />
                : <rect key={`${d.key}-${s.j}`} x={cx - bw / 2} y={yy} width={bw} height={h} fill={series[s.j].color} />;
            });
          }
          return d.values.map((v, j) => {
            if (!v || v <= 0) return null;
            const x0 = cx - groupW / 2 + j * (bw + 2);
            return <path key={`${d.key}-${j}`} d={roundTop(x0, y(v), bw, y(0) - y(v))} fill={series[j].color} />;
          });
        })}
        {labelLast && lastIdx >= 0 && (
          <text x={Math.min(m.l + step * (lastIdx + 0.5), width - 22)} y={y(tops[lastIdx]) - 5} textAnchor="middle" className="ins-label num">
            {valueFormat(mode === 'stack' ? tops[lastIdx] : tops[lastIdx], 0)}
          </text>
        )}
        {xLabels(data.map((d, i) => ({ x: m.l + step * (i + 0.5), label: d.label }))).map((l) => (
          <text key={l.x} x={l.x} y={height - 6} textAnchor="middle" className="ins-axis">{l.label}</text>
        ))}
        {data.map((d, i) => (
          <rect key={`hit-${d.key}`} x={m.l + step * i} y={m.t} width={step} height={ph} fill="transparent"
            tabIndex={focusable ? 0 : undefined} aria-label={focusable ? `${d.title}: ${d.values.map((v, j) => (v == null ? '' : `${series[j].name} ${valueFormat(v, j)}`)).filter(Boolean).join(', ')}` : undefined}
            onPointerMove={(e) => show(i, at(e, ref.current))} onPointerLeave={hide} onFocus={() => show(i)} onBlur={hide} />
        ))}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ---------------------------------------------------------------- lines */
export interface LineSeries { id: string; name: string; color: string; points: (number | null)[] }
export function LineChart({ series, labels, yMin = 0, yMax = 10, yTicks, yFormat = String, valueFormat = String, height = 200, ariaLabel, tipTitle, xLabel }: {
  series: LineSeries[];
  /** One entry per x position. */
  labels: string[];
  yMin?: number; yMax?: number; yTicks?: number[];
  yFormat?: (n: number) => string;
  valueFormat?: (n: number) => string;
  height?: number;
  ariaLabel: string;
  tipTitle: (i: number) => string;
  xLabel?: (i: number) => string | undefined;
}) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const live = series.filter((s) => s.points.some((p) => p !== null));
  const direct = width >= 460;
  const m = { l: 32, r: direct ? 78 : 14, t: 12, b: 24 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const n = labels.length;
  const ticks = yTicks ?? Array.from({ length: yMax - yMin + 1 }, (_, i) => yMin + i).filter((t) => (t - yMin) % 2 === 0);
  const x = (i: number) => (n === 1 ? m.l + pw / 2 : m.l + 8 + (i / (n - 1)) * (pw - 16));
  const y = (v: number) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

  // End labels only when they don't collide; otherwise the legend and tooltip carry identity.
  const ends = live.map((s) => { let i = s.points.length - 1; while (i >= 0 && s.points[i] === null) i--; return { s, i }; }).filter((e) => e.i >= 0);
  const ys = ends.map((e) => y(e.s.points[e.i]!)).sort((a, b) => a - b);
  const separate = ys.every((v, i) => i === 0 || v - ys[i - 1] >= 14);
  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };
  const tip: Tip | null = active === null ? null : {
    x: x(active), y: m.t + ph * 0.3, title: tipTitle(active),
    rows: live.flatMap((s) => (s.points[active] == null ? [] : [{ name: s.name, value: valueFormat(s.points[active]!), color: s.color, mark: 'line' as const }])),
  };

  return (
    <div className="ins-plot" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setActive((a) => Math.max(0, (a ?? n) - 1)); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); setActive((a) => Math.min(n - 1, (a ?? -1) + 1)); }
          else if (e.key === 'Escape') setActive(null);
        }}
        onFocus={() => setActive((a) => a ?? n - 1)} onBlur={() => setActive(null)}
        onPointerMove={(e) => setActive(nearest(at(e, ref.current).x))} onPointerLeave={() => setActive(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} stroke={t === yMin ? 'var(--line-strong)' : 'var(--line)'} strokeWidth="1" />
            <text x={m.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="ins-axis num">{yFormat(t)}</text>
          </g>
        ))}
        {xLabels(labels.map((_, i) => ({ x: x(i), label: xLabel ? xLabel(i) : labels[i] }))).map((l) => (
          <text key={l.x} x={l.x} y={height - 6} textAnchor="middle" className="ins-axis">{l.label}</text>
        ))}
        {active !== null && <line x1={x(active)} x2={x(active)} y1={m.t} y2={m.t + ph} stroke="var(--line-strong)" strokeWidth="1" />}
        {live.map((s) => {
          const segs: string[] = [];
          let cur = '';
          s.points.forEach((p, i) => {
            if (p === null) { if (cur) segs.push(cur); cur = ''; return; }
            cur += `${cur ? 'L' : 'M'}${x(i)},${y(p)}`;
          });
          if (cur) segs.push(cur);
          return (
            <g key={s.id}>
              {segs.map((d, i) => <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
              {s.points.map((p, i) => (p === null ? null : <circle key={i} cx={x(i)} cy={y(p)} r="4" fill={s.color} stroke={SURFACE} strokeWidth="2" />))}
            </g>
          );
        })}
        {direct && separate && ends.map(({ s, i }) => (
          <text key={s.id} x={x(i) + 12} y={y(s.points[i]!)} dominantBaseline="middle" className="ins-label">{s.name} {valueFormat(s.points[i]!)}</text>
        ))}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ---------------------------------------------------------------- dots over time (wake time) */
export interface DotDatum { i: number; v: number; kind: 0 | 1; title: string; text: string }
export function DotPlot({ count, dots, xTicks, yMin, yMax, yStep, yFormat, kinds, refLine, height = 200, ariaLabel }: {
  /** Number of x positions (days). */
  count: number;
  dots: DotDatum[];
  xTicks: { i: number; label: string }[];
  yMin: number; yMax: number; yStep: number;
  yFormat: (n: number) => string;
  /** Names for kind 0 (filled dot) and kind 1 (ring). */
  kinds: [string, string];
  refLine?: { v: number; label: string };
  height?: number;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const m = { l: 56, r: 12, t: 12, b: 24 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const x = (i: number) => (count <= 1 ? m.l + pw / 2 : m.l + 6 + (i / (count - 1)) * (pw - 12));
  const y = (v: number) => m.t + ((v - yMin) / (yMax - yMin)) * ph; // earlier at the top
  const ticks: number[] = [];
  for (let t = yMin; t <= yMax; t += yStep) ticks.push(t);
  const find = (px: number, py: number) => {
    let best: DotDatum | null = null, bd = 28;
    for (const d of dots) { const dist = Math.hypot(x(d.i) - px, y(d.v) - py); if (dist < bd) { bd = dist; best = d; } }
    return best;
  };
  const showDot = (d: DotDatum | null) => setTip(d ? { x: x(d.i), y: y(d.v), title: d.title, rows: [{ name: d.kind === 0 ? kinds[0] : kinds[1], value: d.text, color: C1, mark: d.kind === 0 ? 'dot' : 'ring' }] } : null);

  return (
    <div className="ins-plot" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} onPointerMove={(e) => { const p = at(e, ref.current); showDot(find(p.x, p.y)); }} onPointerLeave={() => setTip(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={m.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="ins-axis num">{yFormat(t)}</text>
          </g>
        ))}
        {xLabels(xTicks.map((t) => ({ x: x(t.i), label: t.label }))).map((l) => (
          <text key={l.x} x={l.x} y={height - 6} textAnchor="middle" className="ins-axis">{l.label}</text>
        ))}
        {refLine && (
          <g>
            <line x1={m.l} x2={m.l + pw} y1={y(refLine.v)} y2={y(refLine.v)} stroke="var(--line-strong)" strokeWidth="1" />
            <text x={m.l + pw - 2} y={y(refLine.v) - 5} textAnchor="end" className="ins-axis">{refLine.label}</text>
          </g>
        )}
        {dots.map((d) => (d.kind === 0
          ? <circle key={d.i} cx={x(d.i)} cy={y(d.v)} r="4" fill={C1} stroke={SURFACE} strokeWidth="2" />
          : <circle key={d.i} cx={x(d.i)} cy={y(d.v)} r="3.5" fill={SURFACE} stroke={C1} strokeWidth="2" />))}
        {/* 24px hit targets so a dot doesn't have to be hit dead-center */}
        {dots.map((d) => <circle key={`h${d.i}`} cx={x(d.i)} cy={y(d.v)} r="12" fill="transparent" tabIndex={dots.length <= 30 ? 0 : undefined} aria-label={`${d.title}: ${d.text}`} onFocus={() => showDot(d)} onBlur={() => setTip(null)} />)}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ---------------------------------------------------------------- horizontal bars */
export interface HBarRow {
  key: string;
  label: string;
  bars: { value: number | null; color: string; name: string }[];
  /** A tick such as a weekly budget. */
  marker?: { value: number; name: string };
  title: string;
}
export function HBarChart({ rows, mode = 'stack', xMax, xTicks, xFormat = String, valueFormat = String, ariaLabel }: {
  rows: HBarRow[];
  mode?: 'stack' | 'group';
  xMax?: number; xTicks?: number[];
  xFormat?: (n: number) => string;
  valueFormat?: (n: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const lw = Math.max(96, Math.min(200, Math.round(width * 0.3)));
  const m = { l: lw + 8, r: 52, t: 6, b: 22 };
  const pw = width - m.l - m.r;
  const barH = mode === 'stack' ? 14 : 9;
  const rowH = mode === 'stack' ? 30 : (rows[0]?.bars.length ?? 1) * (barH + 3) + 14;
  const height = m.t + rows.length * rowH + m.b;
  const totals = rows.map((r) => (mode === 'stack' ? sum(r.bars.map((b) => b.value)) : Math.max(0, ...r.bars.map((b) => b.value ?? 0))));
  const maxV = Math.max(1, ...totals, ...rows.map((r) => r.marker?.value ?? 0));
  const scale = xMax && xTicks ? { max: xMax, ticks: xTicks } : niceScale(maxV);
  const sx = (v: number) => m.l + (v / scale.max) * pw;
  const chars = Math.max(8, Math.floor((lw - 8) / 6.4));
  const trunc = (s: string) => (s.length > chars ? `${s.slice(0, chars - 1)}…` : s);

  const show = (r: HBarRow, y: number) => {
    setActive(r.key);
    setTip({
      x: sx(totals[rows.indexOf(r)]), y, title: r.title,
      rows: [
        ...r.bars.flatMap((b) => (b.value == null ? [] : [{ name: b.name, value: valueFormat(b.value), color: b.color, mark: 'bar' as const }])),
        ...(r.marker ? [{ name: r.marker.name, value: valueFormat(r.marker.value) }] : []),
      ],
    });
  };
  const hide = () => { setActive(null); setTip(null); };

  return (
    <div className="ins-plot" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={m.t} y2={height - m.b} stroke={t === 0 ? 'var(--line-strong)' : 'var(--line)'} strokeWidth="1" />
            <text x={sx(t)} y={height - 6} textAnchor="middle" className="ins-axis num">{xFormat(t)}</text>
          </g>
        ))}
        {rows.map((r, ri) => {
          const top = m.t + ri * rowH;
          const mid = top + rowH / 2;
          const bars = r.bars.map((b, j) => ({ ...b, j })).filter((b) => (b.value ?? 0) > 0);
          let cum = 0;
          return (
            <g key={r.key}>
              {active === r.key && <rect x={0} y={top} width={width} height={rowH} fill="var(--bg-hover)" />}
              <text x={0} y={mid} dominantBaseline="middle" className="ins-rowlabel"><title>{r.label}</title>{trunc(r.label)}</text>
              {mode === 'stack' ? bars.map((b, idx) => {
                const x0 = sx(cum), x1 = sx(cum + b.value!);
                cum += b.value!;
                const isLast = idx === bars.length - 1;
                const w = Math.max(1, x1 - x0 - (isLast ? 0 : 2)); // 2px surface gap before the next segment
                return isLast
                  ? <path key={b.j} d={roundRight(x0, mid - barH / 2, w, barH)} fill={b.color} />
                  : <rect key={b.j} x={x0} y={mid - barH / 2} width={w} height={barH} fill={b.color} />;
              }) : r.bars.map((b, j) => {
                if (!b.value) return null;
                const yy = top + 7 + j * (barH + 3);
                return (
                  <g key={j}>
                    <path d={roundRight(m.l, yy, Math.max(1, sx(b.value) - m.l), barH)} fill={b.color} />
                    <text x={sx(b.value) + 6} y={yy + barH / 2} dominantBaseline="middle" className="ins-label num">{valueFormat(b.value)}</text>
                  </g>
                );
              })}
              {mode === 'stack' && totals[ri] > 0 && <text x={sx(totals[ri]) + 6} y={mid} dominantBaseline="middle" className="ins-label num">{valueFormat(totals[ri])}</text>}
              {r.marker && <line x1={sx(r.marker.value)} x2={sx(r.marker.value)} y1={mid - barH / 2 - 3} y2={mid + barH / 2 + 3} stroke="var(--ink)" strokeWidth="2" />}
              <rect x={0} y={top} width={width} height={rowH} fill="transparent" tabIndex={0}
                aria-label={`${r.title}: ${r.bars.filter((b) => b.value != null).map((b) => `${b.name} ${valueFormat(b.value!)}`).join(', ')}`}
                onPointerMove={(e) => show(r, at(e, ref.current).y)} onPointerLeave={hide} onFocus={() => show(r, mid)} onBlur={hide} />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}
