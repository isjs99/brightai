import { useState, type ReactNode } from 'react';

/**
 * Small SVG charts for the account monitor: a single-series line with a crosshair tooltip, stacked daily
 * bars with a legend and per-bar tooltip, and a pace bar for a value against its target. Colours come from
 * the --s1/--s2/--s3 tokens (validated for colour-vision separation) and text always wears text tokens.
 */

const fmt = (n: number, kind: 'money' | 'count' | 'pct' | 'ratio', currency?: string): string => {
  if (kind === 'pct') return `${n.toFixed(n < 10 ? 2 : 1)}%`;
  if (kind === 'ratio') return n.toFixed(2);
  const abs = Math.abs(n);
  const short = abs >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : abs >= 1e4 ? `${Math.round(n / 1e3)}k` : abs >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`;
  return kind === 'money' && currency ? `${currency} ${short}` : short;
};
export const fmtValue = fmt;

const shortDate = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`; };

export function LineChart({ title, headline, footer, points, kind, currency, height = 150 }: { title: string; headline?: ReactNode; footer?: ReactNode; points: { date: string; value: number }[]; kind: 'money' | 'count' | 'pct' | 'ratio'; currency?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 600; const h = height; const padL = 44; const padR = 10; const padT = 8; const padB = 22;
  const head = <div className="chart-head"><h4>{title}</h4>{headline !== undefined && <div className="headline">{headline}</div>}</div>;
  if (points.length < 2) return <div className="chart">{head}<div className="sub" style={{ padding: '20px 0' }}>Not enough days yet.</div></div>;
  const max = Math.max(...points.map((p) => p.value), 1);
  const x = (i: number) => padL + (i / (points.length - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - v / max) * (h - padT - padB);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${d} L${x(points.length - 1).toFixed(1)},${(h - padB).toFixed(1)} L${x(0).toFixed(1)},${(h - padB).toFixed(1)} Z`;
  const ticks = [0, 0.5, 1].map((f) => ({ v: max * f, y: y(max * f) }));
  const labelEvery = Math.max(1, Math.round(points.length / 6));
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="chart">
      {head}
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={title}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * w; const i = Math.round(((px - padL) / (w - padL - padR)) * (points.length - 1)); setHover(Math.max(0, Math.min(points.length - 1, i))); }}>
        {ticks.map((t) => <g key={t.v}><line x1={padL} x2={w - padR} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth="1" /><text x={padL - 6} y={t.y + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{fmt(t.v, kind, currency)}</text></g>)}
        <path d={area} fill="var(--s1)" opacity="0.08" />
        <path d={d} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1) && <text key={p.date} x={x(i)} y={h - 6} fontSize="10" textAnchor="middle" fill="var(--muted)">{shortDate(p.date)}</text>)}
        {hp && hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={padT} y2={h - padB} stroke="var(--border-strong)" strokeDasharray="3 3" /><circle cx={x(hover)} cy={y(hp.value)} r="4" fill="var(--s1)" stroke="var(--surface)" strokeWidth="2" /></g>}
      </svg>
      {hp && hover !== null && <div className="tip" style={{ left: `${(x(hover) / w) * 100}%`, top: 8, transform: hover > points.length / 2 ? 'translateX(-105%)' : 'translateX(8px)' }}><b>{shortDate(hp.date)}</b><br />{fmt(hp.value, kind, currency)}</div>}
      {footer}
    </div>
  );
}

export function StackedBars({ title, headline, days, series, currency, height = 170 }: { title: string; headline?: ReactNode; days: { date: string; values: number[] }[]; series: { label: string; color: string }[]; currency?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 600; const h = height; const padL = 44; const padR = 10; const padT = 8; const padB = 22;
  const head = <div className="chart-head"><h4>{title}</h4>{headline !== undefined && <div className="headline">{headline}</div>}</div>;
  if (!days.length) return <div className="chart">{head}<div className="sub" style={{ padding: '20px 0' }}>No data yet.</div></div>;
  const totals = days.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const slot = (w - padL - padR) / days.length;
  const bw = Math.max(2, slot - 3);
  const y = (v: number) => padT + (1 - v / max) * (h - padT - padB);
  const labelEvery = Math.max(1, Math.round(days.length / 6));
  const hd = hover !== null ? days[hover] : null;
  return (
    <div className="chart">
      {head}
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={padL} x2={w - padR} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" /><text x={padL - 6} y={y(max * f) + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{fmt(max * f, 'money', currency)}</text></g>)}
        {days.map((d, i) => {
          let acc = 0;
          const x0 = padL + i * slot + (slot - bw) / 2;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={x0 - 1.5} y={padT} width={bw + 3} height={h - padT - padB} fill="transparent" />
              {d.values.map((v, k) => { const y1 = y(acc + v); const y0 = y(acc); acc += v; return v > 0 ? <rect key={k} x={x0} y={y1} width={bw} height={Math.max(0, y0 - y1 - 1)} fill={series[k].color} rx={k === d.values.length - 1 || acc === totals[i] ? 2 : 0} opacity={hover === null || hover === i ? 1 : 0.55} /> : null; })}
              {(i % labelEvery === 0 || i === days.length - 1) && <text x={x0 + bw / 2} y={h - 6} fontSize="10" textAnchor="middle" fill="var(--muted)">{shortDate(d.date)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="legend">{series.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>
      {hd && hover !== null && <div className="tip" style={{ left: `${((padL + hover * slot) / w) * 100}%`, top: 8, transform: hover > days.length / 2 ? 'translateX(-105%)' : 'translateX(8px)' }}><b>{shortDate(hd.date)}</b> · {fmt(totals[hover], 'money', currency)}<br />{series.map((s, k) => <span key={s.label}><i style={{ display: 'inline-block', width: 8, height: 8, background: s.color, marginRight: 4, borderRadius: 2 }} />{s.label} {fmt(hd.values[k], 'money', currency)}{k < series.length - 1 ? ' · ' : ''}</span>)}</div>}
    </div>
  );
}

/** A bar for value against target: full at 100% of target (for "higher is better") or inverted for "lower is better". */
export function PaceBar({ value, target, direction, state }: { value: number | null; target: number | null; direction: 'higher' | 'lower'; state: 'good' | 'warn' | 'crit' | null }) {
  if (value === null || target === null) return null;
  const ratio = direction === 'higher' ? (target > 0 ? value / target : 1) : target > 0 ? 1 - Math.max(0, value - target) / target : value > 0 ? 0 : 1;
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return <div className={`pace ${state ?? ''}`} title={`${Math.round(ratio * 100)}% of target`}><span style={{ width: `${pct}%` }} /></div>;
}
