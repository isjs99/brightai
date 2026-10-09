import type { CrmLink } from '../../sweep/types';
import { api, fmtRelative } from './api';

/**
 * The label that says a BD prospect or Lead is also in Sofía's Airtable base, and the panel under it with
 * what her record says (stage, who has the ball, next step, last contact) and a link to open it there.
 * Links are read from the payload's `crm` map; nothing here creates rows.
 */

const best = (links: CrmLink[] | undefined): CrmLink | null => (links ?? []).find((l) => l.status === 'auto' || l.status === 'confirmed') ?? (links ?? []).find((l) => l.status === 'review') ?? null;

export function CrmBadge({ links }: { links: CrmLink[] | undefined }) {
  const l = best(links);
  if (!l) return null;
  const sure = l.status !== 'review';
  const text = sure ? `In Sofía's CRM` : `Sofía's CRM?`;
  const sub = [l.table === 'Deals' ? 'deal' : l.table === 'Accounts' ? 'account' : l.table === 'Target Intelligence' ? 'target' : l.table === 'Website Enquiries' ? 'enquiry' : l.table === 'Apollo Intake' ? 'Apollo intake' : l.table, l.stage].filter(Boolean).join(' · ');
  const title = (links ?? []).filter((x) => x.status !== 'rejected').map((x) => `${x.table}: ${x.primary ?? x.record_id}${x.stage ? ` (${x.stage})` : ''} — ${x.how}`).join('\n');
  return <a href={l.url} target="_blank" rel="noopener" className={`badge ${sure ? 'accent' : 'warn'}`} title={`${title}\nOpen in Airtable`} onClick={(e) => e.stopPropagation()}>{text}{sub ? <span style={{ opacity: 0.8 }}> · {sub}</span> : null}</a>;
}

export function CrmPanel({ links, isAdmin, onChange }: { links: CrmLink[] | undefined; isAdmin: boolean; onChange?: () => void }) {
  const shown = (links ?? []).filter((l) => l.status !== 'rejected');
  if (!shown.length) return null;
  const set = async (l: CrmLink, status: 'confirmed' | 'rejected') => { try { await api.airtableLink(l.id, status); onChange?.(); } catch { /* the page reloads on the live event */ } };
  return (
    <div className="card" style={{ margin: '0 0 12px', padding: '8px 12px' }}>
      <div className="sub" style={{ marginBottom: 4 }}><b>From Sofía's CRM</b> · the same company in her Airtable base. Her record is the place to edit; this is the read.</div>
      <table className="compact"><tbody>
        {shown.map((l) => (
          <tr key={l.id}>
            <td style={{ whiteSpace: 'nowrap' }}><span className="badge muted">{l.table}</span></td>
            <td><a href={l.url} target="_blank" rel="noopener"><b>{l.primary ?? l.record_id}</b> ↗</a>{l.status === 'review' && <span className="badge warn" style={{ marginLeft: 6 }} title={l.how}>maybe · {l.how}</span>}{l.status === 'confirmed' && <span className="badge good" style={{ marginLeft: 6 }}>confirmed</span>}</td>
            <td className="sub">{[l.stage, l.detail].filter(Boolean).join(' · ') || '–'}</td>
            <td className="sub">{l.owner ? `with ${l.owner}` : ''}</td>
            <td className="sub">{l.next_action ? `next: ${l.next_action}${l.next_action_date ? ` (${l.next_action_date})` : ''}` : ''}</td>
            <td className="sub">{l.last_contact ? `last contact ${l.last_contact}` : l.modified_at ? `edited ${fmtRelative(l.modified_at)}` : ''}</td>
            {isAdmin && <td style={{ whiteSpace: 'nowrap' }}>{l.status === 'review' && <button className="small" onClick={() => set(l, 'confirmed')}>Same company</button>} <button className="small" onClick={() => set(l, 'rejected')} title="Not the same company: the label goes and the matcher will not bring it back">{l.status === 'review' ? 'Not the same' : 'Unlink'}</button></td>}
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}
