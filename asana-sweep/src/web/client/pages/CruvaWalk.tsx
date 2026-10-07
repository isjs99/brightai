import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlaybookData, PlaybookDraft, PlaybookDraftStatus, PlaybookRollout, PlaybookWalkStep } from '../../../sweep/types';
import { api, fmtRelative, useLiveUpdates } from '../api';

/**
 * The walk: a rollout reviewed one step at a time per shop, in the order a creator meets the pieces. The shop's
 * language on the left is what gets sent; the English on the right is a faithful rendering so an AM who does not
 * read Italian can still judge it, and an edit on the right re-renders the left. Progress is kept per shop.
 */

const LANG: Record<string, string> = { en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish' };
const KIND_ONE: Record<PlaybookDraft['kind'], string> = { group: 'Group', automation: 'Bot', workflow: 'Workflow', email_campaign: 'Email', list: 'List', brief: 'Brief', sender: 'Sender', tag: 'Tag', manual: 'Hygiene' };
const ACTION: Record<PlaybookDraft['action'], string> = { create: 'Create in Cruva', update: 'Update the copy in Cruva', start: 'Start the paused one' };
const BADGE: Record<PlaybookDraftStatus, { cls: string; label: string }> = { ready: { cls: 'muted', label: 'to review' }, needs_input: { cls: 'warn', label: 'needs input' }, blocked: { cls: 'crit', label: 'blocked' }, approved: { cls: 'good', label: 'approved' }, skipped: { cls: 'muted', label: 'skipped' }, done: { cls: 'good', label: 'done' }, error: { cls: 'crit', label: 'failed' }, undone: { cls: 'muted', label: 'undone' } };

const summarise = (v: unknown): string => { if (!v || typeof v !== 'object') return String(v ?? ''); return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${Array.isArray(x) ? (x.length ? x.join(', ') : '–') : typeof x === 'object' && x ? summarise(x) : String(x)}`).join(' · '); };

export default function CruvaWalk({ id, shopId, data, isAdmin, onBack, onTable, onError }: { id: number; shopId: string | null; data: PlaybookData; isAdmin: boolean; onBack: () => void; onTable: () => void; onError: (e: string | null) => void }) {
  const [rollout, setRollout] = useState<PlaybookRollout | null>(null);
  const [drafts, setDrafts] = useState<PlaybookDraft[]>([]);
  const [steps, setSteps] = useState<PlaybookWalkStep[]>([]);
  const [walk, setWalk] = useState<Record<string, number>>({});
  const [shop, setShop] = useState<string | null>(shopId);
  const [index, setIndex] = useState<number | null>(null);
  const [copy, setCopy] = useState('');
  const [english, setEnglish] = useState<string | null>(null);
  const [englishEdit, setEnglishEdit] = useState('');
  const [englishFor, setEnglishFor] = useState<string>('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  const load = useCallback(() => api.playbookRollout(id).then((r) => { setRollout(r.rollout); setDrafts(r.drafts); setSteps(r.steps); setWalk(r.walk); }).catch((e) => onError((e as Error).message)), [id, onError]);
  useEffect(() => { load(); }, [load]);
  useLiveUpdates((e) => { if (e.kind === 'playbook') load(); });

  const stepIndex = useMemo(() => new Map(steps.map((s, i) => [s.key, i])), [steps]);
  const shops = useMemo(() => [...new Map(drafts.map((d) => [d.shop_id, d.shop_name])).entries()], [drafts]);
  useEffect(() => { if (!shop && shops.length) setShop(shops[0][0]); }, [shop, shops]);
  const mine = useMemo(() => drafts.filter((d) => d.shop_id === shop).sort((a, b) => (stepIndex.get(`${a.kind}:${a.key}`) ?? 1000) - (stepIndex.get(`${b.kind}:${b.key}`) ?? 1000) || a.order_no - b.order_no), [drafts, shop, stepIndex]);
  useEffect(() => { if (shop && index === null && rollout) setIndex(Math.min(walk[shop] ?? 0, mine.length)); }, [shop, walk, mine.length, index, rollout]);
  const cur = index !== null ? mine[index] ?? null : null;
  const stepInfo = cur ? steps[stepIndex.get(`${cur.kind}:${cur.key}`) ?? -1] ?? null : null;

  useEffect(() => { setCopy(cur?.copy ?? ''); setInstruction(''); }, [cur?.id, cur?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // English for the current draft, fetched once per copy version.
  useEffect(() => {
    if (!cur || !cur.copy) { setEnglish(null); setEnglishEdit(''); return; }
    const key = `${cur.id}:${cur.updated_at}`;
    if (englishFor === key) return;
    if (cur.language === 'en') { setEnglish(cur.copy); setEnglishEdit(cur.copy); setEnglishFor(key); return; }
    setEnglish('…'); setEnglishEdit('');
    api.playbookEnglish(cur.id).then((r) => { setEnglish(r.english); setEnglishEdit(r.english ?? ''); setEnglishFor(key); }).catch((e) => { setEnglish(`(translation failed: ${(e as Error).message})`); setEnglishFor(key); });
  }, [cur?.id, cur?.updated_at, cur?.copy, cur?.language, englishFor]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async <T,>(key: string, fn: () => Promise<T>, after?: (r: T) => void) => { setBusy(key); onError(null); try { const r = await fn(); after?.(r); await load(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); } };
  const go = (i: number) => { if (!shop) return; const n = Math.max(0, Math.min(i, mine.length)); setIndex(n); void api.playbookWalk(id, shop, n).catch(() => undefined); };
  const saveCopy = async () => { if (cur && copy !== (cur.copy ?? '')) await api.playbookDraftUpdate(cur.id, { copy }); };
  const approve = (start?: boolean) => run('approve', async () => { if (!cur) return; await saveCopy(); await api.playbookDraftUpdate(cur.id, { status: 'approved', ...(start !== undefined ? { start_after: start } : {}) }); }, () => go((index ?? 0) + 1));
  const skip = () => run('skip', async () => { if (cur) await api.playbookDraftUpdate(cur.id, { status: 'skipped' }); }, () => go((index ?? 0) + 1));
  const unskip = () => run('unskip', async () => { if (cur) await api.playbookDraftUpdate(cur.id, { status: 'ready' }); });
  const applyEnglish = () => run('english', async () => { if (cur) await api.playbookFromEnglish(cur.id, englishEdit); }, () => setNotice(`Rendered into ${LANG[cur?.language ?? ''] ?? cur?.language} from your English.`));

  if (!rollout) return <p className="sub">Loading rollout…</p>;
  const done = rollout.status === 'done' || rollout.status === 'undone';
  const counts = rollout.counts;
  const approvedHere = mine.filter((d) => d.status === 'approved').length;
  const openHere = mine.filter((d) => ['ready', 'needs_input', 'blocked'].includes(d.status)).length;
  const finished = index !== null && index >= mine.length;

  return (
    <>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="actions" style={{ alignItems: 'baseline' }}><a href="#back" onClick={(e) => { e.preventDefault(); onBack(); }}>← Cruva</a><h2 style={{ margin: 0 }}>{done ? `Rollout #${rollout.id}` : 'Prepare rollout'}</h2><span className="sub">{rollout.created_by ?? ''} {fmtRelative(rollout.created_at)} · <a href="#table" onClick={(e) => { e.preventDefault(); onTable(); }}>table view</a></span></div>
          <p className="hint" style={{ margin: '4px 0 0' }}>One piece at a time, in the order a creator meets them. Left is what goes to Cruva in the shop's language; right is the same in English. Nothing reaches Cruva until you roll out at the end.</p>
        </div>
        <div className="actions">
          {shops.length > 1 && <select value={shop ?? ''} onChange={(e) => { setShop(e.target.value); setIndex(null); }} style={{ width: 'auto' }}>{shops.map(([sid, name]) => <option key={sid} value={sid}>{name} · {walk[sid] ?? 0}/{drafts.filter((d) => d.shop_id === sid).length}</option>)}</select>}
          {counts.approved ? <span className="badge good">{counts.approved} approved</span> : null}
          {counts.needs_input ? <span className="badge warn">{counts.needs_input} need input</span> : null}
          {counts.blocked ? <span className="badge crit">{counts.blocked} blocked</span> : null}
          {counts.done ? <span className="badge good">{counts.done} done</span> : null}
        </div>
      </div>
      {notice && <div className="banner info">{notice}</div>}

      {mine.length === 0 ? <div className="empty">Nothing to draft for this shop: everything the library knows is already in place.</div> : (
        <div className="walk">
          <div className="walk-steps">
            {mine.map((d, i) => { const st = BADGE[d.status]; return <button key={d.id} className={`walk-step ${i === index ? 'cur' : ''} ${d.status}`} onClick={() => go(i)} title={`${d.name}: ${st.label}`}><span className="n">{i + 1}</span><span className="t">{d.name}</span><span className={`badge ${st.cls}`}>{st.label}</span></button>; })}
            <button className={`walk-step ${finished ? 'cur' : ''}`} onClick={() => go(mine.length)}><span className="n">✓</span><span className="t">Finish</span></button>
          </div>

          {finished ? (
            <div className="card walk-pane">
              <h3 style={{ marginTop: 0 }}>{shops.find(([sid]) => sid === shop)?.[1]}: walk done</h3>
              <p>{approvedHere} approved, {mine.filter((d) => d.status === 'skipped').length} skipped, {openHere} still open{mine.filter((d) => d.status === 'done').length ? `, ${mine.filter((d) => d.status === 'done').length} already in Cruva` : ''}.</p>
              {openHere > 0 && <p className="sub">Open ones are listed on the left; a blocked one needs something on the shop first (a sender email, a group) and can be skipped.</p>}
              {shops.length > 1 && <p className="sub">Other shops in this rollout: {shops.filter(([sid]) => sid !== shop).map(([sid, name]) => <a key={sid} href="#shop" onClick={(e) => { e.preventDefault(); setShop(sid); setIndex(null); }} style={{ marginRight: 8 }}>{name} ({walk[sid] ?? 0}/{drafts.filter((d) => d.shop_id === sid).length})</a>)}</p>}
              <div className="actions" style={{ marginTop: 10 }}>
                {isAdmin && !done && <button className="primary" disabled={busy !== null || !counts.approved || !data.mcp_configured} title={data.mcp_configured ? '' : 'CRUVA_API_KEY is not set'} onClick={() => { if (window.confirm(`Roll out ${counts.approved} approved draft(s) to Cruva now? Created bots stay paused unless you ticked "start after creating".`)) run('run', () => api.playbookRun(rollout.id), (r) => setNotice(`${r.done} created or updated${r.errors.length ? `, ${r.errors.length} failed: ${r.errors.join(' | ')}` : ''}.`)); }}>{busy === 'run' ? 'Rolling out…' : `Roll out ${counts.approved} approved to Cruva`}</button>}
                <button onClick={onBack}>Back to Cruva</button>
              </div>
            </div>
          ) : cur && (
            <div className="card walk-pane">
              <div className="walk-head">
                <div>
                  <div className="lbl">Step {(index ?? 0) + 1} of {mine.length} · {cur.shop_name} · {KIND_ONE[cur.kind]} · {ACTION[cur.action]}</div>
                  <h3 style={{ margin: '2px 0' }}>{stepInfo?.title ?? cur.name}</h3>
                  <div className="sub">{stepInfo?.why ?? cur.description}</div>
                </div>
                <div className="actions">
                  <span className={`badge ${BADGE[cur.status].cls}`}>{BADGE[cur.status].label}</span>
                  {cur.remote_name && <span className="badge muted" title={cur.remote_id ?? ''}>in Cruva: {cur.remote_name}</span>}
                </div>
              </div>
              {cur.blockers.length > 0 && <ul className="flaglist">{cur.blockers.map((b, i) => <li key={i} className={cur.status === 'blocked' ? 'crit' : 'warn'}><span>{b}</span></li>)}</ul>}
              {cur.result && <div className={`banner ${cur.status === 'error' ? 'crit' : 'info'}`} style={{ whiteSpace: 'pre-wrap' }}>{cur.result}</div>}

              <div className="walk-settings">
                {typeof cur.payload.outreach_audience === 'string' && <span><b>Audience</b> {String(cur.payload.outreach_audience)}{cur.payload.group_id ? ` · group ${String(cur.payload.group_id)}` : ''}</span>}
                {cur.payload.time_limits ? <span><b>Window</b> {String((cur.payload.time_limits as { start?: string }).start ?? '')} – {String((cur.payload.time_limits as { end?: string }).end ?? '')}</span> : null}
                {cur.payload.daily_limit !== undefined && <span><b>A day</b> {String(cur.payload.daily_limit)}</span>}
                {cur.payload.outreach_filters ? <span><b>Filters</b> {summarise(cur.payload.outreach_filters)}</span> : null}
                {cur.payload.filters ? <span><b>Filters</b> {summarise(cur.payload.filters)}</span> : null}
                {cur.payload.invite_details ? <span><b>Invite</b> {String((cur.payload.invite_details as { title?: string }).title ?? '')} · {((cur.payload.invite_details as { products?: unknown[] }).products ?? []).length} products</span> : null}
                {Array.isArray(cur.payload.sender_emails) ? <span><b>From</b> {(cur.payload.sender_emails as string[]).join(', ') || '–'}</span> : null}
              </div>

              {cur.copy !== null ? (
                <div className="walk-cols">
                  <div>
                    <div className="lbl">{LANG[cur.language] ?? cur.language} · what gets sent</div>
                    <textarea className="copy" value={copy} onChange={(e) => setCopy(e.target.value)} disabled={!isAdmin || done} />
                    {isAdmin && !done && <div className="inline-form" style={{ marginTop: 6 }}><input type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Steer a rewrite (shorter, mention the bundle…)" style={{ flex: 1, fontSize: 12 }} /><button className="small" disabled={busy !== null} onClick={() => run('rw', async () => { await saveCopy(); await api.playbookDraftRewrite(cur.id, instruction || null); })}>{busy === 'rw' ? 'Rewriting…' : 'Rewrite'}</button>{copy !== (cur.copy ?? '') && <button className="small" disabled={busy !== null} onClick={() => run('save', saveCopy)}>Save</button>}</div>}
                  </div>
                  <div>
                    <div className="lbl">English · the same, for review</div>
                    {cur.language === 'en' ? <div className="sub" style={{ padding: 8 }}>This shop writes in English: the left column is the message.</div> : (
                      <>
                        <textarea className="copy en" value={englishEdit} onChange={(e) => setEnglishEdit(e.target.value)} disabled={!isAdmin || done || english === '…'} placeholder={english ?? ''} />
                        {isAdmin && !done && englishEdit !== (english ?? '') && english !== '…' && <div className="inline-form" style={{ marginTop: 6 }}><button className="small primary" disabled={busy !== null} onClick={applyEnglish}>{busy === 'english' ? 'Rendering…' : `Apply: render the ${LANG[cur.language] ?? cur.language} from this`}</button><button className="small" onClick={() => setEnglishEdit(english ?? '')}>Discard</button></div>}
                      </>
                    )}
                  </div>
                </div>
              ) : <p className="sub">Nothing to write for this one: it is created with the settings above.</p>}

              <details open={showJson} onToggle={(e) => setShowJson((e.target as HTMLDetailsElement).open)}>
                <summary className="sub" style={{ cursor: 'pointer' }}>Exact payload sent to Cruva ({cur.tool})</summary>
                <pre className="json">{JSON.stringify(cur.payload, null, 2)}</pre>
              </details>

              <div className="actions walk-actions">
                <button className="small" disabled={(index ?? 0) === 0} onClick={() => go((index ?? 0) - 1)}>◂ Back</button>
                <span style={{ flex: 1 }} />
                {isAdmin && !done && (cur.status === 'skipped' ? <button className="small" disabled={busy !== null} onClick={unskip}>Un-skip</button> : <button className="small" disabled={busy !== null} onClick={skip}>Skip</button>)}
                {isAdmin && !done && cur.status !== 'approved' && cur.kind === 'automation' && cur.action !== 'start' && <button className="small" disabled={busy !== null || cur.status === 'blocked'} onClick={() => approve(true)}>Approve and start</button>}
                {isAdmin && !done && cur.status !== 'approved' && <button className="small primary" disabled={busy !== null || cur.status === 'blocked'} onClick={() => approve(cur.kind === 'automation' && cur.action !== 'start' ? false : undefined)}>{cur.kind === 'automation' && cur.action !== 'start' ? 'Approve (paused) · next ▸' : 'Approve · next ▸'}</button>}
                {(cur.status === 'approved' || !isAdmin || done) && <button className="small" onClick={() => go((index ?? 0) + 1)}>Next ▸</button>}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
