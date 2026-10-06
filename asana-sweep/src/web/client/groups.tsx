import { useEffect, useState, type ReactNode } from 'react';

/**
 * Collapsible account blocks with a traffic light, the same shape on every Accounts tab:
 * a head row (light · name · one-line summary · numbers · badges · chevron) and a body that
 * opens on click. Which blocks are open is remembered per page in the browser.
 */
export type GroupLight = 'red' | 'amber' | 'green' | 'grey';
export const GROUP_LIGHT: Record<GroupLight, { cls: string; label: string }> = { red: { cls: 'crit', label: 'Needs someone' }, amber: { cls: 'warn', label: 'Watch' }, green: { cls: 'good', label: 'All clear' }, grey: { cls: 'muted', label: 'No data' } };

export function useOpenGroups(storageKey: string): { isOpen: (id: string | number) => boolean; toggle: (id: string | number) => void; setAll: (ids: (string | number)[], open: boolean) => void; count: number } {
  const [open, setOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem(`groups:${storageKey}`) ?? '{}') as Record<string, boolean>; } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem(`groups:${storageKey}`, JSON.stringify(open)); } catch { /* ignore */ } }, [open, storageKey]);
  return {
    isOpen: (id) => Boolean(open[String(id)]),
    toggle: (id) => setOpen((o) => ({ ...o, [String(id)]: !o[String(id)] })),
    setAll: (ids, value) => setOpen(value ? Object.fromEntries(ids.map((i) => [String(i), true])) : {}),
    count: Object.values(open).filter(Boolean).length,
  };
}

export function GroupsHead({ items, lights, open, onAll, children, noun = 'account' }: { items: number; lights: GroupLight[]; open: boolean; onAll: (open: boolean) => void; children?: ReactNode; noun?: string }) {
  const n = (l: GroupLight) => lights.filter((x) => x === l).length;
  return (
    <div className="page-head" style={{ marginBottom: 8 }}>
      <span className="sub">{items} {noun}{items === 1 ? '' : 's'} · <span className="light crit" /> {n('red')} · <span className="light warn" /> {n('amber')} · <span className="light good" /> {n('green')}{n('grey') ? <> · <span className="light muted" /> {n('grey')}</> : null}</span>
      <div className="actions">{children}<button className="small" onClick={() => onAll(!open)}>{open ? 'Collapse all' : 'Expand all'}</button></div>
    </div>
  );
}

export function AccountGroup({ light, name, sub, summary, nums, right, open, onToggle, children }: { light: GroupLight; name: string; sub?: string | null; summary?: ReactNode; nums?: ReactNode; right?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className={`area brand ${light}`}>
      <div className="head" onClick={onToggle} role="button" aria-expanded={open}>
        <span className={`light ${GROUP_LIGHT[light].cls}`} title={GROUP_LIGHT[light].label} />
        <b>{name}{sub ? <span className="sub"> {sub}</span> : null}</b>
        <span className="summary" title={typeof summary === 'string' ? summary : undefined}>{summary}</span>
        <span className="nums">{nums}</span>
        <span className="actions" style={{ alignItems: 'center' }}>{right}<span className="sub">{open ? '▾' : '▸'}</span></span>
      </div>
      {open && <div className="area-body">{children}</div>}
    </div>
  );
}

/** "Kijimea IT", "TBC (DE)", "Vaseline - FR" → the two-letter market at the end of a shop name. */
export function marketOf(name: string, fallback: string | null = null): string | null {
  const m = name.trim().match(/(?:^|[\s(\-_])([A-Z]{2})\)?(?:\s*\[[^\]]*\])?$/);
  return m ? (m[1] === 'GB' ? 'UK' : m[1]) : fallback;
}
