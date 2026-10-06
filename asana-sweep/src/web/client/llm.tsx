import { useCallback, useEffect, useState } from 'react';
import type { LlmUsageData } from '../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from './api';
import { useIsAdmin } from './session';

/**
 * Claude spend: what today, the week and the month cost, the projection, what one reply costs on each
 * model, the model per feature and the daily budget. Compact on the replies pages, full under Connections.
 */
export const usd = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined ? '–' : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(digits)}`);
const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function useLlmUsage(): { data: LlmUsageData | null; error: string | null; reload: () => void; setData: (d: LlmUsageData) => void } {
  const [data, setData] = useState<LlmUsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api.llmUsage().then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { reload(); }, [reload]);
  useLiveUpdates((e) => { if (e.kind === 'inbox' || e.kind === 'settings') reload(); }, 3000);
  return { data, error, reload, setData };
}

/** The sentence to put at the top of a page when Claude cannot run. */
export function LlmBanner({ data }: { data: LlmUsageData | null }) {
  if (!data) return null;
  if (!data.configured) return <div className="banner warn">ANTHROPIC_API_KEY is not set, so nothing is classified or drafted.</div>;
  if (data.budget_reached) return <div className="banner warn">Daily Claude budget of {usd(data.daily_budget_usd)} reached: automatic replies and scans wait until tomorrow. Raise it under Settings › Connections › Claude.</div>;
  const e = data.last_error;
  if (e && /no credit left/i.test(e.message) && (!data.today.ok || Date.parse(e.at) > Date.now() - 6 * 3600000)) return <div className="banner crit">{e.message} Last failure {fmtRelative(e.at)}.</div>;
  return null;
}

export function LlmCostCard({ compact = false }: { compact?: boolean }) {
  const { data, error, setData } = useLlmUsage();
  const isAdmin = useIsAdmin();
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<string | null>(null);
  if (!data) return error ? <div className="banner crit">{error}</div> : null;
  const save = async (patch: Parameters<typeof api.llmSettings>[0]) => { setBusy(true); try { setData(await api.llmSettings(patch)); } finally { setBusy(false); } };
  const replyModel = data.feature_models.find((f) => f.feature === 'reply')?.model ?? '';
  const perMsg = data.reply_avg.per_model.find((m) => m.model === replyModel)?.cost_usd ?? null;
  const cheapest = [...data.reply_avg.per_model].sort((a, b) => a.cost_usd - b.cost_usd)[0];
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="page-head" style={{ marginBottom: 6 }}>
        <b>Claude cost</b>
        <span className="sub">{data.reply_avg.messages_7d ? `${data.reply_avg.messages_7d} replies read in 7 days · ${k(data.reply_avg.input ?? 0)} in / ${k(data.reply_avg.output ?? 0)} out tokens per message` : 'No replies read in the last 7 days; per-message figures use a typical 2.5k-token prompt'}</span>
      </div>
      <div className="kpis" style={{ marginBottom: 8 }}>
        <div className="kpi"><div className="v">{usd(data.today.cost_usd)}</div><div className="k">today · {data.today.calls} call{data.today.calls === 1 ? '' : 's'}</div></div>
        <div className="kpi"><div className="v">{usd(data.d7.cost_usd)}</div><div className="k">last 7 days</div></div>
        <div className="kpi"><div className="v">{usd(data.month.cost_usd)}</div><div className="k">this month so far</div></div>
        <div className="kpi"><div className="v">{usd(data.projected_month_usd)}</div><div className="k">projected month</div></div>
        <div className="kpi"><div className="v">{usd(perMsg, 4)}</div><div className="k">per reply on {data.models.find((m) => m.id === replyModel)?.label ?? replyModel}</div></div>
      </div>
      {compact ? (
        <div className="sub">Per reply by model: {data.reply_avg.per_model.map((m) => `${m.label} ${usd(m.cost_usd, 4)}`).join(' · ')}. {cheapest && cheapest.model !== replyModel ? `Switching replies to ${cheapest.label} would cost ${usd(cheapest.cost_usd, 4)} a message.` : ''} Models and the daily budget are under Settings › Connections › Claude.</div>
      ) : (
        <>
          <table>
            <thead><tr><th>Feature</th><th>Model</th><th>Per reply-sized call</th><th>This month</th><th>Calls</th></tr></thead>
            <tbody>{data.feature_models.map((f) => {
              const b = data.by_feature.find((x) => x.feature === f.feature);
              const m = data.reply_avg.per_model.find((x) => x.model === f.model);
              return (
                <tr key={f.feature}>
                  <td>{f.label}{f.auto ? <span className="badge muted" style={{ marginLeft: 6 }} title="Runs on its own; the daily budget stops it first">auto</span> : null}</td>
                  <td>{isAdmin ? <select value={f.model} disabled={busy} onChange={(e) => void save({ feature_models: { [f.feature]: e.target.value } })}>{data.models.map((m2) => <option key={m2.id} value={m2.id}>{m2.label} · ${m2.input}/{m2.output} per MTok</option>)}</select> : data.models.find((m2) => m2.id === f.model)?.label ?? f.model}</td>
                  <td className="sub">{m ? usd(m.cost_usd, 4) : '–'}</td>
                  <td>{b ? usd(b.cost_usd) : '–'}</td>
                  <td className="sub">{b ? `${b.ok}/${b.calls}` : '0'}</td>
                </tr>
              );
            })}</tbody>
          </table>
          <div className="inline-form" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <label className="field" style={{ width: 200 }}><span className="lbl">Daily budget (USD, 0 = none)</span><input type="number" min={0} step={0.5} value={budget ?? String(data.daily_budget_usd)} disabled={!isAdmin || busy} onChange={(e) => setBudget(e.target.value)} /><span className="help">When today's spend reaches it, automatic replies, scans and reads stop until tomorrow; buttons pressed by a person still work.</span></label>
            {isAdmin && <button className="small" disabled={busy || budget === null} onClick={() => { void save({ daily_budget_usd: Number(budget) }); setBudget(null); }}>Save budget</button>}
            <span className="sub">Prices: {data.models.map((m) => `${m.label} $${m.input} in / $${m.output} out per million tokens`).join(' · ')}.</span>
          </div>
          {data.by_model.length > 0 && <p className="sub" style={{ marginTop: 8 }}>This month by model: {data.by_model.map((m) => `${data.models.find((x) => x.id === m.model)?.label ?? m.model} ${usd(m.cost_usd)} (${k(m.input)} in, ${k(m.output)} out)`).join(' · ')}.</p>}
          {data.last_error && <p className="sub">Last failure: {data.last_error.message} ({data.last_error.feature}, {fmtRelative(data.last_error.at)}).</p>}
        </>
      )}
    </div>
  );
}
