// Pure helpers for the lead sheet: CSV parsing, header mapping, stage rules. No Node-only imports.

export interface SheetLead {
  name: string;
  poc: string | null;
  stage: string | null;
  country: string | null;
  last_contact: string | null;
  notes: string | null;
  est_value: number | null;
  priority: string | null;
  sourced_by: string | null; // free text from an optional "Sourced By" column
  onboarding: string | null; // free text from an optional "Onboarding AM" column
  added_on: string | null; // from an optional "Date Added" column, normalised to YYYY-MM-DD
  row_no: number;
}

/** RFC 4180-ish CSV parser: quotes, escaped quotes, CRLF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const HEADERS: Record<keyof Omit<SheetLead, 'row_no'>, string[]> = {
  name: ['client name', 'client', 'company', 'brand', 'name', 'lead'],
  poc: ['poc', 'contact', 'point of contact', 'decision maker'],
  stage: ['stage', 'status'],
  country: ['country', 'market', 'region'],
  last_contact: ['last contact', 'last contacted', 'last touch'],
  notes: ['notes', 'note', 'comments', 'next step'],
  est_value: ['est value p m', 'est value', 'value p m', 'value', 'monthly value', 'deal value', 'est value pm'],
  priority: ['priorities', 'priority'],
  sourced_by: ['sourced by', 'source am', 'sourced', 'sourcer', 'originator'],
  onboarding: ['onboarding am', 'onboarding', 'am', 'account manager', 'owner'],
  added_on: ['date added', 'added on', 'added', 'created', 'date created', 'first contact'],
};

/** Find the header row (first row containing a "client name"-like cell) and map columns. */
export function mapHeaders(rows: string[][]): { headerIndex: number; columns: Partial<Record<keyof Omit<SheetLead, 'row_no'>, number>> } | null {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].map(norm);
    const nameIdx = cells.findIndex((c) => HEADERS.name.includes(c));
    if (nameIdx < 0) continue;
    const columns: Partial<Record<keyof Omit<SheetLead, 'row_no'>, number>> = {};
    for (const [field, aliases] of Object.entries(HEADERS) as [keyof Omit<SheetLead, 'row_no'>, string[]][]) {
      // Exact alias first, then a header that starts with the alias (e.g. "Est. Value P/M (GBP)").
      let idx = cells.findIndex((c) => aliases.includes(c));
      if (idx < 0) idx = cells.findIndex((c) => c && aliases.some((a) => a.length > 3 && c.startsWith(a)));
      if (idx >= 0 && !Object.values(columns).includes(idx)) columns[field] = idx;
    }
    return { headerIndex: i, columns };
  }
  return null;
}

export function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(cleaned);
  return cleaned && Number.isFinite(n) ? n : null;
}

const text = (s: string | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

/** Turn CSV text into lead rows. Rows without a client name are ignored (the sheet has summary cells off to the side). */
export function leadsFromCsv(csv: string): { leads: SheetLead[]; columns: string[] } {
  const rows = parseCsv(csv);
  const mapped = mapHeaders(rows);
  if (!mapped) throw new Error('Could not find a "Client Name" header in the sheet.');
  const { headerIndex, columns } = mapped;
  const leads: SheetLead[] = [];
  const seen = new Set<string>();
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = text(r[columns.name!]);
    if (!name) continue;
    const key = leadKey(name);
    if (seen.has(key)) continue; // duplicate names: first row wins
    seen.add(key);
    const at = (f: keyof typeof columns) => (columns[f] === undefined ? null : text(r[columns[f]!]));
    leads.push({
      name,
      poc: at('poc'),
      stage: at('stage'),
      country: at('country'),
      last_contact: at('last_contact'),
      notes: at('notes'),
      est_value: parseMoney(at('est_value')),
      priority: at('priority'),
      sourced_by: at('sourced_by'),
      onboarding: at('onboarding'),
      added_on: parseSheetDate(at('added_on')),
      row_no: i - headerIndex,
    });
  }
  return { leads, columns: Object.keys(columns) };
}

export const leadKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** A deal counts as signed when the stage says so. */
export function isSignedStage(stage: string | null | undefined): boolean {
  if (!stage) return false;
  return /signed|closed[\s-]*won|\bwon\b|onboard/i.test(stage);
}

/** Public CSV export of one tab. The sheet must be shared "Anyone with the link can view". */
export function sheetCsvUrl(sheetId: string, tab: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

/** Match a free-text name from the sheet to a team member ("Feds" -> Federica, "elena" -> Elena). */
export function matchPerson<T extends { id: number; name: string }>(value: string | null, people: T[]): T | null {
  if (!value) return null;
  const v = norm(value);
  if (!v) return null;
  const exact = people.find((p) => norm(p.name) === v);
  if (exact) return exact;
  const first = people.find((p) => norm(p.name).split(' ')[0] === v.split(' ')[0]);
  if (first) return first;
  const prefix = people.find((p) => norm(p.name).startsWith(v.slice(0, 3)) && v.length >= 3);
  return prefix ?? null;
}

/** Sheet dates come as 2026-09-16, 16/09/2026 (EU) or 09/16/2026; return YYYY-MM-DD or null. */
export function parseSheetDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (a > 12 && b <= 12) [a, b] = [b, a]; // clearly DD/MM
    // Default to day-first (the sheet is EU); a > 12 handled above, a <= 12 && b > 12 means MM/DD.
    const day = b > 12 ? b : a;
    const month = b > 12 ? a : b;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
